import { randomBytes } from 'node:crypto';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { normalizeCustomerLookup } from './customer-registry.mjs';
import { recordHash } from './registry-audit.mjs';

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const API_TO_DB = Object.freeze({
  legalName: 'legal_name', displayName: 'display_name', registrationNumber: 'registration_number',
  taxRegistrationNumber: 'tax_registration_number', billingAddress: 'billing_address',
  billingContactName: 'billing_contact_name', billingEmail: 'billing_email', billingPhone: 'billing_phone',
  defaultCurrency: 'default_currency', defaultPaymentTermsDays: 'default_payment_terms_days',
  taxTreatment: 'tax_treatment', purchaseOrderRequired: 'purchase_order_required', notes: 'notes'
});
const REQUIRED_CREATE = ['legalName', 'displayName', 'billingAddress', 'defaultCurrency', 'defaultPaymentTermsDays', 'taxTreatment', 'purchaseOrderRequired'];
const ESSENTIAL = new Set(['legalName', 'displayName', 'billingAddress', 'defaultCurrency', 'defaultPaymentTermsDays', 'taxTreatment', 'purchaseOrderRequired']);
const CURRENCIES = new Set(['MYR', 'SGD', 'USD']);

export class WhatsAppCustomerError extends Error {
  constructor(code) { super(code); this.name = 'WhatsAppCustomerError'; this.code = code; }
}
const fail = (code) => { throw new WhatsAppCustomerError(code); };
function text(value, name, maximum = 500) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  if (value.trim().length > maximum) throw new TypeError(`${name} is too long.`);
  return value.trim();
}
function optionalText(value, name, maximum = 500) {
  if (value === null) return null;
  return text(value, name, maximum);
}
function customerCode(value) {
  const code = text(value, 'customerCode', 20).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) fail('CUSTOMER_CODE_INVALID');
  return code;
}
function instant(value, name = 'now') {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new TypeError(`${name} must be an ISO-8601 UTC instant.`);
  return parsed;
}
function trustedContext({ requestingUser, sourceChannel, sourceChat, sourceMessageReference }) {
  return {
    requestingUser: text(requestingUser, 'requestingUser', 200),
    sourceChannel: text(sourceChannel, 'sourceChannel', 40),
    sourceChat: text(sourceChat, 'sourceChat', 200),
    sourceMessageReference: sourceMessageReference == null ? null : text(sourceMessageReference, 'sourceMessageReference', 200)
  };
}
function ensureCurrency(database, value) {
  const currency = text(value, 'defaultCurrency', 3).toUpperCase();
  if (!CURRENCIES.has(currency)) fail('CUSTOMER_CURRENCY_INVALID');
  const row = database.prepare('SELECT enabled FROM currencies WHERE code=?').get(currency);
  if (!row || row.enabled !== 1) fail('CUSTOMER_CURRENCY_INACTIVE');
  return currency;
}
function validateField(database, apiField, value) {
  if (!Object.hasOwn(API_TO_DB, apiField)) fail('CUSTOMER_FIELD_NOT_SUPPORTED');
  if (value === null && ESSENTIAL.has(apiField)) fail('CUSTOMER_REQUIRED_FIELD_CANNOT_BE_CLEARED');
  if (apiField === 'defaultCurrency') return ensureCurrency(database, value);
  if (apiField === 'defaultPaymentTermsDays') {
    if (!Number.isInteger(value) || value < 0 || value > 3650) fail('CUSTOMER_PAYMENT_TERMS_INVALID');
    return value;
  }
  if (apiField === 'purchaseOrderRequired') {
    if (typeof value !== 'boolean') fail('CUSTOMER_PO_POLICY_INVALID');
    return value ? 1 : 0;
  }
  const limits = { billingAddress: 2000, notes: 2000, billingEmail: 320, billingPhone: 80, legalName: 300, displayName: 300 };
  return optionalText(value, apiField, limits[apiField] ?? 500);
}
function normalizeFields(database, values, { create = false } = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) fail('CUSTOMER_FIELDS_REQUIRED');
  if (create) for (const field of REQUIRED_CREATE) if (!Object.hasOwn(values, field)) fail(`CUSTOMER_REQUIRED_${field.replaceAll(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`);
  const entries = Object.entries(values);
  if (!entries.length) fail('CUSTOMER_CHANGE_EMPTY');
  const normalized = Object.fromEntries(entries.map(([field, value]) => [API_TO_DB[field] ?? fail('CUSTOMER_FIELD_NOT_SUPPORTED'), validateField(database, field, value)]));
  if (create) for (const databaseField of Object.values(API_TO_DB)) if (!Object.hasOwn(normalized, databaseField)) normalized[databaseField] = null;
  return normalized;
}
function findByCode(database, code) { return database.prepare('SELECT * FROM customers WHERE lower(customer_code)=lower(?)').get(code) ?? null; }
function hasPendingDocumentWorkflow(database, customerId) {
  const invoiceCount = database.prepare("SELECT COUNT(*) AS count FROM invoices WHERE customer_id=? AND status IN ('PENDING_CONFIRMATION','GENERATING')").get(customerId).count;
  const quotationCount = database.prepare("SELECT COUNT(*) AS count FROM quotations WHERE customer_id=? AND status IN ('PENDING_CONFIRMATION','GENERATING')").get(customerId).count;
  return invoiceCount + quotationCount > 0;
}
function duplicateName(database, values, excludedId = null) {
  for (const name of [values.legal_name, values.display_name].filter(Boolean)) {
    const normalized = normalizeCustomerLookup(name);
    const customers = database.prepare('SELECT id,legal_name,display_name FROM customers').all();
    if (customers.some((row) => row.id !== excludedId && [row.legal_name, row.display_name].filter(Boolean).some((item) => normalizeCustomerLookup(item) === normalized))) return true;
    const alias = database.prepare('SELECT customer_id FROM customer_aliases WHERE normalized_alias=?').get(normalized);
    if (alias && alias.customer_id !== excludedId) return true;
  }
  return false;
}
function publicRecord(row) {
  return {
    customerCode: row.customer_code, legalName: row.legal_name, displayName: row.display_name,
    registrationNumber: row.registration_number, taxRegistrationNumber: row.tax_registration_number,
    billingAddress: row.billing_address, billingContactName: row.billing_contact_name,
    billingEmail: row.billing_email, billingPhone: row.billing_phone, defaultCurrency: row.default_currency,
    defaultPaymentTermsDays: row.default_payment_terms_days, taxTreatment: row.tax_treatment,
    purchaseOrderRequired: row.purchase_order_required === 1, active: row.active === 1, notes: row.notes
  };
}
function readiness(row) {
  const issues = [];
  if (row.active !== 1) issues.push('inactive');
  if (!row.legal_name) issues.push('missing_legal_name');
  if (!row.billing_address) issues.push('missing_billing_address');
  if (!row.default_currency) issues.push('missing_currency');
  if (row.default_payment_terms_days === null) issues.push('missing_payment_terms');
  if (!row.tax_treatment) issues.push('missing_tax_treatment');
  return { ready: issues.length === 0, issues };
}
function audit(database, { now, actor, action, customer, before, sourceChannel, sourceChat, sourceMessageReference, changedFields }) {
  database.prepare(`INSERT INTO audit_events
    (timestamp,actor,action,entity_type,entity_id,before_hash,after_hash,source_channel,source_chat,source_message_reference,result,details_json)
    VALUES (?,?,?,'customer',?,?,?,?,?,?,'PASS',?)`).run(
    now, actor, action, customer.id, recordHash(before), recordHash(customer), sourceChannel, sourceChat,
    sourceMessageReference, JSON.stringify({ changedFields: [...changedFields].sort() })
  );
}

