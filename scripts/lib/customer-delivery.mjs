import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { repositoryRoot } from '../validate-config.mjs';

const CHANNELS = new Set(['EMAIL', 'WHATSAPP']);
const DOCUMENTS = {
  quotation: {
    entityTable: 'quotations', issuanceTable: 'quotation_issuances', idColumn: 'quotation_id',
    numberColumn: 'quotation_number', outputDirectory: 'quotations', dateColumn: 'valid_until', dateLabel: 'Valid until'
  },
  invoice: {
    entityTable: 'invoices', issuanceTable: 'invoice_issuances', idColumn: 'invoice_id',
    numberColumn: 'invoice_number', outputDirectory: 'invoices', dateColumn: 'due_date', dateLabel: 'Payment due'
  }
};

function requiredText(value, name, maximum = 500) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  const result = value.trim();
  if (result.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(result)) throw new TypeError(`${name} is invalid.`);
  return result;
}

function isoInstant(value, name) {
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.valueOf()) || date.toISOString() !== value) throw new TypeError(`${name} must be an ISO-8601 UTC instant.`);
  return value;
}

function safePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

export function normalizeDeliveryChannel(value = 'EMAIL') {
  const channel = requiredText(value, 'channel', 20).toUpperCase();
  if (!CHANNELS.has(channel)) throw new TypeError('channel must be EMAIL or WHATSAPP.');
  return channel;
}

export function normalizeEmail(value) {
  const email = requiredText(value, 'email', 254).normalize('NFKC').toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || /[\r\n]/.test(email)) throw new TypeError('email is invalid.');
  return email;
}

export function normalizeWhatsApp(value) {
  const number = requiredText(value, 'WhatsApp number', 16).replaceAll(/[\s()-]/g, '');
  if (!/^\+[1-9][0-9]{7,14}$/.test(number)) throw new TypeError('WhatsApp number must use E.164 format.');
  return number;
}

export function maskDestination(channel, destination) {
  if (channel === 'EMAIL') {
    const [local, domain] = destination.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return `${destination.slice(0, Math.min(3, destination.length - 4))}***${destination.slice(-4)}`;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function requestHash(value) {
  return digest(JSON.stringify(stable(value)));
}

function audit(database, { now, actor, action, entityId, result = 'PASS', details = {} }) {
  database.prepare(`INSERT INTO audit_events
    (timestamp,actor,action,entity_type,entity_id,result,details_json)
    VALUES (?,?,?,'customer_delivery',?,?,?)`).run(now, actor, action, entityId ?? null, result, JSON.stringify(stable(details)));
}

function token() {
  return `DL-${randomBytes(8).toString('hex').toUpperCase()}`;
}

export function createDeliveryContact({ databasePath, contact, actor, now = new Date().toISOString() }) {
  const customerId = safePositiveInteger(contact?.customer_id, 'customer_id');
  const channel = normalizeDeliveryChannel(contact?.channel);
  const destination = channel === 'EMAIL' ? normalizeEmail(contact?.destination) : normalizeWhatsApp(contact?.destination);
  const contactName = contact?.contact_name == null ? null : requiredText(contact.contact_name, 'contact_name', 120);
  const verifiedAt = isoInstant(contact?.verified_at ?? now, 'verified_at');
  const verifiedBy = requiredText(actor, 'actor', 200);
  const consentAt = contact?.consent_at == null ? null : isoInstant(contact.consent_at, 'consent_at');
  const consentSource = contact?.consent_source == null ? null : requiredText(contact.consent_source, 'consent_source', 200);
  if (channel === 'WHATSAPP' && (!consentAt || !consentSource)) throw new Error('WHATSAPP_CONSENT_REQUIRED');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const customer = database.prepare('SELECT id,active FROM customers WHERE id=?').get(customerId);
      if (!customer || customer.active !== 1) throw new Error('ACTIVE_CUSTOMER_REQUIRED');
      const result = database.prepare(`INSERT INTO customer_delivery_contacts
        (customer_id,channel,destination,normalized_destination,contact_name,verified_at,verified_by,consent_at,consent_source,active,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`).run(customerId, channel, destination, destination, contactName, verifiedAt, verifiedBy, consentAt, consentSource, now, now);
      const id = Number(result.lastInsertRowid);
      audit(database, { now, actor: verifiedBy, action: 'customer_delivery.contact_created', entityId: id,
        details: { customerId, channel, verified: true, consentRecorded: channel === 'WHATSAPP' } });
      return { id, customerId, channel, destination: maskDestination(channel, destination), contactName, active: true, verifiedAt, consentRecorded: channel === 'WHATSAPP' };
    });
  } finally { database.close(); }
}

