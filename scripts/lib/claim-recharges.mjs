import { randomBytes } from 'node:crypto';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { canonicalJson } from './quotation-drafts.mjs';
import { addClaimRechargeLinesInTransaction } from './invoice-drafts.mjs';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}
function optional(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function positiveId(value, name) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer.`);
  return result;
}
function instant(value) {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new TypeError('now must be an ISO-8601 UTC instant.');
  return parsed;
}
function token() {
  const bytes = randomBytes(10);
  return `CR-${[...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('')}`;
}
function event(database, { rechargeId, fromStatus, toStatus, actor, now, details = {} }) {
  database.prepare(`INSERT INTO claim_recharge_events
    (claim_recharge_id,from_status,to_status,actor,details_json,occurred_at) VALUES (?,?,?,?,?,?)`)
    .run(rechargeId, fromStatus, toStatus, actor, canonicalJson(details), now);
}
function audit(database, { now, actor, action, entityId, details = {} }) {
  database.prepare(`INSERT INTO audit_events
    (timestamp,actor,action,entity_type,entity_id,result,details_json)
    VALUES (?,?,?,'claim_recharge',?,'PASS',?)`).run(now, actor, action, entityId, canonicalJson(details));
}

export function assignClaimRecharge({
  databasePath, claimId, customerId, projectReference = null, description,
  amountMinor = null, actor, now = new Date().toISOString()
}) {
  required(actor, 'actor'); instant(now);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const claim = database.prepare("SELECT * FROM claims WHERE id=? AND status='FILED'").get(positiveId(claimId, 'claim_id'));
      if (!claim) throw new Error('RECHARGE_REQUIRES_FILED_CLAIM');
      const customer = database.prepare('SELECT * FROM customers WHERE id=? AND active=1').get(positiveId(customerId, 'customer_id'));
      if (!customer) throw new Error('RECHARGE_CUSTOMER_NOT_FOUND_OR_INACTIVE');
      if (customer.default_currency && customer.default_currency !== claim.currency) throw new Error('RECHARGE_CUSTOMER_CURRENCY_MISMATCH');
      const amount = amountMinor == null ? claim.total_minor : Number(amountMinor);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > claim.total_minor) throw new Error('RECHARGE_AMOUNT_INVALID');
      const result = database.prepare(`INSERT INTO claim_recharges
        (claim_id,customer_id,project_reference,description,currency,amount_minor,status,requested_by,created_at)
        VALUES (?,?,?,?,?,?,'PENDING',?,?)`).run(
        claim.id, customer.id, optional(projectReference), required(description, 'description'),
        claim.currency, amount, actor, now
      );
      const rechargeId = Number(result.lastInsertRowid);
      event(database, { rechargeId, fromStatus: null, toStatus: 'PENDING', actor, now, details: { claimId: claim.id, customerId: customer.id } });
      audit(database, { now, actor, action: 'claim_recharge.assigned', entityId: rechargeId, details: { claimId: claim.id, customerId: customer.id, currency: claim.currency, amountMinor: amount } });
      return database.prepare('SELECT * FROM claim_recharges WHERE id=?').get(rechargeId);
    });
  } finally { database.close(); }
}

export function approveClaimRecharge({ databasePath, rechargeId, approvingUser, authorisedUser, now = new Date().toISOString() }) {
  if (required(approvingUser, 'approving_user') !== required(authorisedUser, 'authorised_user')) throw new Error('RECHARGE_APPROVAL_UNAUTHORISED');
  instant(now);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const recharge = database.prepare('SELECT * FROM claim_recharges WHERE id=?').get(positiveId(rechargeId, 'recharge_id'));
      if (!recharge || recharge.status !== 'PENDING') throw new Error('RECHARGE_NOT_PENDING');
      database.prepare("UPDATE claim_recharges SET status='APPROVED',approved_by=?,approved_at=? WHERE id=?").run(approvingUser, now, recharge.id);
      event(database, { rechargeId: recharge.id, fromStatus: 'PENDING', toStatus: 'APPROVED', actor: approvingUser, now });
      audit(database, { now, actor: approvingUser, action: 'claim_recharge.approved', entityId: recharge.id });
      return database.prepare('SELECT * FROM claim_recharges WHERE id=?').get(recharge.id);
    });
  } finally { database.close(); }
}

export function excludeClaimRecharge({ databasePath, rechargeId, actor, reason, now = new Date().toISOString() }) {
  required(actor, 'actor'); instant(now);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const recharge = database.prepare('SELECT * FROM claim_recharges WHERE id=?').get(positiveId(rechargeId, 'recharge_id'));
      if (!recharge || !['PENDING', 'APPROVED'].includes(recharge.status)) throw new Error('RECHARGE_NOT_EXCLUDABLE');
      database.prepare("UPDATE claim_recharges SET status='EXCLUDED',excluded_at=? WHERE id=?").run(now, recharge.id);
      event(database, { rechargeId: recharge.id, fromStatus: recharge.status, toStatus: 'EXCLUDED', actor, now, details: { reason: required(reason, 'reason') } });
      audit(database, { now, actor, action: 'claim_recharge.excluded', entityId: recharge.id });
      return database.prepare('SELECT * FROM claim_recharges WHERE id=?').get(recharge.id);
    });
  } finally { database.close(); }
}

export function requestRechargeInvoiceConfirmation({
  databasePath, invoiceId, rechargeIds, requestingUser, authorisedUser,
  sourceChannel, sourceChat, sourceMessageReference = null, ttlMinutes = 15,
  now = new Date().toISOString(), tokenFactory = token
}) {
  if (required(requestingUser, 'requesting_user') !== required(authorisedUser, 'authorised_user')) throw new Error('RECHARGE_INCLUSION_UNAUTHORISED');
  const current = instant(now);
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) throw new TypeError('ttlMinutes must be 1-1440.');
  const ids = [...new Set((rechargeIds ?? []).map((id) => positiveId(id, 'recharge_id')))].sort((a, b) => a - b);
  if (!ids.length) throw new TypeError('At least one recharge ID is required.');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const invoice = database.prepare(`SELECT i.id,i.status,i.customer_id,i.currency,s.draft_hash,s.snapshot_json
        FROM invoices i JOIN invoice_draft_state s ON s.invoice_id=i.id WHERE i.id=?`).get(positiveId(invoiceId, 'invoice_id'));
      if (!invoice || !['DRAFT', 'PENDING_CONFIRMATION'].includes(invoice.status)) throw new Error('RECHARGE_TARGET_INVOICE_NOT_EDITABLE');
      const recharges = database.prepare(`SELECT * FROM claim_recharges WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
      if (recharges.length !== ids.length || recharges.some((item) => item.status !== 'APPROVED')) throw new Error('RECHARGE_NOT_APPROVED');
      if (recharges.some((item) => item.customer_id !== invoice.customer_id || item.currency !== invoice.currency)) throw new Error('RECHARGE_INVOICE_CUSTOMER_OR_CURRENCY_MISMATCH');
      if (database.prepare(`SELECT COUNT(*) AS count FROM claim_invoice_links WHERE claim_recharge_id IN (${ids.map(() => '?').join(',')})`).get(...ids).count) throw new Error('RECHARGE_ALREADY_LINKED');
      const draft = JSON.parse(invoice.snapshot_json);
      if (draft.lineItems.length + ids.length > 7) throw new Error('RECHARGE_LINE_ITEM_LIMIT_EXCEEDED');
      database.prepare("UPDATE claim_recharge_confirmations SET status='INVALIDATED' WHERE invoice_id=? AND status='PENDING'").run(invoice.id);
      const confirmationToken = tokenFactory();
      if (!/^CR-[A-Z2-9]{10}$/.test(confirmationToken)) throw new TypeError('tokenFactory returned an invalid recharge token.');
      const expiresAt = new Date(current.valueOf() + ttlMinutes * 60_000).toISOString();
      database.prepare(`INSERT INTO claim_recharge_confirmations
        (token,invoice_id,invoice_draft_hash,recharge_ids_json,requesting_user,source_channel,source_chat,
         source_message_reference,status,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,'PENDING',?,?)`).run(
        confirmationToken, invoice.id, invoice.draft_hash, canonicalJson(ids), requestingUser,
        required(sourceChannel, 'source_channel'), required(sourceChat, 'source_chat'), optional(sourceMessageReference),
        expiresAt, now
      );
      audit(database, { now, actor: requestingUser, action: 'claim_recharge.invoice_inclusion_requested', entityId: invoice.id, details: { rechargeIds: ids } });
      return { token: confirmationToken, invoiceId: invoice.id, rechargeIds: ids, expiresAt, invoiceDraftHash: invoice.draft_hash };
    });
  } finally { database.close(); }
}

