import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, withImmediateTransaction } from './database.mjs';

const DOCUMENT_PATTERN = /\b([0-9]{10}-[A-Z0-9]{1,16})\b/i;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const PHONE_PATTERN = /^\+[1-9][0-9]{7,14}$/;

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const iso = (value, name) => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError(`${name} must be an ISO-8601 UTC instant.`);
  return value;
};
const required = (value, name, maximum = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new TypeError(`${name} is invalid.`);
  return value.trim();
};
const token = (prefix) => `${prefix}-${randomBytes(8).toString('hex').toUpperCase()}`;
const safeJson = (value) => JSON.stringify(value);

function normalizeSender(channel, sender) {
  const value = required(sender, 'sender', 254);
  if (channel === 'EMAIL') {
    const match = /<([^<>]+)>/.exec(value);
    const address = (match?.[1] ?? value).trim().toLowerCase();
    if (!EMAIL_PATTERN.test(address)) throw new TypeError('sender is invalid.');
    return address;
  }
  const normalized = value.replace(/@s\.whatsapp\.net$/i, '').replace(/[^+0-9]/g, '');
  const e164 = normalized.startsWith('+') ? normalized : `+${normalized}`;
  if (!PHONE_PATTERN.test(e164)) throw new TypeError('sender is invalid.');
  return e164;
}

