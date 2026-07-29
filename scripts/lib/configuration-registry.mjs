import { openDatabase, withImmediateTransaction } from './database.mjs';
import { appendRegistryAudit } from './registry-audit.mjs';

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} is required.`);
  return value.trim();
}

function validateId(value, name) {
  const id = requireText(value, name);
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) throw new TypeError(`${name} must be a lowercase identifier.`);
  return id;
}

function currencyByCode(database, code) {
  return database.prepare('SELECT * FROM currencies WHERE code = ?').get(code);
}

function entityById(database, id) {
  return database.prepare('SELECT * FROM business_entities WHERE id = ?').get(id);
}

function bankById(database, id) {
  return database.prepare('SELECT * FROM bank_profiles WHERE id = ?').get(id);
}

function taxById(database, id) {
  return database.prepare('SELECT * FROM tax_rules WHERE id = ?').get(id);
}

function requireCurrency(database, code) {
  const currency = currencyByCode(database, code);
  if (!currency) throw new Error(`Unsupported currency: ${code}.`);
  return currency;
}

function redactAccountNumber(value) {
  if (!value) return null;
  const visible = value.replaceAll(/\s+/g, '').slice(-4);
  return `****${visible}`;
}

export function redactBankProfile(profile) {
  if (!profile) return profile;
  return { ...profile, account_number: redactAccountNumber(profile.account_number) };
}

export function createBusinessEntity({ databasePath, entity, actor, now = new Date().toISOString() }) {
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const currency = entity.default_currency ? requireCurrency(database, entity.default_currency).code : null;
      const result = database.prepare(`
        INSERT INTO business_entities (
          legal_name, trading_name, registration_number, registered_address,
          billing_address, tax_registration_number, default_currency,
          active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        requireText(entity.legal_name, 'legal_name'),
        entity.trading_name ?? null,
        entity.registration_number ?? null,
        entity.registered_address ?? null,
        entity.billing_address ?? null,
        entity.tax_registration_number ?? null,
        currency,
        now,
        now
      );
      const created = entityById(database, Number(result.lastInsertRowid));
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'business_entity.created',
        entityType: 'business_entity',
        entityId: created.id,
        before: null,
        after: created,
        changedFields: Object.keys(entity)
      });
      return created;
    });
  } finally {
    database.close();
  }
}

export function updateBusinessEntity({ databasePath, entityId, changes, actor, now = new Date().toISOString() }) {
  const allowed = new Set([
    'legal_name', 'trading_name', 'registration_number', 'registered_address',
    'billing_address', 'tax_registration_number', 'default_currency'
  ]);
  const entries = Object.entries(changes);
  if (entries.length === 0) throw new TypeError('At least one business-entity change is required.');
  for (const [field] of entries) if (!allowed.has(field)) throw new TypeError(`Unsupported business-entity field: ${field}.`);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const before = entityById(database, entityId);
      if (!before) throw new Error('Business entity was not found.');
      if (Object.hasOwn(changes, 'legal_name')) requireText(changes.legal_name, 'legal_name');
      if (changes.default_currency) requireCurrency(database, changes.default_currency);
      const assignments = entries.map(([field]) => `${field} = ?`).join(', ');
      database.prepare(`UPDATE business_entities SET ${assignments}, updated_at = ? WHERE id = ?`)
        .run(...entries.map(([, value]) => value ?? null), now, entityId);
      const after = entityById(database, entityId);
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'business_entity.updated',
        entityType: 'business_entity',
        entityId,
        before,
        after,
        changedFields: entries.map(([field]) => field)
      });
      return after;
    });
  } finally {
    database.close();
  }
}