export function confirmRechargeInvoiceInclusion({
  databasePath, token: confirmationToken, confirmingUser, authorisedUser,
  sourceChannel, sourceChat, now = new Date().toISOString()
}) {
  if (required(confirmingUser, 'confirming_user') !== required(authorisedUser, 'authorised_user')) throw new Error('RECHARGE_INCLUSION_UNAUTHORISED');
  const current = instant(now);
  const database = openDatabase(databasePath);
  let result;
  try {
    result = withImmediateTransaction(database, () => {
      const confirmation = database.prepare('SELECT * FROM claim_recharge_confirmations WHERE token=?').get(required(confirmationToken, 'token'));
      if (!confirmation || confirmation.status !== 'PENDING') throw new Error('RECHARGE_CONFIRMATION_INVALID');
      if (confirmation.requesting_user !== confirmingUser) throw new Error('RECHARGE_CONFIRMATION_WRONG_USER');
      if (confirmation.source_channel !== sourceChannel || confirmation.source_chat !== sourceChat) throw new Error('RECHARGE_CONFIRMATION_CONTEXT_MISMATCH');
      if (current.valueOf() >= new Date(confirmation.expires_at).valueOf()) {
        database.prepare("UPDATE claim_recharge_confirmations SET status='EXPIRED' WHERE id=?").run(confirmation.id);
        return { errorCode: 'RECHARGE_CONFIRMATION_EXPIRED' };
      }
      const invoice = database.prepare(`SELECT i.customer_id,i.currency,s.draft_hash
        FROM invoices i JOIN invoice_draft_state s ON s.invoice_id=i.id WHERE i.id=?`).get(confirmation.invoice_id);
      if (!invoice || invoice.draft_hash !== confirmation.invoice_draft_hash) throw new Error('RECHARGE_INVOICE_DRAFT_CHANGED');
      const ids = JSON.parse(confirmation.recharge_ids_json);
      const recharges = database.prepare(`SELECT * FROM claim_recharges WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
      if (recharges.length !== ids.length || recharges.some((item) => item.status !== 'APPROVED')) throw new Error('RECHARGE_NOT_APPROVED');
      if (recharges.some((item) => item.customer_id !== invoice.customer_id || item.currency !== invoice.currency)) throw new Error('RECHARGE_INVOICE_CUSTOMER_OR_CURRENCY_MISMATCH');
      const added = addClaimRechargeLinesInTransaction(database, {
        invoiceId: confirmation.invoice_id,
        recharges: recharges.map((item) => ({ id: item.id, amountMinor: item.amount_minor, description: item.description })),
        actor: confirmingUser, now
      });
      for (const link of added.links) {
        const recharge = recharges.find((item) => item.id === link.rechargeId);
        database.prepare(`INSERT INTO claim_invoice_links
          (claim_recharge_id,claim_id,invoice_id,invoice_line_item_id,currency,amount_minor,confirmation_id,created_by,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(
          recharge.id, recharge.claim_id, confirmation.invoice_id, link.invoiceLineItemId, recharge.currency,
          recharge.amount_minor, confirmation.id, confirmingUser, now
        );
        event(database, { rechargeId: recharge.id, fromStatus: 'APPROVED', toStatus: 'APPROVED', actor: confirmingUser, now, details: { invoiceId: confirmation.invoice_id, invoiceLineItemId: link.invoiceLineItemId } });
      }
      database.prepare("UPDATE claim_recharge_confirmations SET status='CONFIRMED',confirmed_at=? WHERE id=?").run(now, confirmation.id);
      audit(database, { now, actor: confirmingUser, action: 'claim_recharge.invoice_inclusion_confirmed', entityId: confirmation.invoice_id, details: { rechargeIds: ids } });
      return { invoice: added.invoice, links: added.links };
    });
  } finally { database.close(); }
  if (result?.errorCode) throw new Error(result.errorCode);
  return result;
}

export function getClaimRechargeRegister({ databasePath, customerId = null, status = null }) {
  const clauses = [];
  const params = [];
  if (customerId != null) { clauses.push('r.customer_id=?'); params.push(positiveId(customerId, 'customer_id')); }
  if (status != null) {
    if (!['PENDING', 'APPROVED', 'INVOICED', 'EXCLUDED'].includes(status)) throw new TypeError('Unsupported recharge status.');
    clauses.push('r.status=?'); params.push(status);
  }
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    return database.prepare(`SELECT r.*,cl.claim_number,cl.transaction_date,c.customer_code,c.display_name AS customer_name,
      l.invoice_id,l.invoice_line_item_id,i.invoice_number
      FROM claim_recharges r JOIN claims cl ON cl.id=r.claim_id JOIN customers c ON c.id=r.customer_id
      LEFT JOIN claim_invoice_links l ON l.claim_recharge_id=r.id LEFT JOIN invoices i ON i.id=l.invoice_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY cl.transaction_date,r.id`).all(...params);
  } finally { database.close(); }
}