export function maskInboundSender(channel, sender) {
  if (channel === 'EMAIL') {
    const [local, domain] = sender.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return `${sender.slice(0, 3)}***${sender.slice(-4)}`;
}

export function sanitizeInboundBody(value, maximum = 8000) {
  const text = required(value, 'body', maximum * 2)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n');
  const lines = [];
  for (const line of text.split('\n')) {
    if (/^\s*>/.test(line) || /^\s*On .+ wrote:\s*$/i.test(line) || /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i.test(line)) break;
    lines.push(line.trimEnd());
  }
  const result = lines.join('\n').trim();
  if (!result || result.length > maximum) throw Object.assign(new Error('INBOUND_MESSAGE_SIZE_INVALID'), { code: 'INBOUND_MESSAGE_SIZE_INVALID' });
  return result;
}

function formatMoney(currency, minor) {
  if (!Number.isSafeInteger(minor)) throw new Error('INVALID_LEDGER_AMOUNT');
  return `${currency} ${(minor / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function findDocument(database, customerId, body) {
  const number = DOCUMENT_PATTERN.exec(body)?.[1]?.toUpperCase();
  if (!number) return null;
  const invoice = database.prepare(`SELECT id,invoice_number AS number,status,currency,total_minor,amount_paid_minor,balance_due_minor,payment_status,due_date
    FROM invoices WHERE customer_id=? AND upper(invoice_number)=?`).get(customerId, number);
  if (invoice) return { type: 'invoice', ...invoice };
  const quotation = database.prepare(`SELECT id,quotation_number AS number,status,currency,total_minor,valid_until
    FROM quotations WHERE customer_id=? AND upper(quotation_number)=?`).get(customerId, number);
  return quotation ? { type: 'quotation', ...quotation } : { type: null, number };
}

function classify(body, document, hasAttachments) {
  if (hasAttachments) return 'ATTACHMENT_REVIEW';
  if (!document?.type) return 'UNKNOWN';
  const lower = body.toLowerCase();
  if (document.type === 'invoice' && /\b(paid|payment|outstanding|balance|amount|due|status)\b/.test(lower)) return 'INVOICE_STATUS';
  if (document.type === 'quotation' && /\b(valid|validity|expire|expiry|amount|total|status|accept)\b/.test(lower)) return 'QUOTATION_STATUS';
  return 'UNKNOWN';
}

function knownResponse(document) {
  if (document.type === 'invoice') {
    return `Invoice ${document.number} is ${document.status}. Its total is ${formatMoney(document.currency, document.total_minor)}, recorded payment is ${formatMoney(document.currency, document.amount_paid_minor)}, and the outstanding balance is ${formatMoney(document.currency, document.balance_due_minor)}. Payment status: ${document.payment_status}. Due date: ${document.due_date}.`;
  }
  return `Quotation ${document.number} is ${document.status}. Its total is ${formatMoney(document.currency, document.total_minor)} and it is valid until ${document.valid_until}.`;
}

function audit(database, { now, actor, action, entityId, result, details }) {
  database.prepare(`INSERT INTO audit_events (timestamp,actor,action,entity_type,entity_id,result,details_json)
    VALUES (?,? ,?,'customer_inbound_message',?,?,?)`).run(now, actor, action, entityId, result, safeJson(details));
}

function contactFor(database, channel, sender) {
  return database.prepare(`SELECT dc.*,c.active AS customer_active FROM customer_delivery_contacts dc
    JOIN customers c ON c.id=dc.customer_id WHERE dc.channel=? AND dc.normalized_destination=? AND dc.active=1 AND c.active=1`).get(channel, sender);
}

function responseWithSignature(text, signature = []) {
  return [text, ...signature].filter(Boolean).join('\n\n');
}

function deliveryError(error, channel) {
  const code = error?.code ?? error?.message;
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(code ?? '') ? code : `${channel}_INBOUND_RESPONSE_FAILED`;
}

export async function processInboundCustomerMessage({
  databasePath, configuration, channel, sender, providerMessageId, providerThreadId = null, sessionKey = null,
  subject = null, body, receivedAt, hasAttachments = false, responseClient = null, escalationClient = null,
  deferredSourceReply = false, now = new Date().toISOString(), escalationTokenFactory = () => token('ES'), signature = []
}) {
  if (!configuration?.enabled) return { handled: false, status: 'DISABLED' };
  const normalizedChannel = required(channel, 'channel', 16).toUpperCase();
  if (!['EMAIL', 'WHATSAPP'].includes(normalizedChannel) || !configuration[normalizedChannel === 'EMAIL' ? 'email' : 'whatsApp']?.enabled) return { handled: false, status: 'CHANNEL_DISABLED' };
  const normalizedSender = normalizeSender(normalizedChannel, sender);
  const messageId = required(providerMessageId, 'providerMessageId', 500);
  const received = iso(receivedAt, 'receivedAt');
  const cleanBody = sanitizeInboundBody(body, configuration.maxMessageCharacters);
  const database = openDatabase(databasePath);
  let created;
  try {
    const contact = contactFor(database, normalizedChannel, normalizedSender);
    if (!contact) return { handled: false, status: 'UNVERIFIED_SENDER' };
    const providerHash = digest(`${normalizedChannel}:${messageId}`);
    const duplicate = database.prepare('SELECT id,status,response_text FROM customer_inbound_messages WHERE channel=? AND provider_message_hash=?').get(normalizedChannel, providerHash);
    if (duplicate) return { handled: true, duplicate: true, messageId: duplicate.id, status: duplicate.status, responseText: duplicate.response_text };
    const document = findDocument(database, contact.customer_id, cleanBody);
    const intent = classify(cleanBody, document, hasAttachments);
    const known = intent === 'INVOICE_STATUS' || intent === 'QUOTATION_STATUS';
    const responseText = responseWithSignature(known ? knownResponse(document) : 'Thank you. I have asked Ray to review your message and will follow up.', signature);
    const initialStatus = known ? 'RECEIVED' : 'ESCALATED';
    created = withImmediateTransaction(database, () => {
      const id = Number(database.prepare(`INSERT INTO customer_inbound_messages
        (channel,provider_message_hash,provider_message_id,provider_thread_hash,provider_thread_id,session_key_hash,customer_id,contact_id,sender,subject,body,body_sha256,received_at,intent,document_type,document_id,status,response_text,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        normalizedChannel, providerHash, messageId, providerThreadId ? digest(`${normalizedChannel}:${providerThreadId}`) : null, providerThreadId,
        sessionKey ? digest(sessionKey) : null, contact.customer_id, contact.id, normalizedSender, subject?.slice(0, 500) ?? null, cleanBody,
        digest(cleanBody), received, intent, document?.type ?? null, document?.id ?? null, initialStatus, responseText, now, now
      ).lastInsertRowid);
      let escalation = null;
      if (!known) {
        const escalationToken = escalationTokenFactory();
        const escalationId = Number(database.prepare(`INSERT INTO customer_reply_escalations
          (token,inbound_message_id,status,created_at,updated_at) VALUES (?,?,'OPEN',?,?)`).run(escalationToken, id, now, now).lastInsertRowid);
        escalation = { id: escalationId, token: escalationToken };
      }
      audit(database, { now, actor: `customer:${digest(normalizedSender).slice(0, 24)}`, action: known ? 'customer_inbound.known' : 'customer_inbound.escalated', entityId: id,
        result: 'PASS', details: { channel: normalizedChannel, contactId: contact.id, customerId: contact.customer_id, intent, documentType: document?.type ?? null, documentId: document?.id ?? null } });
      return { id, contact, document, intent, known, responseText, escalation };
    });
  } finally { database.close(); }

  if (created.escalation && escalationClient) {
    const excerpt = cleanBody.replace(/\s+/g, ' ').slice(0, 280);
    try {
      await escalationClient.notify({ body: `Customer reply needs review. Token ${created.escalation.token}. Channel ${normalizedChannel}. Contact ${maskInboundSender(normalizedChannel, normalizedSender)}.${created.document?.number ? ` Document ${created.document.number}.` : ''} Message: ${excerpt}` });
    } catch {
      const failed = openDatabase(databasePath);
      try { failed.prepare('UPDATE customer_reply_escalations SET last_error_code=?,updated_at=? WHERE id=?')
        .run('RC_FINANCE_NOTIFICATION_FAILED', now, created.escalation.id); } finally { failed.close(); }
    }
  }
  if (deferredSourceReply) return { handled: true, messageId: created.id, status: created.known ? 'REPLY_PENDING_DELIVERY' : 'ESCALATED', responseText: created.responseText, escalationToken: created.escalation?.token ?? null };
  if (!responseClient || !configuration.autoReply) return { handled: true, messageId: created.id, status: created.known ? 'REPLY_PREPARED' : 'ESCALATED', escalationToken: created.escalation?.token ?? null };
  try {
    const sent = await responseClient.reply({ to: normalizedSender, subject, body: created.responseText, inReplyTo: messageId, threadId: providerThreadId });
    recordInboundResponseDelivery({ databasePath, inboundMessageId: created.id, success: true, providerReference: sent.providerReference, now });
    return { handled: true, messageId: created.id, status: created.known ? 'AUTO_REPLIED' : 'ESCALATED', escalationToken: created.escalation?.token ?? null };
  } catch (error) {
    recordInboundResponseDelivery({ databasePath, inboundMessageId: created.id, success: false, errorCode: deliveryError(error, normalizedChannel), now });
    throw error;
  }
}