export function deactivateDeliveryContact({ databasePath, contactId, actor, now = new Date().toISOString() }) {
  safePositiveInteger(contactId, 'contactId'); isoInstant(now, 'now'); const user = requiredText(actor, 'actor', 200);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const contact = database.prepare('SELECT * FROM customer_delivery_contacts WHERE id=?').get(contactId);
      if (!contact || contact.active !== 1) throw new Error('ACTIVE_DELIVERY_CONTACT_NOT_FOUND');
      database.prepare('UPDATE customer_delivery_contacts SET active=0,updated_at=? WHERE id=?').run(now, contactId);
      audit(database, { now, actor: user, action: 'customer_delivery.contact_deactivated', entityId: contactId,
        details: { customerId: contact.customer_id, channel: contact.channel } });
      return { id: contactId, customerId: contact.customer_id, channel: contact.channel, destination: maskDestination(contact.channel, contact.destination), active: false };
    });
  } finally { database.close(); }
}

export function listDeliveryContacts({ databasePath, customerId, channel = null }) {
  safePositiveInteger(customerId, 'customerId');
  const normalizedChannel = channel == null ? null : normalizeDeliveryChannel(channel);
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    const rows = normalizedChannel
      ? database.prepare('SELECT * FROM customer_delivery_contacts WHERE customer_id=? AND channel=? ORDER BY id').all(customerId, normalizedChannel)
      : database.prepare('SELECT * FROM customer_delivery_contacts WHERE customer_id=? ORDER BY channel,id').all(customerId);
    return rows.map((row) => ({ id: row.id, customerId: row.customer_id, channel: row.channel,
      destination: maskDestination(row.channel, row.destination), contactName: row.contact_name, active: row.active === 1,
      verifiedAt: row.verified_at, consentRecorded: row.channel === 'WHATSAPP' && Boolean(row.consent_at) }));
  } finally { database.close(); }
}

function lookupDocument(database, documentType, documentNumber) {
  const definition = DOCUMENTS[documentType];
  if (!definition) throw new TypeError('documentType must be quotation or invoice.');
  const row = database.prepare(`SELECT e.id,e.${definition.numberColumn} AS document_number,e.status,e.customer_id,e.currency,
    e.total_minor,e.${definition.dateColumn} AS relevant_date,c.active AS customer_active,c.legal_name,c.display_name,
    i.status AS issuance_status,i.pdf_relative_path,i.pdf_sha256
    FROM ${definition.entityTable} e
    JOIN customers c ON c.id=e.customer_id
    JOIN ${definition.issuanceTable} i ON i.${definition.idColumn}=e.id
    WHERE e.${definition.numberColumn}=?`).get(documentNumber);
  if (!row || row.status !== 'ISSUED' || row.issuance_status !== 'ISSUED') throw new Error('DOCUMENT_NOT_ISSUED');
  if (row.customer_active !== 1) throw new Error('ACTIVE_CUSTOMER_REQUIRED');
  return { ...row, definition };
}