export function generateCustomerConfirmationToken(randomSource = randomBytes) {
  const bytes = randomSource(10);
  if (!(bytes instanceof Uint8Array) || bytes.length < 10) throw new TypeError('randomSource must return at least 10 bytes.');
  return `CU-${[...bytes.slice(0, 10)].map((byte) => TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length]).join('')}`;
}

export function listWhatsAppCustomers({ databasePath, status = 'ACTIVE', query = null, limit = 50 }) {
  if (!['ACTIVE', 'INACTIVE', 'ALL'].includes(status)) fail('CUSTOMER_LIST_STATUS_INVALID');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('CUSTOMER_LIST_LIMIT_INVALID');
  const needle = query == null ? null : normalizeCustomerLookup(text(query, 'query', 200));
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    const aliases = database.prepare('SELECT customer_id,normalized_alias FROM customer_aliases').all();
    const aliasMap = new Map();
    for (const alias of aliases) {
      if (!aliasMap.has(alias.customer_id)) aliasMap.set(alias.customer_id, []);
      aliasMap.get(alias.customer_id).push(alias.normalized_alias);
    }
    const filtered = database.prepare('SELECT * FROM customers ORDER BY customer_code').all().filter((row) => {
      if (status === 'ACTIVE' && row.active !== 1) return false;
      if (status === 'INACTIVE' && row.active === 1) return false;
      if (!needle) return true;
      return [row.customer_code, row.legal_name, row.display_name, ...(aliasMap.get(row.id) ?? [])]
        .filter(Boolean).some((value) => normalizeCustomerLookup(value).includes(needle));
    });
    return {
      status: 'OK', totalMatches: filtered.length, truncated: filtered.length > limit,
      customers: filtered.slice(0, limit).map((row) => ({
        customerCode: row.customer_code, legalName: row.legal_name, displayName: row.display_name,
        defaultCurrency: row.default_currency, defaultPaymentTermsDays: row.default_payment_terms_days,
        purchaseOrderRequired: row.purchase_order_required === 1, active: row.active === 1, readiness: readiness(row)
      }))
    };
  } finally { database.close(); }
}