export function deactivateBusinessEntity({ databasePath, entityId, actor, now = new Date().toISOString() }) {
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const before = entityById(database, entityId);
      if (!before) throw new Error('Business entity was not found.');
      const activeBanks = database.prepare('SELECT COUNT(*) AS count FROM bank_profiles WHERE business_entity_id = ? AND active = 1').get(entityId).count;
      if (activeBanks > 0) throw new Error('Business entity has active bank profiles.');
      database.prepare('UPDATE business_entities SET active = 0, updated_at = ? WHERE id = ?').run(now, entityId);
      const after = entityById(database, entityId);
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'business_entity.deactivated',
        entityType: 'business_entity',
        entityId,
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

export function createBankProfile({ databasePath, profile, actor, now = new Date().toISOString() }) {
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const id = validateId(profile.id, 'bank profile id');
      const entity = entityById(database, profile.business_entity_id);
      if (!entity || entity.active !== 1) throw new Error('Bank profile requires an active business entity.');
      const currency = requireCurrency(database, profile.currency);
      if (currency.enabled !== 1) throw new Error('Bank profile currency is inactive.');
      database.prepare(`
        INSERT INTO bank_profiles (
          id, display_name, business_entity_id, currency, bank_name,
          account_name, account_number, bank_address, swift_code,
          routing_code, additional_instructions, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        requireText(profile.display_name, 'display_name'),
        profile.business_entity_id,
        profile.currency,
        requireText(profile.bank_name, 'bank_name'),
        requireText(profile.account_name, 'account_name'),
        requireText(profile.account_number, 'account_number'),
        profile.bank_address ?? null,
        profile.swift_code ?? null,
        profile.routing_code ?? null,
        profile.additional_instructions ?? null,
        now,
        now
      );
      const created = bankById(database, id);
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'bank_profile.created',
        entityType: 'bank_profile',
        entityId: null,
        before: null,
        after: created,
        changedFields: Object.keys(profile)
      });
      return redactBankProfile(created);
    });
  } finally {
    database.close();
  }
}

export function updateBankProfile({ databasePath, profileId, changes, actor, now = new Date().toISOString() }) {
  const allowed = new Set([
    'display_name', 'business_entity_id', 'currency', 'bank_name', 'account_name',
    'account_number', 'bank_address', 'swift_code', 'routing_code', 'additional_instructions'
  ]);
  const entries = Object.entries(changes);
  if (entries.length === 0) throw new TypeError('At least one bank-profile change is required.');
  for (const [field] of entries) if (!allowed.has(field)) throw new TypeError(`Unsupported bank-profile field: ${field}.`);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const before = bankById(database, profileId);
      if (!before) throw new Error('Bank profile was not found.');
      const nextEntityId = changes.business_entity_id ?? before.business_entity_id;
      const nextCurrency = changes.currency ?? before.currency;
      const entity = entityById(database, nextEntityId);
      if (!entity || entity.active !== 1) throw new Error('Bank profile requires an active business entity.');
      const currency = requireCurrency(database, nextCurrency);
      if (currency.enabled !== 1) throw new Error('Bank profile currency is inactive.');
      const assignedCurrencies = database.prepare('SELECT code FROM currencies WHERE default_bank_profile_id = ?').all(profileId);
      if (assignedCurrencies.some((item) => item.code !== nextCurrency)) {
        throw new Error('Cannot change the currency of an assigned bank profile.');
      }
      for (const field of ['display_name', 'bank_name', 'account_name', 'account_number']) {
        if (Object.hasOwn(changes, field)) requireText(changes[field], field);
      }
      const assignments = entries.map(([field]) => `${field} = ?`).join(', ');
      database.prepare(`UPDATE bank_profiles SET ${assignments}, updated_at = ? WHERE id = ?`)
        .run(...entries.map(([, value]) => value ?? null), now, profileId);
      const after = bankById(database, profileId);
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'bank_profile.updated',
        entityType: 'bank_profile',
        entityId: null,
        before,
        after,
        changedFields: entries.map(([field]) => field)
      });
      return redactBankProfile(after);
    });
  } finally {
    database.close();
  }
}

export function deactivateBankProfile({ databasePath, profileId, actor, now = new Date().toISOString() }) {
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const before = bankById(database, profileId);
      if (!before) throw new Error('Bank profile was not found.');
      const linked = database.prepare('SELECT COUNT(*) AS count FROM currencies WHERE default_bank_profile_id = ? AND enabled = 1').get(profileId).count;
      if (linked > 0) throw new Error('Bank profile is assigned to an enabled currency.');
      database.prepare('UPDATE bank_profiles SET active = 0, updated_at = ? WHERE id = ?').run(now, profileId);
      const after = bankById(database, profileId);
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'bank_profile.deactivated',
        entityType: 'bank_profile',
        entityId: null,
        before,
        after,
        changedFields: ['active']
      });
      return redactBankProfile(after);
    });
  } finally {
    database.close();
  }
}

export function createTaxRule({ databasePath, rule, actor, now = new Date().toISOString() }) {
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      if (!Number.isInteger(rule.rate_basis_points) || rule.rate_basis_points < 0) {
        throw new TypeError('rate_basis_points must be a non-negative integer.');
      }
      const result = database.prepare(`
        INSERT INTO tax_rules (
          country, name, code, rate_basis_points, calculation_method,
          display_label, registration_number, effective_from, effective_until,
          active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        requireText(rule.country, 'country'),
        requireText(rule.name, 'name'),
        validateId(rule.code, 'tax rule code'),
        rule.rate_basis_points,
        requireText(rule.calculation_method, 'calculation_method'),
        requireText(rule.display_label, 'display_label'),
        rule.registration_number ?? null,
        rule.effective_from ?? null,
        rule.effective_until ?? null,
        now,
        now
      );
      const created = taxById(database, Number(result.lastInsertRowid));
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'tax_rule.created',
        entityType: 'tax_rule',
        entityId: created.id,
        before: null,
        after: created,
        changedFields: Object.keys(rule)
      });
      return created;
    });
  } finally {
    database.close();
  }
}