function selectContact(database, customerId, channel, contactId) {
  const rows = contactId == null
    ? database.prepare('SELECT * FROM customer_delivery_contacts WHERE customer_id=? AND channel=? AND active=1 ORDER BY id').all(customerId, channel)
    : database.prepare('SELECT * FROM customer_delivery_contacts WHERE id=? AND customer_id=? AND channel=? AND active=1').all(contactId, customerId, channel);
  if (rows.length === 0) throw new Error('VERIFIED_DELIVERY_CONTACT_NOT_FOUND');
  if (rows.length > 1) throw new Error('DELIVERY_CONTACT_SELECTION_REQUIRED');
  const contact = rows[0];
  if (!contact.verified_at || !contact.verified_by) throw new Error('VERIFIED_DELIVERY_CONTACT_NOT_FOUND');
  if (channel === 'WHATSAPP' && (!contact.consent_at || !contact.consent_source)) throw new Error('WHATSAPP_CONSENT_REQUIRED');
  return contact;
}

function formatAmount(currency, minor) {
  if (!Number.isSafeInteger(minor)) throw new Error('INVALID_LEDGER_TOTAL');
  const absolute = Math.abs(minor);
  return `${currency} ${minor < 0 ? '-' : ''}${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(absolute % 100).padStart(2, '0')}`;
}

function messageFor(document, contact, signature) {
  const typeLabel = document.documentType === 'quotation' ? 'Quotation' : 'Invoice';
  const greeting = contact.contact_name ? `Dear ${contact.contact_name},` : 'Hello,';
  const lines = [
    greeting,
    '',
    `Please find attached ${typeLabel.toLowerCase()} ${document.document_number} for your reference.`,
    `${typeLabel} total: ${formatAmount(document.currency, document.total_minor)}`,
    document.relevant_date ? `${document.definition.dateLabel}: ${document.relevant_date}` : null,
    '',
    'Regards,',
    ...signature
  ].filter((line) => line !== null);
  return {
    subject: `${typeLabel} ${document.document_number} — ${document.customer_name}`,
    body: lines.join('\n')
  };
}

async function verifiedArtifact({ root, documentType, relativePath, expectedSha256 }) {
  if (typeof relativePath !== 'string' || !relativePath || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) throw new Error('ISSUED_ARTIFACT_INVALID');
  const outputRoot = path.resolve(root, 'generated', DOCUMENTS[documentType].outputDirectory);
  const candidate = path.resolve(outputRoot, relativePath);
  const relative = path.relative(outputRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ISSUED_ARTIFACT_OUTSIDE_WORKSPACE');
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('ISSUED_ARTIFACT_INVALID');
  const [resolvedRoot, resolvedCandidate] = await Promise.all([realpath(outputRoot), realpath(candidate)]);
  const resolvedRelative = path.relative(resolvedRoot, resolvedCandidate);
  if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) throw new Error('ISSUED_ARTIFACT_OUTSIDE_WORKSPACE');
  const actualSha256 = digest(await readFile(resolvedCandidate));
  if (actualSha256 !== expectedSha256) throw new Error('ISSUED_ARTIFACT_HASH_MISMATCH');
  return { absolutePath: resolvedCandidate, relativePath: relative.split(path.sep).join('/'), sha256: actualSha256 };
}

