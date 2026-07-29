import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { assessCustomerReadiness } from './customer-registry.mjs';
import { calculateQuotationTotals } from './quotation-calculations.mjs';
import { canonicalJson } from './quotation-drafts.mjs';

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CURRENCIES = new Set(['MYR', 'SGD', 'USD']);

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}
function optional(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function hash(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function instant(value, name) {
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.valueOf()) || date.toISOString() !== value) throw new TypeError(`${name} must be an ISO-8601 UTC instant.`);
  return date;
}

export function calculateDueDate(issueDate, paymentTermsDays) {
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 3650) {
    throw new RangeError('payment_terms_days must be an integer from 0 to 3650.');
  }
  if (typeof issueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) throw new TypeError('issue_date must use YYYY-MM-DD.');
  const date = new Date(`${issueDate}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== issueDate) throw new RangeError('issue_date must be a real calendar date.');
  date.setUTCDate(date.getUTCDate() + paymentTermsDays);
  return date.toISOString().slice(0, 10);
}

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invoice draft input must be an object.');
  const currency = text(input.currency, 'currency').toUpperCase();
  if (!CURRENCIES.has(currency)) throw new RangeError(`Unsupported currency: ${currency}.`);
  if (!Array.isArray(input.line_items) || input.line_items.length < 1 || input.line_items.length > 7) throw new RangeError('line_items must contain 1 to 7 items.');
  if (!input.tax || input.tax.mode !== 'NONE') throw new Error('F7 supports tax.mode NONE only.');
  return {
    customerId: Number.isSafeInteger(input.customer_id) ? input.customer_id : null,
    businessEntityId: Number.isSafeInteger(input.business_entity_id) ? input.business_entity_id : null,
    currency,
    issueDate: text(input.issue_date, 'issue_date'),
    paymentTermsDays: input.payment_terms_days,
    serviceDate: optional(input.service_date),
    purchaseOrderNumber: optional(input.purchase_order_number),
    paymentTerms: optional(input.payment_terms),
    notes: optional(input.notes),
    sourceChannel: optional(input.source_channel),
    sourceMessageReference: optional(input.source_message_reference),
    quotationId: Number.isSafeInteger(input.quotation_id) ? input.quotation_id : null,
    lines: input.line_items.map((line, index) => ({
      description: text(line?.description, `line_items[${index}].description`),
      quantity: line?.quantity,
      unit: optional(line?.unit),
      unitPriceMinor: line?.unit_price_minor
    })),
    discount: input.discount
  };
}

function resolve(database, input) {
  const value = normalize(input);
  const issues = [];
  const customer = value.customerId ? database.prepare('SELECT * FROM customers WHERE id = ?').get(value.customerId) : null;
  if (!customer) issues.push(value.customerId ? 'customer_not_found' : 'missing_customer');
  else {
    issues.push(...assessCustomerReadiness(customer, { currency: value.currency, purchaseOrderNumber: value.purchaseOrderNumber }).issues);
    if (customer.purchase_order_required === 1 && !value.purchaseOrderNumber) issues.push('missing_purchase_order_number');
  }
  const entity = value.businessEntityId ? database.prepare('SELECT * FROM business_entities WHERE id = ?').get(value.businessEntityId) : null;
  if (!entity) issues.push(value.businessEntityId ? 'business_entity_not_found' : 'missing_business_entity');
  else if (entity.active !== 1) issues.push('inactive_business_entity');
  const currency = database.prepare('SELECT * FROM currencies WHERE code = ?').get(value.currency);
  if (!currency || currency.enabled !== 1) issues.push('currency_not_enabled');
  if (!currency?.invoice_template_id) issues.push('missing_invoice_template');
  const bank = currency?.default_bank_profile_id ? database.prepare('SELECT * FROM bank_profiles WHERE id = ?').get(currency.default_bank_profile_id) : null;
  if (!bank) issues.push('missing_bank_profile');
  else {
    if (bank.active !== 1) issues.push('inactive_bank_profile');
    if (bank.currency !== value.currency) issues.push('bank_currency_mismatch');
    if (entity && bank.business_entity_id !== entity.id) issues.push('bank_entity_mismatch');
  }
  if (!value.serviceDate) issues.push('missing_service_date');
  if (!value.paymentTerms) issues.push('missing_payment_terms');
  const calculations = calculateQuotationTotals({ lineItems: value.lines, discount: value.discount, taxRule: null });
  const dueDate = calculateDueDate(value.issueDate, value.paymentTermsDays);
  const snapshot = {
    kind: 'invoice-draft', quotationId: value.quotationId,
    customer: customer ? {
      id: customer.id, customerCode: customer.customer_code, legalName: customer.legal_name,
      displayName: customer.display_name, billingAddress: customer.billing_address,
      billingContactName: customer.billing_contact_name, billingEmail: customer.billing_email,
      billingPhone: customer.billing_phone
    } : null,
    businessEntity: entity ? { id: entity.id, legalName: entity.legal_name, tradingName: entity.trading_name } : null,
    currency: value.currency, invoiceTemplateId: currency?.invoice_template_id ?? null,
    bankProfileId: bank?.id ?? null, issueDate: value.issueDate, dueDate,
    paymentTermsDays: value.paymentTermsDays, paymentTerms: value.paymentTerms,
    serviceDate: value.serviceDate, purchaseOrderNumber: value.purchaseOrderNumber,
    notes: value.notes, sourceChannel: value.sourceChannel,
    sourceMessageReference: value.sourceMessageReference,
    lineItems: value.lines.map((line, index) => ({
      sequence: index + 1, description: line.description, quantity: calculations.lines[index].display,
      quantityNumerator: calculations.lines[index].numerator, quantityScale: calculations.lines[index].scale,
      unit: line.unit, unitPriceMinor: line.unitPriceMinor, subtotalMinor: calculations.lines[index].subtotalMinor
    })),
    discount: calculations.discount, taxMode: 'NONE', taxRule: null,
    totals: { subtotalMinor: calculations.subtotalMinor, discountMinor: calculations.discountMinor, taxMinor: 0, totalMinor: calculations.totalMinor },
    validationIssues: [...new Set(issues)].sort()
  };
  return { value, customer, entity, calculations, snapshot };
}

function lines(database, invoiceId, snapshot) {
  const statement = database.prepare(`INSERT INTO invoice_line_items
    (invoice_id, sequence, description, quantity_numerator, quantity_scale, unit, unit_price_minor,
     discount_minor, tax_code, line_subtotal_minor, line_tax_minor, line_total_minor)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 0, ?)`);
  for (const line of snapshot.lineItems) statement.run(invoiceId, line.sequence, line.description, line.quantityNumerator, line.quantityScale, line.unit, line.unitPriceMinor, line.subtotalMinor, line.subtotalMinor);
}

function persist(database, invoiceId, version, resolved, actor, now) {
  const snapshot = { ...resolved.snapshot, version };
  const draftHash = hash(snapshot);
  const snapshotJson = canonicalJson(snapshot);
  database.prepare(`INSERT INTO invoice_draft_state
    (invoice_id,current_version,draft_hash,snapshot_json,validation_issues_json,discount_type,discount_value,payment_terms_days,tax_mode,updated_at)
    VALUES (?,?,?,?,?,?,?,?, 'NONE',?)
    ON CONFLICT(invoice_id) DO UPDATE SET current_version=excluded.current_version,draft_hash=excluded.draft_hash,
    snapshot_json=excluded.snapshot_json,validation_issues_json=excluded.validation_issues_json,discount_type=excluded.discount_type,
    discount_value=excluded.discount_value,payment_terms_days=excluded.payment_terms_days,updated_at=excluded.updated_at`)
    .run(invoiceId, version, draftHash, snapshotJson, canonicalJson(snapshot.validationIssues), snapshot.discount.type, snapshot.discount.value, snapshot.paymentTermsDays, now);
  database.prepare('INSERT INTO invoice_draft_versions (invoice_id,version,draft_hash,snapshot_json,created_by,created_at) VALUES (?,?,?,?,?,?)')
    .run(invoiceId, version, draftHash, snapshotJson, actor, now);
  return { snapshot, draftHash };
}

function result(database, invoiceId) {
  const row = database.prepare(`SELECT i.id,i.status,i.invoice_number,s.current_version,s.draft_hash,s.snapshot_json
    FROM invoices i JOIN invoice_draft_state s ON s.invoice_id=i.id WHERE i.id=?`).get(invoiceId);
  if (!row) throw new Error('Invoice draft was not found.');
  return { id: row.id, status: row.status, invoiceNumber: row.invoice_number, version: row.current_version, draftHash: row.draft_hash, snapshot: JSON.parse(row.snapshot_json) };
}

function audit(database, now, actor, action, invoiceId, snapshot, beforeHash = null, afterHash = null) {
  database.prepare(`INSERT INTO audit_events
    (timestamp,actor,action,entity_type,entity_id,before_hash,after_hash,source_channel,source_message_reference,result,details_json)
    VALUES (?,?,?,'invoice',?,?,?,?,?,'PASS',?)`).run(now, actor, action, invoiceId, beforeHash, afterHash,
      snapshot.sourceChannel, snapshot.sourceMessageReference, canonicalJson({ version: snapshot.version, validationIssueCount: snapshot.validationIssues.length }));
}

export function createStandaloneInvoiceDraft({ databasePath, input, actor, now = new Date().toISOString() }) {
  text(actor, 'actor'); instant(now, 'now');
  const database = openDatabase(databasePath);
  try { return withImmediateTransaction(database, () => {
    const resolved = resolve(database, input);
    const row = database.prepare(`INSERT INTO invoices
      (status,quotation_id,customer_id,business_entity_id,currency,issue_date,due_date,service_date,purchase_order_number,
       subtotal_minor,discount_minor,tax_minor,total_minor,amount_paid_minor,balance_due_minor,payment_status,payment_terms,notes,created_by,created_at)
      VALUES ('DRAFT',?,?,?,?,?,?,?,?,?,?,0,?,0,?,'UNPAID',?,?,?,?)`).run(
      resolved.value.quotationId, resolved.customer?.id ?? null, resolved.entity?.id ?? null, resolved.value.currency,
      resolved.snapshot.issueDate, resolved.snapshot.dueDate, resolved.snapshot.serviceDate, resolved.snapshot.purchaseOrderNumber,
      resolved.calculations.subtotalMinor, resolved.calculations.discountMinor, resolved.calculations.totalMinor,
      resolved.calculations.totalMinor, resolved.snapshot.paymentTerms, resolved.snapshot.notes, actor, now);
    const invoiceId = Number(row.lastInsertRowid); lines(database, invoiceId, resolved.snapshot);
    const saved = persist(database, invoiceId, 1, resolved, actor, now); audit(database, now, actor, 'invoice.draft_created', invoiceId, saved.snapshot, null, saved.draftHash);
    return result(database, invoiceId);
  }); } finally { database.close(); }
}

export function createInvoiceDraftFromQuotation({ databasePath, quotationId, issueDate, paymentTermsDays, paymentTerms, purchaseOrderNumber = null, actor, sourceChannel = null, sourceMessageReference = null, now = new Date().toISOString(), partial = false }) {
  if (partial) throw new Error('PARTIAL_INVOICING_NOT_SUPPORTED_F7');
  const database = openDatabase(databasePath, { readOnly: true });
  let quotation;
  try {
    quotation = database.prepare(`SELECT q.*,s.snapshot_json FROM quotations q JOIN quotation_draft_state s ON s.quotation_id=q.id WHERE q.id=?`).get(quotationId);
    if (!quotation || quotation.status !== 'ISSUED') throw new Error('SOURCE_QUOTATION_MUST_BE_ISSUED');
    const duplicate = database.prepare('SELECT id,invoice_number,status FROM invoices WHERE quotation_id=?').get(quotationId);
    if (duplicate) return { status: 'DUPLICATE_WARNING', existingInvoiceId: duplicate.id, existingInvoiceNumber: duplicate.invoice_number };
  } finally { database.close(); }
  const snapshot = JSON.parse(quotation.snapshot_json);
  return createStandaloneInvoiceDraft({ databasePath, actor, now, input: {
    quotation_id: quotationId, customer_id: quotation.customer_id, business_entity_id: quotation.business_entity_id,
    currency: quotation.currency, issue_date: issueDate, payment_terms_days: paymentTermsDays,
    payment_terms: paymentTerms, service_date: quotation.service_date, purchase_order_number: purchaseOrderNumber,
    notes: quotation.notes, source_channel: sourceChannel, source_message_reference: sourceMessageReference,
    line_items: snapshot.lineItems.map((line) => ({ description: line.description, quantity: line.quantity, unit: line.unit, unit_price_minor: line.unitPriceMinor })),
    discount: snapshot.discount.type === 'FIXED' ? { type: 'FIXED', amount_minor: snapshot.discount.value } : snapshot.discount.type === 'PERCENTAGE' ? { type: 'PERCENTAGE', basis_points: snapshot.discount.value } : { type: 'NONE' },
    tax: { mode: 'NONE' }
  }});
}

export function getInvoiceDraft({ databasePath, invoiceId }) {
  const database = openDatabase(databasePath, { readOnly: true });
  try { return result(database, invoiceId); } finally { database.close(); }
}

export function generateInvoiceConfirmationToken(randomSource = randomBytes) {
  const bytes = randomSource(10); let body = '';
  if (!(bytes instanceof Uint8Array) || bytes.length < 10) throw new TypeError('randomSource must return at least 10 bytes.');
  for (let i = 0; i < 10; i += 1) body += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  return `ID-${body}`;
}

export function createInvoiceConfirmationToken({ databasePath, invoiceId, requestingUser, sourceChannel, sourceChat, sourceMessageReference = null, ttlMinutes = 15, now = new Date().toISOString(), tokenFactory = generateInvoiceConfirmationToken }) {
  const created = instant(now, 'now');
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) throw new RangeError('ttlMinutes must be from 1 to 1440.');
  const database = openDatabase(databasePath);
  try { return withImmediateTransaction(database, () => {
    const draft = result(database, invoiceId);
    if (draft.snapshot.validationIssues.length) throw new Error('Incomplete invoice drafts cannot request confirmation.');
    if (!['DRAFT','PENDING_CONFIRMATION'].includes(draft.status)) throw new Error('Invoice draft is not eligible for confirmation.');
    database.prepare("UPDATE pending_confirmations SET status='INVALIDATED' WHERE draft_type='invoice' AND draft_id=? AND status='PENDING'").run(invoiceId);
    const token = tokenFactory(); if (!/^ID-[A-Z2-9]{10}$/.test(token)) throw new TypeError('tokenFactory returned an invalid invoice token.');
    const expiresAt = new Date(created.valueOf() + ttlMinutes * 60000).toISOString();
    database.prepare(`INSERT INTO pending_confirmations
      (token,draft_type,draft_id,draft_hash,requesting_user,source_channel,source_chat,source_message_reference,status,expires_at,created_at)
      VALUES (?,'invoice',?,?,?,?,?,?, 'PENDING',?,?)`).run(token, invoiceId, draft.draftHash, text(requestingUser,'requestingUser'), text(sourceChannel,'sourceChannel'), text(sourceChat,'sourceChat'), optional(sourceMessageReference), expiresAt, now);
    database.prepare("UPDATE invoices SET status='PENDING_CONFIRMATION' WHERE id=?").run(invoiceId);
    audit(database, now, requestingUser, 'invoice.confirmation_requested', invoiceId, draft.snapshot, null, draft.draftHash);
    return { token, invoiceId, draftHash: draft.draftHash, status: 'PENDING', expiresAt };
  }); } finally { database.close(); }
}
