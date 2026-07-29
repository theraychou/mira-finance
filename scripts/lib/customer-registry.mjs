import { openDatabase, withImmediateTransaction } from './database.mjs';
import { appendRegistryAudit } from './registry-audit.mjs';

const customerFields = new Set([
  'legal_name', 'display_name', 'registration_number', 'tax_registration_number',
  'billing_address', 'billing_contact_name', 'billing_email', 'billing_phone',
  'default_currency', 'default_payment_terms_days', 'tax_treatment',
  'purchase_order_required', 'notes'
]);

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} is required.`);
  return value.trim();
}

function validateCustomerCode(value) {
  const code = requireText(value, 'customer_code');
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) {
    throw new TypeError('customer_code must be 2-20 uppercase letters, digits, or hyphens.');
  }
  return code;
}

export function normalizeCustomerLookup(value) {
  return requireText(value, 'lookup value')
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim()
    .replaceAll(/\s+/g, ' ');
}

function ensureCurrency(database, currency, { allowNull = true } = {}) {
  if (currency === null || currency === undefined || currency === '') {
    if (allowNull) return null;
    throw new TypeError('currency is required.');
  }
  const row = database.prepare('SELECT code, enabled FROM currencies WHERE code = ?').get(currency);
  if (!row) throw new Error(`Unsupported currency: ${currency}.`);
  if (row.enabled !== 1) throw new Error(`Currency is inactive: ${currency}.`);
  return currency;
}

function customerById(database, id) {
  return database.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

export function createCustomer({ databasePath, customer, actor, now = new Date().toISOString() }) {
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const customerCode = validateCustomerCode(customer.customer_code);
      const displayName = requireText(customer.display_name, 'display_name');
      const currency = ensureCurrency(database, customer.default_currency);
      const result = database.prepare(`
        INSERT INTO customers (
          customer_code, legal_name, display_name, registration_number,
          tax_registration_number, billing_address, billing_contact_name,
          billing_email, billing_phone, default_currency,
          default_payment_terms_days, tax_treatment, purchase_order_required,
          active, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        customerCode,
        customer.legal_name ?? null,
        displayName,
        customer.registration_number ?? null,
        customer.tax_registration_number ?? null,
        customer.billing_address ?? null,
        customer.billing_contact_name ?? null,
        customer.billing_email ?? null,
        customer.billing_phone ?? null,
        currency,
        customer.default_payment_terms_days ?? null,
        customer.tax_treatment ?? null,
        customer.purchase_order_required ? 1 : 0,
        customer.notes ?? null,
        now,
        now
      );
      const created = customerById(database, Number(result.lastInsertRowid));
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'customer.created',
        entityType: 'customer',
        entityId: created.id,
        before: null,
        after: created,
        changedFields: Object.keys(customer)
      });
      return created;
    });
  } finally {
    database.close();
  }
}

export function updateCustomer({ databasePath, customerId, changes, actor, now = new Date().toISOString() }) {
  if (!Number.isInteger(customerId) || customerId < 1) throw new TypeError('customerId must be a positive integer.');
  const entries = Object.entries(changes);
  if (entries.length === 0) throw new TypeError('At least one customer change is required.');
  for (const [field] of entries) {
    if (!customerFields.has(field)) throw new TypeError(`Unsupported customer field: ${field}.`);
  }
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const before = customerById(database, customerId);
      if (!before) throw new Error('Customer was not found.');
      if (Object.hasOwn(changes, 'display_name')) requireText(changes.display_name, 'display_name');
      if (Object.hasOwn(changes, 'default_currency')) ensureCurrency(database, changes.default_currency);
      const normalized = Object.fromEntries(entries.map(([field, value]) => [
        field,
        field === 'purchase_order_required' ? (value ? 1 : 0) : (value ?? null)
      ]));
      const assignments = Object.keys(normalized).map((field) => `${field} = ?`).join(', ');
      database.prepare(`UPDATE customers SET ${assignments}, updated_at = ? WHERE id = ?`)
        .run(...Object.values(normalized), now, customerId);
      const after = customerById(database, customerId);
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'customer.updated',
        entityType: 'customer',
        entityId: customerId,
        before,
        after,
        changedFields: Object.keys(normalized)
      });
      return after;
    });
  } finally {
    database.close();
  }
}