export async function prepareCustomerDelivery({
  databasePath,
  documentType,
  documentNumber,
  channel = 'EMAIL',
  contactId = null,
  requestingUser,
  sourceChannel,
  sourceChat,
  sourceMessageReference = null,
  configuration,
  root = repositoryRoot,
  resendReason = null,
  now = new Date().toISOString(),
  tokenFactory = token
}) {
  isoInstant(now, 'now');
  if (!configuration?.enabled) throw new Error('CUSTOMER_DELIVERY_DISABLED');
  const normalizedType = requiredText(documentType, 'documentType', 20).toLowerCase();
  const number = requiredText(documentNumber, 'documentNumber', 80);
  const normalizedChannel = normalizeDeliveryChannel(channel);
  if (normalizedChannel === 'EMAIL' && !configuration.email?.enabled) throw new Error('EMAIL_DELIVERY_DISABLED');
  if (normalizedChannel === 'WHATSAPP' && !configuration.whatsApp?.enabled) throw new Error('WHATSAPP_DELIVERY_DISABLED');
  const user = requiredText(requestingUser, 'requestingUser', 200);
  const contextChannel = requiredText(sourceChannel, 'sourceChannel', 40);
  const contextChat = requiredText(sourceChat, 'sourceChat', 200);
  const database = openDatabase(databasePath);
  let document, contact;
  try {
    document = lookupDocument(database, normalizedType, number);
    document.documentType = normalizedType;
    document.customer_name = document.legal_name ?? document.display_name;
    contact = selectContact(database, document.customer_id, normalizedChannel, contactId);
  } finally { database.close(); }
  const artifact = await verifiedArtifact({ root, documentType: normalizedType, relativePath: document.pdf_relative_path, expectedSha256: document.pdf_sha256 });
  const message = messageFor(document, contact, configuration.signature);
  const snapshot = {
    documentType: normalizedType, documentId: document.id, documentNumber: document.document_number,
    customerId: document.customer_id, contactId: contact.id, channel: normalizedChannel,
    destination: contact.normalized_destination, verifiedAt: contact.verified_at, consentAt: contact.consent_at,
    artifactRelativePath: artifact.relativePath, artifactSha256: artifact.sha256,
    subject: message.subject, body: message.body
  };
  const hash = requestHash(snapshot);
  const expiresAt = new Date(new Date(now).valueOf() + configuration.confirmationTtlMinutes * 60_000).toISOString();
  const deliveryToken = requiredText(tokenFactory(), 'token', 80);
  const reason = resendReason == null ? null : requiredText(resendReason, 'resendReason', 500);
  const writeDatabase = openDatabase(databasePath);
  try {
    const created = withImmediateTransaction(writeDatabase, () => {
      const sent = writeDatabase.prepare(`SELECT id FROM customer_delivery_requests
        WHERE document_type=? AND document_id=? AND contact_id=? AND channel=? AND status='SENT' ORDER BY id DESC LIMIT 1`)
        .get(normalizedType, document.id, contact.id, normalizedChannel);
      if (sent && !reason) throw new Error('DELIVERY_ALREADY_SENT_REQUIRES_RESEND_REASON');
      const pending = writeDatabase.prepare(`SELECT id,token,expires_at FROM customer_delivery_requests
        WHERE document_type=? AND document_id=? AND contact_id=? AND channel=? AND request_hash=? AND status='PENDING'
        AND expires_at>? ORDER BY id DESC LIMIT 1`).get(normalizedType, document.id, contact.id, normalizedChannel, hash, now);
      if (pending) return { id: pending.id, token: pending.token, expiresAt: pending.expires_at, reused: true };
      const result = writeDatabase.prepare(`INSERT INTO customer_delivery_requests
        (token,document_type,document_id,document_number,customer_id,contact_id,channel,artifact_relative_path,artifact_sha256,request_hash,
         subject,body,requesting_user,source_channel,source_chat,source_message_reference,status,expires_at,resend_reason,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING',?,?,?,?)`).run(deliveryToken, normalizedType, document.id, document.document_number,
        document.customer_id, contact.id, normalizedChannel, artifact.relativePath, artifact.sha256, hash, message.subject, message.body,
        user, contextChannel, contextChat, sourceMessageReference, expiresAt, reason, now, now);
      const id = Number(result.lastInsertRowid);
      audit(writeDatabase, { now, actor: user, action: 'customer_delivery.requested', entityId: id,
        details: { documentType: normalizedType, documentId: document.id, contactId: contact.id, channel: normalizedChannel, resend: Boolean(reason) } });
      return { id, token: deliveryToken, expiresAt, reused: false };
    });
    return {
      requestId: created.id,
      token: created.token,
      expiresAt: created.expiresAt,
      reused: created.reused,
      documentType: normalizedType,
      documentNumber: document.document_number,
      customer: document.customer_name,
      channel: normalizedChannel,
      destination: maskDestination(normalizedChannel, contact.destination),
      amount: formatAmount(document.currency, document.total_minor),
      subject: normalizedChannel === 'EMAIL' ? message.subject : null,
      status: 'PENDING_CONFIRMATION'
    };
  } finally { writeDatabase.close(); }
}