export function prepareWhatsAppCustomerChange({
  databasePath, input, requestingUser, sourceChannel, sourceChat, sourceMessageReference,
  confirmationTtlMinutes = 15, now = new Date().toISOString(), tokenFactory = generateCustomerConfirmationToken
}) {
  const context = trustedContext({ requestingUser, sourceChannel, sourceChat, sourceMessageReference });
  const created = instant(now);
  if (!Number.isInteger(confirmationTtlMinutes) || confirmationTtlMinutes < 1 || confirmationTtlMinutes > 1440) fail('CUSTOMER_CONFIRMATION_TTL_INVALID');
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('CUSTOMER_CHANGE_INPUT_REQUIRED');
  const operation = text(input.operation, 'operation', 20).toUpperCase();
  if (!['CREATE', 'UPDATE', 'DEACTIVATE'].includes(operation)) fail('CUSTOMER_OPERATION_INVALID');
  const code = customerCode(input.customerCode);
  const database = openDatabase(databasePath);
  try { return withImmediateTransaction(database, () => {
    const before = findByCode(database, code);
    let payload; let proposed;
    if (operation === 'CREATE') {
      if (before) fail('CUSTOMER_ALREADY_EXISTS');
      const fields = normalizeFields(database, input.fields, { create: true });
      proposed = { customer_code: code, ...fields, active: 1 };
      if (duplicateName(database, proposed)) fail('CUSTOMER_NAME_ALREADY_EXISTS');
      payload = { fields };
    } else {
      if (!before) fail('CUSTOMER_NOT_FOUND');
      if (hasPendingDocumentWorkflow(database, before.id)) fail('CUSTOMER_HAS_PENDING_DOCUMENT_WORKFLOW');
      if (operation === 'DEACTIVATE') {
        if (before.active !== 1) fail('CUSTOMER_ALREADY_INACTIVE');
        if (input.fields && Object.keys(input.fields).length) fail('CUSTOMER_DEACTIVATE_FIELDS_NOT_ALLOWED');
        payload = {}; proposed = { ...before, active: 0 };
      } else {
        const fields = normalizeFields(database, input.fields);
        proposed = { ...before, ...fields };
        if (duplicateName(database, proposed, before.id)) fail('CUSTOMER_NAME_ALREADY_EXISTS');
        if (recordHash(proposed) === recordHash(before)) fail('CUSTOMER_CHANGE_EMPTY');
        payload = { fields };
      }
    }
    database.prepare("UPDATE customer_change_requests SET status='INVALIDATED' WHERE target_customer_code=? AND status='PENDING'").run(code);
    const token = tokenFactory();
    if (!/^CU-[A-Z2-9]{10}$/.test(token)) throw new TypeError('tokenFactory returned an invalid customer token.');
    const expiresAt = new Date(created.valueOf() + confirmationTtlMinutes * 60000).toISOString();
    const requestHash = recordHash({ operation, code, beforeHash: recordHash(before), payload });
    database.prepare(`INSERT INTO customer_change_requests
      (token,operation,customer_id,target_customer_code,before_hash,request_hash,payload_json,requesting_user,
       source_channel,source_chat,source_message_reference,status,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'PENDING',?,?)`).run(
      token, operation, before?.id ?? null, code, recordHash(before), requestHash, JSON.stringify(payload),
      context.requestingUser, context.sourceChannel, context.sourceChat, context.sourceMessageReference, expiresAt, now
    );
    return { status: 'PENDING_CONFIRMATION', operation, customerCode: code, before: before ? publicRecord(before) : null,
      proposed: publicRecord(proposed), readiness: readiness(proposed), confirmationToken: token, expiresAt };
  }); } finally { database.close(); }
}