export function deactivateCustomer({ databasePath, customerId, actor, now = new Date().toISOString() }) {
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const before = customerById(database, customerId);
      if (!before) throw new Error('Customer was not found.');
      if (before.active !== 1) throw new Error('Customer is already inactive.');
      database.prepare('UPDATE customers SET active = 0, updated_at = ? WHERE id = ?').run(now, customerId);
      const after = customerById(database, customerId);
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'customer.deactivated',
        entityType: 'customer',
        entityId: customerId,
        before,
        after,
        changedFields: ['active']
      });
      return after;
    });
  } finally {
    database.close();
  }
}

export function addCustomerAlias({ databasePath, customerId, alias, actor, now = new Date().toISOString() }) {
  const displayAlias = requireText(alias, 'alias');
  const normalizedAlias = normalizeCustomerLookup(displayAlias);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const customer = customerById(database, customerId);
      if (!customer) throw new Error('Customer was not found.');
      const result = database.prepare(`
        INSERT INTO customer_aliases (customer_id, alias, normalized_alias, created_at)
        VALUES (?, ?, ?, ?)
      `).run(customerId, displayAlias, normalizedAlias, now);
      const created = database.prepare('SELECT * FROM customer_aliases WHERE id = ?').get(result.lastInsertRowid);
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'customer.alias_added',
        entityType: 'customer',
        entityId: customerId,
        before: customer,
        after: { customer, alias: created },
        changedFields: ['aliases']
      });
      return created;
    });
  } finally {
    database.close();
  }
}

function bigrams(value) {
  const compact = ` ${value} `;
  return new Set(Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2)));
}

function similarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

export function lookupCustomer({ databasePath, query }) {
  const normalized = normalizeCustomerLookup(query);
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    const code = database.prepare('SELECT * FROM customers WHERE lower(customer_code) = lower(?)').get(query.trim());
    if (code) return { status: code.active === 1 ? 'resolved' : 'inactive', matchType: 'customer_code', customer: code };

    const alias = database.prepare(`
      SELECT c.* FROM customer_aliases a JOIN customers c ON c.id = a.customer_id
      WHERE a.normalized_alias = ?
    `).get(normalized);
    if (alias) return { status: alias.active === 1 ? 'resolved' : 'inactive', matchType: 'alias', customer: alias };

    const customers = database.prepare('SELECT * FROM customers ORDER BY customer_code').all();
    const exact = customers.filter((customer) => [customer.legal_name, customer.display_name]
      .filter(Boolean)
      .some((name) => normalizeCustomerLookup(name) === normalized));
    if (exact.length === 1) {
      return { status: exact[0].active === 1 ? 'resolved' : 'inactive', matchType: 'name', customer: exact[0] };
    }
    if (exact.length > 1) return { status: 'ambiguous', matchType: 'name', candidates: exact };

    const aliases = database.prepare('SELECT customer_id, normalized_alias FROM customer_aliases').all();
    const aliasMap = new Map();
    for (const item of aliases) {
      if (!aliasMap.has(item.customer_id)) aliasMap.set(item.customer_id, []);
      aliasMap.get(item.customer_id).push(item.normalized_alias);
    }
    const candidates = customers.map((customer) => {
      const names = [customer.legal_name, customer.display_name, ...(aliasMap.get(customer.id) ?? [])]
        .filter(Boolean)
        .map(normalizeCustomerLookup);
      return { customer, score: Math.max(...names.map((name) => similarity(normalized, name))) };
    }).filter((item) => item.score >= 0.55)
      .sort((left, right) => right.score - left.score || left.customer.customer_code.localeCompare(right.customer.customer_code))
      .slice(0, 5);
    return candidates.length > 0
      ? { status: 'selection_required', matchType: 'fuzzy', candidates }
      : { status: 'not_found', matchType: null, candidates: [] };
  } finally {
    database.close();
  }
}

export function assessCustomerReadiness(customer, { currency, purchaseOrderNumber } = {}) {
  const issues = [];
  if (!customer || customer.active !== 1) issues.push('inactive_customer');
  if (!customer?.legal_name) issues.push('missing_legal_name');
  if (!customer?.billing_address) issues.push('missing_billing_address');
  if (customer?.purchase_order_required === 1 && !purchaseOrderNumber) issues.push('purchase_order_required');
  if (currency && customer?.default_currency && currency !== customer.default_currency) issues.push('currency_mismatch');
  return { ready: issues.length === 0, issues };
}