export function recordInboundResponseDelivery({ databasePath, inboundMessageId, success, providerReference = null, errorCode = null, now = new Date().toISOString() }) {
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const row = database.prepare('SELECT * FROM customer_inbound_messages WHERE id=?').get(inboundMessageId);
      if (!row) throw new Error('INBOUND_MESSAGE_NOT_FOUND');
      const kind = row.intent === 'UNKNOWN' || row.intent === 'ATTACHMENT_REVIEW' ? 'ACKNOWLEDGEMENT' : 'AUTOMATIC';
      database.prepare(`INSERT INTO customer_inbound_response_attempts
        (inbound_message_id,response_kind,result,response_sha256,provider_reference_hash,error_code,actor,occurred_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(row.id, kind, success ? 'SENT' : 'FAILED', digest(row.response_text), providerReference ? digest(providerReference) : null,
        errorCode, 'mira-f17b', now);
      if (row.status === 'RECEIVED') database.prepare('UPDATE customer_inbound_messages SET status=?,error_code=?,updated_at=? WHERE id=?')
        .run(success ? 'AUTO_REPLIED' : 'FAILED', errorCode, now, row.id);
      return { messageId: row.id, status: success ? 'SENT' : 'FAILED' };
    });
  } finally { database.close(); }
}

export function recordDeferredResponseBySession({ databasePath, channel, sessionKey, content, success, providerReference = null, now = new Date().toISOString() }) {
  if (!sessionKey) return { matched: false };
  const database = openDatabase(databasePath);
  try {
    const row = database.prepare(`SELECT id,response_text FROM customer_inbound_messages
      WHERE channel=? AND session_key_hash=? AND response_text=? AND NOT EXISTS
      (SELECT 1 FROM customer_inbound_response_attempts a WHERE a.inbound_message_id=customer_inbound_messages.id)
      ORDER BY id DESC LIMIT 1`).get(channel.toUpperCase(), digest(sessionKey), content);
    if (!row) return { matched: false };
    return { matched: true, ...recordInboundResponseDelivery({ databasePath, inboundMessageId: row.id, success, providerReference,
      errorCode: success ? null : `${channel.toUpperCase()}_SOURCE_REPLY_FAILED`, now }) };
  } finally { database.close(); }
}

export function prepareEscalationReply({ databasePath, token: escalationToken, response, requestingUser, sourceChannel, sourceChat,
  now = new Date().toISOString(), confirmationTtlMinutes = 15, confirmationTokenFactory = () => token('RR'), signature = [] }) {
  const answer = responseWithSignature(required(response, 'response', 4000), signature);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const row = database.prepare(`SELECT e.*,m.channel,m.sender,m.subject FROM customer_reply_escalations e
        JOIN customer_inbound_messages m ON m.id=e.inbound_message_id WHERE e.token=?`).get(required(escalationToken, 'token', 32));
      if (!row || !['OPEN', 'FAILED', 'EXPIRED'].includes(row.status)) throw new Error('ESCALATION_NOT_OPEN');
      const confirmToken = confirmationTokenFactory();
      const expiresAt = new Date(Date.parse(now) + confirmationTtlMinutes * 60000).toISOString();
      database.prepare(`UPDATE customer_reply_escalations SET status='PENDING_CONFIRMATION',proposed_response=?,proposal_hash=?,requesting_user=?,source_channel=?,source_chat=?,confirmation_token=?,confirmation_expires_at=?,last_error_code=NULL,updated_at=? WHERE id=?`)
        .run(answer, digest(answer), required(requestingUser, 'requestingUser'), required(sourceChannel, 'sourceChannel'), required(sourceChat, 'sourceChat'), confirmToken, expiresAt, now, row.id);
      return { status: 'PENDING_CONFIRMATION', escalationToken: row.token, confirmationToken: confirmToken, channel: row.channel,
        destination: maskInboundSender(row.channel, row.sender), response: answer, expiresAt };
    });
  } finally { database.close(); }
}

export async function confirmEscalationReply({ databasePath, confirmationToken, confirmingUser, sourceChannel, sourceChat,
  emailClient = null, whatsAppClient = null, now = new Date().toISOString() }) {
  const database = openDatabase(databasePath);
  let row;
  try {
    row = withImmediateTransaction(database, () => {
      const value = database.prepare(`SELECT e.*,m.channel,m.sender,m.subject,m.provider_message_id,m.provider_thread_id,m.id AS message_id,c.active AS contact_active
        FROM customer_reply_escalations e JOIN customer_inbound_messages m ON m.id=e.inbound_message_id
        JOIN customer_delivery_contacts c ON c.id=m.contact_id WHERE e.confirmation_token=?`).get(required(confirmationToken, 'confirmationToken', 32));
      if (!value || value.status !== 'PENDING_CONFIRMATION') throw new Error('REPLY_CONFIRMATION_INVALID');
      if (value.requesting_user !== confirmingUser || value.source_channel !== sourceChannel || value.source_chat !== sourceChat) throw new Error('REPLY_CONFIRMATION_CONTEXT_MISMATCH');
      if (value.confirmation_expires_at <= now) { database.prepare("UPDATE customer_reply_escalations SET status='EXPIRED',updated_at=? WHERE id=?").run(now, value.id); throw new Error('REPLY_CONFIRMATION_EXPIRED'); }
      if (!value.contact_active || digest(value.proposed_response) !== value.proposal_hash) throw new Error('REPLY_CONFIRMATION_INVALIDATED');
      database.prepare("UPDATE customer_reply_escalations SET status='SENDING',resolved_by=?,updated_at=? WHERE id=?").run(confirmingUser, now, value.id);
      return value;
    });
  } finally { database.close(); }
  const client = row.channel === 'EMAIL' ? emailClient : whatsAppClient;
  if (!client) throw new Error(`${row.channel}_REPLY_DISABLED`);
  try {
    const sent = await client.reply({ to: row.sender, subject: row.subject, body: row.proposed_response, inReplyTo: row.provider_message_id, threadId: row.provider_thread_id });
    const completed = openDatabase(databasePath);
    try { withImmediateTransaction(completed, () => {
      completed.prepare("UPDATE customer_reply_escalations SET status='RESOLVED',resolved_at=?,updated_at=? WHERE id=?").run(now, now, row.id);
      completed.prepare(`INSERT INTO customer_inbound_response_attempts
        (inbound_message_id,escalation_id,response_kind,result,response_sha256,provider_reference_hash,actor,occurred_at)
        VALUES (?,?,'RAY_APPROVED','SENT',?,?,?,?)`).run(row.message_id, row.id, digest(row.proposed_response), digest(sent.providerReference), confirmingUser, now);
    }); } finally { completed.close(); }
    return { status: 'RESOLVED', escalationToken: row.token, channel: row.channel, destination: maskInboundSender(row.channel, row.sender) };
  } catch (error) {
    const failed = openDatabase(databasePath); const code = deliveryError(error, row.channel);
    try { withImmediateTransaction(failed, () => {
      failed.prepare("UPDATE customer_reply_escalations SET status='FAILED',last_error_code=?,updated_at=? WHERE id=?").run(code, now, row.id);
      failed.prepare(`INSERT INTO customer_inbound_response_attempts
        (inbound_message_id,escalation_id,response_kind,result,response_sha256,error_code,actor,occurred_at)
        VALUES (?,?,'RAY_APPROVED','FAILED',?,?,?,?)`).run(row.message_id, row.id, digest(row.proposed_response), code, confirmingUser, now);
    }); } finally { failed.close(); }
    throw Object.assign(new Error('CUSTOMER_REPLY_FAILED'), { code });
  }
}