export function confirmWhatsAppCustomerChange({ databasePath, token, confirmingUser, sourceChannel, sourceChat, now = new Date().toISOString() }) {
  instant(now);
  const confirmationToken = text(token, 'token', 32);
  const database = openDatabase(databasePath);
  try { return withImmediateTransaction(database, () => {
    const request = database.prepare('SELECT * FROM customer_change_requests WHERE token=?').get(confirmationToken);
    if (!request) fail('CUSTOMER_CONFIRMATION_NOT_FOUND');
    if (request.status !== 'PENDING') fail('CUSTOMER_CONFIRMATION_NOT_PENDING');
    if (new Date(request.expires_at).valueOf() <= new Date(now).valueOf()) {
      database.prepare("UPDATE customer_change_requests SET status='EXPIRED' WHERE id=?").run(request.id);
      return { rejectedCode: 'CUSTOMER_CONFIRMATION_EXPIRED' };
    }
    if (request.requesting_user !== confirmingUser) fail('CUSTOMER_CONFIRMING_USER_MISMATCH');
    if (request.source_channel !== sourceChannel || request.source_chat !== sourceChat) fail('CUSTOMER_CONFIRMATION_CONTEXT_MISMATCH');
    const before = findByCode(database, request.target_customer_code);
    const payload = JSON.parse(request.payload_json);
    const boundHash = recordHash({ operation: request.operation, code: request.target_customer_code, beforeHash: request.before_hash, payload });
    if (boundHash !== request.request_hash) {
      database.prepare("UPDATE customer_change_requests SET status='INVALIDATED' WHERE id=?").run(request.id);
      return { rejectedCode: 'CUSTOMER_CONFIRMATION_HASH_MISMATCH' };
    }
    if (recordHash(before) !== request.before_hash) {
      database.prepare("UPDATE customer_change_requests SET status='INVALIDATED' WHERE id=?").run(request.id);
      return { rejectedCode: 'CUSTOMER_RECORD_CHANGED' };
    }
    if (before && hasPendingDocumentWorkflow(database, before.id)) {
      database.prepare("UPDATE customer_change_requests SET status='INVALIDATED' WHERE id=?").run(request.id);
      return { rejectedCode: 'CUSTOMER_HAS_PENDING_DOCUMENT_WORKFLOW' };
    }
    let customer; let changedFields;
    if (request.operation === 'CREATE') {
      if (before) fail('CUSTOMER_ALREADY_EXISTS');
      const fields = payload.fields;
      if (duplicateName(database, fields)) fail('CUSTOMER_NAME_ALREADY_EXISTS');
      const result = database.prepare(`INSERT INTO customers
        (customer_code,legal_name,display_name,registration_number,tax_registration_number,billing_address,
         billing_contact_name,billing_email,billing_phone,default_currency,default_payment_terms_days,tax_treatment,
         purchase_order_required,active,notes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(
        request.target_customer_code, fields.legal_name, fields.display_name, fields.registration_number ?? null,
        fields.tax_registration_number ?? null, fields.billing_address, fields.billing_contact_name ?? null,
        fields.billing_email ?? null, fields.billing_phone ?? null, fields.default_currency,
        fields.default_payment_terms_days, fields.tax_treatment, fields.purchase_order_required, fields.notes ?? null, now, now
      );
      customer = database.prepare('SELECT * FROM customers WHERE id=?').get(Number(result.lastInsertRowid));
      database.prepare('UPDATE customer_change_requests SET customer_id=? WHERE id=?').run(customer.id, request.id);
      changedFields = ['customer_code', ...Object.keys(fields)];
    } else if (request.operation === 'UPDATE') {
      const fields = payload.fields;
      const assignments = Object.keys(fields).map((field) => `${field}=?`).join(',');
      database.prepare(`UPDATE customers SET ${assignments},updated_at=? WHERE id=?`).run(...Object.values(fields), now, before.id);
      customer = database.prepare('SELECT * FROM customers WHERE id=?').get(before.id);
      changedFields = Object.keys(fields);
    } else {
      database.prepare('UPDATE customers SET active=0,updated_at=? WHERE id=?').run(now, before.id);
      customer = database.prepare('SELECT * FROM customers WHERE id=?').get(before.id);
      changedFields = ['active'];
    }
    database.prepare("UPDATE customer_change_requests SET status='CONFIRMED',confirmed_by=?,confirmed_at=? WHERE id=?")
      .run(confirmingUser, now, request.id);
    audit(database, { now, actor: confirmingUser, action: `customer.whatsapp_${request.operation.toLowerCase()}`,
      customer, before, sourceChannel, sourceChat, sourceMessageReference: request.source_message_reference, changedFields });
    return { status: 'CONFIRMED', operation: request.operation, customer: publicRecord(customer), readiness: readiness(customer) };
  }); } finally { database.close(); }
}
