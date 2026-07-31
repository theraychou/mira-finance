import { openDatabase, withImmediateTransaction } from './database.mjs';
import { appendRegistryAudit } from './registry-audit.mjs';

const currencies = new Set(['MYR', 'SGD', 'USD']);

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}
function optional(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function normalized(value) {
  return required(value, 'supplier alias').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function code(value) {
  const result = required(value, 'supplier_code').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(result)) throw new TypeError('supplier_code must contain 2-32 uppercase letters, digits, or hyphens.');
  return result;
}
function currency(value) {
  if (value == null || value === '') return null;
  const result = String(value).toUpperCase();
  if (!currencies.has(result)) throw new TypeError('Unsupported supplier currency.');
  return result;
}
function snapshot(database, supplierId) {
  return database.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
}
function audit(database, { now, actor, action, supplierId, before, after, changedFields }) {
  appendRegistryAudit(database, {
    timestamp: now, actor, action, entityType: 'supplier', entityId: supplierId,
    before, after, changedFields
  });
}

export function createSupplier({ databasePath, supplier, aliases = [], actor, now = new Date().toISOString() }) {
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const result = database.prepare(`INSERT INTO suppliers
        (supplier_code,legal_name,display_name,registration_number,tax_registration_number,contact_name,
         contact_email,contact_phone,default_currency,active,notes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(
        code(supplier.supplier_code), optional(supplier.legal_name), required(supplier.display_name, 'display_name'),
        optional(supplier.registration_number), optional(supplier.tax_registration_number), optional(supplier.contact_name),
        optional(supplier.contact_email), optional(supplier.contact_phone), currency(supplier.default_currency),
        optional(supplier.notes), now, now
      );
      const supplierId = Number(result.lastInsertRowid);
      const values = [supplier.display_name, ...aliases].map((item) => ({ alias: required(item, 'supplier alias'), normalized: normalized(item) }));
      for (const value of new Map(values.map((item) => [item.normalized, item])).values()) {
        database.prepare('INSERT INTO supplier_aliases (supplier_id,alias,normalized_alias,created_at) VALUES (?,?,?,?)')
          .run(supplierId, value.alias, value.normalized, now);
      }
      const created = snapshot(database, supplierId);
      audit(database, { now, actor, action: 'supplier.created', supplierId, before: null, after: created, changedFields: Object.keys(supplier) });
      return created;
    });
  } finally { database.close(); }
}

export function updateSupplier({ databasePath, supplierId, changes, actor, now = new Date().toISOString() }) {
  const allowed = new Set(['legal_name', 'display_name', 'registration_number', 'tax_registration_number', 'contact_name', 'contact_email', 'contact_phone', 'default_currency', 'notes']);
  const entries = Object.entries(changes);
  if (!entries.length) throw new TypeError('At least one supplier change is required.');
  for (const [field] of entries) if (!allowed.has(field)) throw new TypeError(`Unsupported supplier field: ${field}.`);
  if (Object.hasOwn(changes, 'display_name')) required(changes.display_name, 'display_name');
  if (Object.hasOwn(changes, 'default_currency')) currency(changes.default_currency);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const before = snapshot(database, supplierId);
      if (!before) throw new Error('SUPPLIER_NOT_FOUND');
      const assignments = entries.map(([field]) => `${field}=?`).join(',');
      const values = entries.map(([field, value]) => field === 'default_currency' ? currency(value) : optional(value));
      database.prepare(`UPDATE suppliers SET ${assignments},updated_at=? WHERE id=?`).run(...values, now, supplierId);
      const after = snapshot(database, supplierId);
      audit(database, { now, actor, action: 'supplier.updated', supplierId, before, after, changedFields: entries.map(([field]) => field) });
      return after;
    });
  } finally { database.close(); }
}

export function addSupplierAlias({ databasePath, supplierId, alias, actor, now = new Date().toISOString() }) {
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const before = snapshot(database, supplierId);
      if (!before) throw new Error('SUPPLIER_NOT_FOUND');
      database.prepare('INSERT INTO supplier_aliases (supplier_id,alias,normalized_alias,created_at) VALUES (?,?,?,?)')
        .run(supplierId, required(alias, 'alias'), normalized(alias), now);
      audit(database, { now, actor, action: 'supplier.alias_added', supplierId, before, after: before, changedFields: ['aliases'] });
      return before;
    });
  } finally { database.close(); }
}

export function deactivateSupplier({ databasePath, supplierId, actor, now = new Date().toISOString() }) {
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const before = snapshot(database, supplierId);
      if (!before) throw new Error('SUPPLIER_NOT_FOUND');
      database.prepare('UPDATE suppliers SET active=0,updated_at=? WHERE id=?').run(now, supplierId);
      const after = snapshot(database, supplierId);
      audit(database, { now, actor, action: 'supplier.deactivated', supplierId, before, after, changedFields: ['active'] });
      return after;
    });
  } finally { database.close(); }
}

export function resolveSupplier({ databasePath, query }) {
  const value = required(query, 'supplier query');
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    const byCode = database.prepare('SELECT * FROM suppliers WHERE lower(supplier_code)=lower(?) AND active=1').get(value);
    if (byCode) return byCode;
    const rows = database.prepare(`SELECT s.* FROM suppliers s JOIN supplier_aliases a ON a.supplier_id=s.id
      WHERE a.normalized_alias=? AND s.active=1 ORDER BY s.id`).all(normalized(value));
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) throw new Error('SUPPLIER_LOOKUP_AMBIGUOUS');
    return null;
  } finally { database.close(); }
}

export function listSuppliers({ databasePath, includeInactive = false }) {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    return database.prepare(`SELECT * FROM suppliers ${includeInactive ? '' : 'WHERE active=1'} ORDER BY supplier_code`).all();
  } finally { database.close(); }
}