function loadForConfirmation(database, tokenValue, context) {
  const row = database.prepare(`SELECT r.*,c.destination,c.normalized_destination,c.verified_at AS current_verified_at,
    c.consent_at AS current_consent_at,c.active AS contact_active,cu.active AS customer_active
    FROM customer_delivery_requests r
    JOIN customer_delivery_contacts c ON c.id=r.contact_id
    JOIN customers cu ON cu.id=r.customer_id
    WHERE r.token=?`).get(tokenValue);
  if (!row) throw new Error('DELIVERY_TOKEN_NOT_FOUND');
  if (row.status !== 'PENDING') throw new Error('DELIVERY_TOKEN_NOT_PENDING');
  if (new Date(row.expires_at).valueOf() <= new Date(context.now).valueOf()) {
    database.prepare("UPDATE customer_delivery_requests SET status='EXPIRED',updated_at=? WHERE id=?").run(context.now, row.id);
    return { expired: true, id: row.id };
  }
  if (row.requesting_user !== context.confirmingUser) throw new Error('DELIVERY_CONFIRMING_USER_MISMATCH');
  if (row.source_channel !== context.sourceChannel || row.source_chat !== context.sourceChat) throw new Error('DELIVERY_CONFIRMATION_CONTEXT_MISMATCH');
  if (row.contact_active !== 1 || row.customer_active !== 1) throw new Error('DELIVERY_CONTACT_NO_LONGER_ACTIVE');
  const snapshot = {
    documentType: row.document_type, documentId: row.document_id, documentNumber: row.document_number,
    customerId: row.customer_id, contactId: row.contact_id, channel: row.channel,
    destination: row.normalized_destination, verifiedAt: row.current_verified_at, consentAt: row.current_consent_at,
    artifactRelativePath: row.artifact_relative_path, artifactSha256: row.artifact_sha256,
    subject: row.subject, body: row.body
  };
  if (requestHash(snapshot) !== row.request_hash) throw new Error('DELIVERY_REQUEST_CHANGED');
  return row;
}

function errorCode(error, channel) {
  const value = typeof error?.code === 'string' ? error.code : error?.message;
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value)) return value;
  return channel === 'EMAIL' ? 'EMAIL_DELIVERY_FAILED' : 'WHATSAPP_DELIVERY_FAILED';
}