export function updateTaxRule({ databasePath, ruleId, changes, actor, now = new Date().toISOString() }) {
  const allowed = new Set([
    'country', 'name', 'code', 'rate_basis_points', 'calculation_method',
    'display_label', 'registration_number', 'effective_from', 'effective_until'
  ]);
  const entries = Object.entries(changes);
  if (entries.length === 0) throw new TypeError('At least one tax-rule change is required.');
  for (const [field] of entries) if (!allowed.has(field)) throw new TypeError(`Unsupported tax-rule field: ${field}.`);
  if (Object.hasOwn(changes, 'rate_basis_points') && (!Number.isInteger(changes.rate_basis_points) || changes.rate_basis_points < 0)) {
    throw new TypeError('rate_basis_points must be a non-negative integer.');
  }
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const before = taxById(database, ruleId);
      if (!before) throw new Error('Tax rule was not found.');
      for (const field of ['country', 'name', 'calculation_method', 'display_label']) {
        if (Object.hasOwn(changes, field)) requireText(changes[field], field);
      }
      if (Object.hasOwn(changes, 'code')) validateId(changes.code, 'tax rule code');
      const assignments = entries.map(([field]) => `${field} = ?`).join(', ');
      database.prepare(`UPDATE tax_rules SET ${assignments}, updated_at = ? WHERE id = ?`)
        .run(...entries.map(([, value]) => value ?? null), now, ruleId);
      const after = taxById(database, ruleId);
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'tax_rule.updated',
        entityType: 'tax_rule',
        entityId: ruleId,
        before,
        after,
        changedFields: entries.map(([field]) => field)
      });
      return after;
    });
  } finally {
    database.close();
  }
}

export function deactivateTaxRule({ databasePath, ruleId, actor, now = new Date().toISOString() }) {
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const before = taxById(database, ruleId);
      if (!before) throw new Error('Tax rule was not found.');
      const linked = database.prepare('SELECT COUNT(*) AS count FROM currencies WHERE default_tax_rule_id = ? AND enabled = 1').get(ruleId).count;
      if (linked > 0) throw new Error('Tax rule is assigned to an enabled currency.');
      database.prepare('UPDATE tax_rules SET active = 0, updated_at = ? WHERE id = ?').run(now, ruleId);
      const after = taxById(database, ruleId);
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'tax_rule.deactivated',
        entityType: 'tax_rule',
        entityId: ruleId,
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

export function configureCurrency({ databasePath, code, changes, actor, now = new Date().toISOString() }) {
  const allowed = new Set([
    'enabled', 'quotation_template_id', 'invoice_template_id',
    'default_bank_profile_id', 'default_tax_rule_id'
  ]);
  const entries = Object.entries(changes);
  if (entries.length === 0) throw new TypeError('At least one currency change is required.');
  for (const [field] of entries) if (!allowed.has(field)) throw new TypeError(`Unsupported currency field: ${field}.`);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const before = requireCurrency(database, code);
      if (changes.default_bank_profile_id) {
        const bank = bankById(database, changes.default_bank_profile_id);
        if (!bank || bank.active !== 1 || bank.currency !== code) throw new Error('Default bank profile must be active and match the currency.');
      }
      if (changes.default_tax_rule_id) {
        const tax = taxById(database, changes.default_tax_rule_id);
        if (!tax || tax.active !== 1) throw new Error('Default tax rule must be active.');
      }
      const normalized = Object.fromEntries(entries.map(([field, value]) => [
        field,
        field === 'enabled' ? (value ? 1 : 0) : (value ?? null)
      ]));
      const assignments = Object.keys(normalized).map((field) => `${field} = ?`).join(', ');
      database.prepare(`UPDATE currencies SET ${assignments}, updated_at = ? WHERE code = ?`)
        .run(...Object.values(normalized), now, code);
      const after = currencyByCode(database, code);
      appendRegistryAudit(database, {
        timestamp: now,
        actor,
        action: 'currency.updated',
        entityType: 'currency',
        entityId: null,
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

export function listRegistry({ databasePath, registry }) {
  const statements = {
    currencies: 'SELECT * FROM currencies ORDER BY code',
    entities: 'SELECT * FROM business_entities ORDER BY id',
    banks: 'SELECT * FROM bank_profiles ORDER BY id',
    taxes: 'SELECT * FROM tax_rules ORDER BY id'
  };
  if (!Object.hasOwn(statements, registry)) throw new TypeError('Unsupported registry.');
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(statements[registry]).all();
    return registry === 'banks' ? rows.map(redactBankProfile) : rows;
  } finally {
    database.close();
  }
}