export async function confirmCustomerDelivery({
  databasePath,
  token: tokenValue,
  confirmingUser,
  sourceChannel,
  sourceChat,
  configuration,
  emailClient,
  whatsAppClient,
  root = repositoryRoot,
  now = new Date().toISOString()
}) {
  isoInstant(now, 'now');
  if (!configuration?.enabled) throw new Error('CUSTOMER_DELIVERY_DISABLED');
  const value = requiredText(tokenValue, 'token', 80);
  const user = requiredText(confirmingUser, 'confirmingUser', 200);
  const context = { confirmingUser: user, sourceChannel: requiredText(sourceChannel, 'sourceChannel', 40), sourceChat: requiredText(sourceChat, 'sourceChat', 200), now };
  const database = openDatabase(databasePath);
  let row;
  try {
    row = withImmediateTransaction(database, () => {
      const current = loadForConfirmation(database, value, context);
      if (current.expired) return current;
      const document = lookupDocument(database, current.document_type, current.document_number);
      if (document.id !== current.document_id || document.pdf_sha256 !== current.artifact_sha256 || document.pdf_relative_path.split(path.sep).join('/') !== current.artifact_relative_path) throw new Error('DELIVERY_DOCUMENT_CHANGED');
      database.prepare("UPDATE customer_delivery_requests SET status='SENDING',confirmed_by=?,confirmed_at=?,updated_at=? WHERE id=?")
        .run(user, now, now, current.id);
      audit(database, { now, actor: user, action: 'customer_delivery.confirmed', entityId: current.id,
        details: { documentType: current.document_type, documentId: current.document_id, contactId: current.contact_id, channel: current.channel } });
      return current;
    });
  } finally { database.close(); }
  if (row.expired) throw Object.assign(new Error('DELIVERY_TOKEN_EXPIRED'), { code: 'DELIVERY_TOKEN_EXPIRED' });
  let delivery;
  try {
    const artifact = await verifiedArtifact({ root, documentType: row.document_type, relativePath: row.artifact_relative_path, expectedSha256: row.artifact_sha256 });
    if (row.channel === 'EMAIL') {
      if (!configuration.email?.enabled || !emailClient) throw new Error('EMAIL_DELIVERY_DISABLED');
      delivery = await emailClient.send({ to: row.destination, subject: row.subject, body: row.body, attachmentPath: artifact.absolutePath });
    } else {
      if (!configuration.whatsApp?.enabled || !whatsAppClient) throw new Error('WHATSAPP_DELIVERY_DISABLED');
      delivery = await whatsAppClient.send({ to: row.destination, body: row.body, attachmentPath: artifact.absolutePath });
    }
  } catch (error) {
    const code = errorCode(error, row.channel);
    const failed = openDatabase(databasePath);
    try {
      withImmediateTransaction(failed, () => {
        failed.prepare("UPDATE customer_delivery_requests SET status='FAILED',last_error_code=?,updated_at=? WHERE id=? AND status='SENDING'").run(code, now, row.id);
        failed.prepare(`INSERT INTO customer_delivery_attempts
          (delivery_request_id,attempt_number,result,error_code,actor,occurred_at) VALUES (?,1,'FAILED',?,?,?)`).run(row.id, code, user, now);
        audit(failed, { now, actor: user, action: 'customer_delivery.failed', entityId: row.id, result: 'FAIL',
          details: { documentType: row.document_type, documentId: row.document_id, contactId: row.contact_id, channel: row.channel, errorCode: code } });
      });
    } finally { failed.close(); }
    const failure = new Error(`CUSTOMER_DELIVERY_FAILED (${code})`); failure.code = code; throw failure;
  }
  const providerReferenceHash = digest(requiredText(delivery?.providerReference, 'provider reference', 500));
  const succeeded = openDatabase(databasePath);
  try {
    withImmediateTransaction(succeeded, () => {
      const current = succeeded.prepare('SELECT status FROM customer_delivery_requests WHERE id=?').get(row.id);
      if (!current || current.status !== 'SENDING') throw new Error('DELIVERY_STATE_CHANGED_AFTER_SEND');
      succeeded.prepare("UPDATE customer_delivery_requests SET status='SENT',sent_at=?,updated_at=? WHERE id=?").run(now, now, row.id);
      succeeded.prepare(`INSERT INTO customer_delivery_attempts
        (delivery_request_id,attempt_number,result,provider_reference_hash,actor,occurred_at) VALUES (?,1,'SENT',?,?,?)`)
        .run(row.id, providerReferenceHash, user, now);
      audit(succeeded, { now, actor: user, action: 'customer_delivery.sent', entityId: row.id,
        details: { documentType: row.document_type, documentId: row.document_id, contactId: row.contact_id, channel: row.channel } });
    });
  } finally { succeeded.close(); }
  return { requestId: row.id, documentType: row.document_type, documentNumber: row.document_number, channel: row.channel,
    destination: maskDestination(row.channel, row.destination), status: 'SENT', sentAt: now };
}
