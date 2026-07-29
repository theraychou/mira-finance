import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { assessCustomerReadiness } from './customer-registry.mjs';
import { calculateQuotationTotals, calculateValidUntil } from './quotation-calculations.mjs';

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SUPPORTED_CURRENCIES = new Set(['MYR', 'SGD', 'USD']);

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} is required.`);
  return value.trim();
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function hashSnapshot(snapshot) {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

function parseIsoInstant(value, name) {
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new TypeError(`${name} must be an ISO-8601 UTC instant.`);
  }
  return date;
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Quotation draft input must be an object.');
  const currency = requireText(input.currency, 'currency').toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(currency)) throw new RangeError(`Unsupported currency: ${currency}.`);
  if (!Array.isArray(input.line_items) || input.line_items.length === 0) throw new TypeError('line_items must contain at least one item.');
  const lineItems = input.line_items.map((line, index) => ({
    description: requireText(line?.description, `line_items[${index}].description`),
    quantity: line?.quantity,
    unit: optionalText(line?.unit),
    unitPriceMinor: line?.unit_price_minor
  }));
  const tax = input.tax;
  if (!tax || !['NONE', 'RULE'].includes(tax.mode)) throw new TypeError('tax.mode must be NONE or RULE.');
  if (tax.mode === 'RULE' && !Number.isSafeInteger(tax.tax_rule_id)) throw new TypeError('tax.tax_rule_id is required for RULE mode.');
  return {
    customerId: Number.isSafeInteger(input.customer_id) ? input.customer_id : null,
    businessEntityId: Number.isSafeInteger(input.business_entity_id) ? input.business_entity_id : null,
    currency,
    issueDate: requireText(input.issue_date, 'issue_date'),
    validityDays: input.validity_days,
    serviceDate: optionalText(input.service_date),
    title: optionalText(input.title),
    description: optionalText(input.description),
    paymentTerms: optionalText(input.payment_terms),
    notes: optionalText(input.notes),
    sourceChannel: optionalText(input.source_channel),
    sourceMessageReference: optionalText(input.source_message_reference),
    lineItems,
    discount: input.discount,
    tax: tax.mode === 'NONE' ? { mode: 'NONE' } : { mode: 'RULE', taxRuleId: tax.tax_rule_id }
  };
}

function resolveDraft(database, input) {
  const normalized = normalizeInput(input);
  const issues = [];
  const customer = normalized.customerId
    ? database.prepare('SELECT * FROM customers WHERE id = ?').get(normalized.customerId)
    : null;
  if (!customer) issues.push(normalized.customerId ? 'customer_not_found' : 'missing_customer');
  else issues.push(...assessCustomerReadiness(customer, { currency: normalized.currency }).issues);

  const entity = normalized.businessEntityId
    ? database.prepare('SELECT * FROM business_entities WHERE id = ?').get(normalized.businessEntityId)
    : null;
  if (!entity) issues.push(normalized.businessEntityId ? 'business_entity_not_found' : 'missing_business_entity');
  else if (entity.active !== 1) issues.push('inactive_business_entity');

  const currency = database.prepare('SELECT * FROM currencies WHERE code = ?').get(normalized.currency);
  if (!currency || currency.enabled !== 1) issues.push('currency_not_enabled');
  if (!currency?.quotation_template_id) issues.push('missing_quotation_template');
  const bank = currency?.default_bank_profile_id
    ? database.prepare('SELECT * FROM bank_profiles WHERE id = ?').get(currency.default_bank_profile_id)
    : null;
  if (!bank) issues.push('missing_bank_profile');
  else {
    if (bank.active !== 1) issues.push('inactive_bank_profile');
    if (bank.currency !== normalized.currency) issues.push('bank_currency_mismatch');
    if (entity && bank.business_entity_id !== entity.id) issues.push('bank_entity_mismatch');
  }

  if (!normalized.title) issues.push('missing_title');
  if (!normalized.serviceDate) issues.push('missing_service_date');
  if (!normalized.paymentTerms) issues.push('missing_payment_terms');

  let taxRule = null;
  if (normalized.tax.mode === 'RULE') {
    taxRule = database.prepare('SELECT * FROM tax_rules WHERE id = ?').get(normalized.tax.taxRuleId);
    if (!taxRule) issues.push('tax_rule_not_found');
    else {
      if (taxRule.active !== 1) issues.push('inactive_tax_rule');
      if (taxRule.effective_from && normalized.issueDate < taxRule.effective_from) issues.push('tax_rule_not_effective');
      if (taxRule.effective_until && normalized.issueDate > taxRule.effective_until) issues.push('tax_rule_expired');
      if (taxRule.calculation_method !== 'EXCLUSIVE') issues.push('unsupported_tax_method');
    }
  }

  const validUntil = calculateValidUntil(normalized.issueDate, normalized.validityDays);
  const calculations = calculateQuotationTotals({
    lineItems: normalized.lineItems,
    discount: normalized.discount,
    taxRule: taxRule && !issues.includes('unsupported_tax_method') ? taxRule : null
  });
  const taxSnapshot = taxRule ? {
    id: taxRule.id,
    code: taxRule.code,
    displayLabel: taxRule.display_label,
    rateBasisPoints: taxRule.rate_basis_points,
    calculationMethod: taxRule.calculation_method
  } : null;
  const snapshot = {
    kind: 'quotation-draft',
    customer: customer ? {
      id: customer.id,
      customerCode: customer.customer_code,
      legalName: customer.legal_name,
      displayName: customer.display_name,
      billingAddress: customer.billing_address
    } : null,
    businessEntity: entity ? { id: entity.id, legalName: entity.legal_name, tradingName: entity.trading_name } : null,
    currency: normalized.currency,
    quotationTemplateId: currency?.quotation_template_id ?? null,
    bankProfileId: bank?.id ?? null,
    issueDate: normalized.issueDate,
    validUntil,
    validityDays: normalized.validityDays,
    serviceDate: normalized.serviceDate,
    title: normalized.title,
    description: normalized.description,
    paymentTerms: normalized.paymentTerms,
    notes: normalized.notes,
    sourceChannel: normalized.sourceChannel,
    sourceMessageReference: normalized.sourceMessageReference,
    lineItems: normalized.lineItems.map((line, index) => ({
      sequence: index + 1,
      description: line.description,
      quantity: calculations.lines[index].display,
      quantityNumerator: calculations.lines[index].numerator,
      quantityScale: calculations.lines[index].scale,
      unit: line.unit,
      unitPriceMinor: line.unitPriceMinor,
      subtotalMinor: calculations.lines[index].subtotalMinor
    })),
    discount: calculations.discount,
    taxMode: normalized.tax.mode,
    taxRule: taxSnapshot,
    totals: {
      subtotalMinor: calculations.subtotalMinor,
      discountMinor: calculations.discountMinor,
      taxMinor: calculations.taxMinor,
      totalMinor: calculations.totalMinor
    },
    validationIssues: [...new Set(issues)].sort()
  };
  return { normalized, customer, entity, currency, bank, taxRule, calculations, snapshot, draftHash: hashSnapshot(snapshot) };
}

function insertLines(database, quotationId, snapshot) {
  const insert = database.prepare(`
    INSERT INTO quotation_line_items (
      quotation_id, sequence, description, quantity_numerator, quantity_scale,
      unit, unit_price_minor, discount_minor, tax_code,
      line_subtotal_minor, line_tax_minor, line_total_minor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?)
  `);
  for (const line of snapshot.lineItems) {
    insert.run(
      quotationId, line.sequence, line.description, line.quantityNumerator, line.quantityScale,
      line.unit, line.unitPriceMinor, snapshot.taxRule?.code ?? null,
      line.subtotalMinor, line.subtotalMinor
    );
  }
}

function appendAudit(database, { now, actor, action, quotationId, beforeHash = null, afterHash = null, snapshot }) {
  database.prepare(`
    INSERT INTO audit_events (
      timestamp, actor, action, entity_type, entity_id, before_hash, after_hash,
      source_channel, source_message_reference, result, details_json
    ) VALUES (?, ?, ?, 'quotation', ?, ?, ?, ?, ?, 'PASS', ?)
  `).run(
    now, actor, action, quotationId, beforeHash, afterHash,
    snapshot?.sourceChannel ?? null, snapshot?.sourceMessageReference ?? null,
    canonicalJson({ draftVersion: snapshot?.version ?? null, validationIssueCount: snapshot?.validationIssues?.length ?? 0 })
  );
}

function persistVersion(database, { quotationId, version, resolved, actor, now }) {
  const snapshot = { ...resolved.snapshot, version };
  const snapshotJson = canonicalJson(snapshot);
  const draftHash = hashSnapshot(snapshot);
  database.prepare(`
    INSERT INTO quotation_draft_state (
      quotation_id, current_version, draft_hash, snapshot_json, validation_issues_json,
      discount_type, discount_value, validity_days, tax_mode, tax_rule_snapshot_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(quotation_id) DO UPDATE SET
      current_version = excluded.current_version,
      draft_hash = excluded.draft_hash,
      snapshot_json = excluded.snapshot_json,
      validation_issues_json = excluded.validation_issues_json,
      discount_type = excluded.discount_type,
      discount_value = excluded.discount_value,
      validity_days = excluded.validity_days,
      tax_mode = excluded.tax_mode,
      tax_rule_snapshot_json = excluded.tax_rule_snapshot_json,
      updated_at = excluded.updated_at
  `).run(
    quotationId, version, draftHash, snapshotJson, canonicalJson(snapshot.validationIssues),
    snapshot.discount.type, snapshot.discount.value, snapshot.validityDays, snapshot.taxMode,
    snapshot.taxRule ? canonicalJson(snapshot.taxRule) : null, now
  );
  database.prepare(`
    INSERT INTO quotation_draft_versions (quotation_id, version, draft_hash, snapshot_json, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(quotationId, version, draftHash, snapshotJson, actor, now);
  return { snapshot, snapshotJson, draftHash };
}

function draftResult(database, quotationId) {
  const row = database.prepare(`
    SELECT q.id, q.status, q.quotation_number, s.current_version, s.draft_hash, s.snapshot_json
    FROM quotations q JOIN quotation_draft_state s ON s.quotation_id = q.id
    WHERE q.id = ?
  `).get(quotationId);
  if (!row) throw new Error('Quotation draft was not found.');
  return {
    id: row.id,
    status: row.status,
    quotationNumber: row.quotation_number,
    version: row.current_version,
    draftHash: row.draft_hash,
    snapshot: JSON.parse(row.snapshot_json)
  };
}

export function createQuotationDraft({ databasePath, input, actor, now = new Date().toISOString() }) {
  requireText(actor, 'actor');
  parseIsoInstant(now, 'now');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const resolved = resolveDraft(database, input);
      const result = database.prepare(`
        INSERT INTO quotations (
          status, customer_id, business_entity_id, currency, issue_date, valid_until,
          service_date, title, description, subtotal_minor, discount_minor, tax_minor,
          total_minor, tax_rule_id, payment_terms, notes, source_channel,
          source_message_reference, created_by, created_at
        ) VALUES ('DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resolved.customer?.id ?? null, resolved.entity?.id ?? null, resolved.normalized.currency,
        resolved.snapshot.issueDate, resolved.snapshot.validUntil, resolved.snapshot.serviceDate,
        resolved.snapshot.title, resolved.snapshot.description, resolved.calculations.subtotalMinor,
        resolved.calculations.discountMinor, resolved.calculations.taxMinor, resolved.calculations.totalMinor,
        resolved.taxRule?.id ?? null, resolved.snapshot.paymentTerms, resolved.snapshot.notes,
        resolved.snapshot.sourceChannel, resolved.snapshot.sourceMessageReference, actor, now
      );
      const quotationId = Number(result.lastInsertRowid);
      insertLines(database, quotationId, resolved.snapshot);
      const version = persistVersion(database, { quotationId, version: 1, resolved, actor, now });
      appendAudit(database, { now, actor, action: 'quotation.draft_created', quotationId, afterHash: version.draftHash, snapshot: version.snapshot });
      return draftResult(database, quotationId);
    });
  } finally {
    database.close();
  }
}

export function reviseQuotationDraft({ databasePath, quotationId, input, actor, now = new Date().toISOString() }) {
  requireText(actor, 'actor');
  parseIsoInstant(now, 'now');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const current = draftResult(database, quotationId);
      if (!['DRAFT', 'PENDING_CONFIRMATION'].includes(current.status)) throw new Error('Only unissued quotation drafts can be revised.');
      const resolved = resolveDraft(database, input);
      database.prepare(`
        UPDATE quotations SET
          status = 'DRAFT', customer_id = ?, business_entity_id = ?, currency = ?, issue_date = ?,
          valid_until = ?, service_date = ?, title = ?, description = ?, subtotal_minor = ?,
          discount_minor = ?, tax_minor = ?, total_minor = ?, tax_rule_id = ?, payment_terms = ?,
          notes = ?, source_channel = ?, source_message_reference = ?
        WHERE id = ?
      `).run(
        resolved.customer?.id ?? null, resolved.entity?.id ?? null, resolved.normalized.currency,
        resolved.snapshot.issueDate, resolved.snapshot.validUntil, resolved.snapshot.serviceDate,
        resolved.snapshot.title, resolved.snapshot.description, resolved.calculations.subtotalMinor,
        resolved.calculations.discountMinor, resolved.calculations.taxMinor, resolved.calculations.totalMinor,
        resolved.taxRule?.id ?? null, resolved.snapshot.paymentTerms, resolved.snapshot.notes,
        resolved.snapshot.sourceChannel, resolved.snapshot.sourceMessageReference, quotationId
      );
      database.prepare('DELETE FROM quotation_line_items WHERE quotation_id = ?').run(quotationId);
      insertLines(database, quotationId, resolved.snapshot);
      database.prepare(`
        UPDATE pending_confirmations SET status = 'INVALIDATED'
        WHERE draft_type = 'quotation' AND draft_id = ? AND status = 'PENDING'
      `).run(quotationId);
      const version = persistVersion(database, { quotationId, version: current.version + 1, resolved, actor, now });
      appendAudit(database, {
        now, actor, action: 'quotation.draft_revised', quotationId,
        beforeHash: current.draftHash, afterHash: version.draftHash, snapshot: version.snapshot
      });
      return draftResult(database, quotationId);
    });
  } finally {
    database.close();
  }
}

export function getQuotationDraft({ databasePath, quotationId }) {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    return draftResult(database, quotationId);
  } finally {
    database.close();
  }
}

export function generateConfirmationToken(randomSource = randomBytes) {
  const bytes = randomSource(10);
  if (!(bytes instanceof Uint8Array) || bytes.length < 10) throw new TypeError('randomSource must return at least 10 bytes.');
  let body = '';
  for (let index = 0; index < 10; index += 1) body += TOKEN_ALPHABET[bytes[index] % TOKEN_ALPHABET.length];
  return `QD-${body}`;
}

export function createQuotationConfirmationToken({
  databasePath, quotationId, requestingUser, sourceChannel, sourceChat,
  sourceMessageReference = null, ttlMinutes = 15, now = new Date().toISOString(), tokenFactory = generateConfirmationToken
}) {
  const created = parseIsoInstant(now, 'now');
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) throw new RangeError('ttlMinutes must be from 1 to 1440.');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const draft = draftResult(database, quotationId);
      if (draft.snapshot.validationIssues.length > 0) throw new Error('Incomplete quotation drafts cannot request confirmation.');
      if (!['DRAFT', 'PENDING_CONFIRMATION'].includes(draft.status)) throw new Error('Quotation draft is not eligible for confirmation.');
      database.prepare(`
        UPDATE pending_confirmations SET status = 'INVALIDATED'
        WHERE draft_type = 'quotation' AND draft_id = ? AND status = 'PENDING'
      `).run(quotationId);
      const token = tokenFactory();
      if (typeof token !== 'string' || !/^QD-[A-Z2-9]{10}$/.test(token)) throw new TypeError('tokenFactory returned an invalid quotation token.');
      const expiresAt = new Date(created.valueOf() + ttlMinutes * 60000).toISOString();
      database.prepare(`
        INSERT INTO pending_confirmations (
          token, draft_type, draft_id, draft_hash, requesting_user, source_channel,
          source_chat, source_message_reference, status, expires_at, created_at
        ) VALUES (?, 'quotation', ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
      `).run(
        token, quotationId, draft.draftHash, requireText(requestingUser, 'requestingUser'),
        requireText(sourceChannel, 'sourceChannel'), requireText(sourceChat, 'sourceChat'),
        optionalText(sourceMessageReference), expiresAt, now
      );
      database.prepare("UPDATE quotations SET status = 'PENDING_CONFIRMATION' WHERE id = ?").run(quotationId);
      appendAudit(database, { now, actor: requestingUser, action: 'quotation.confirmation_requested', quotationId, afterHash: draft.draftHash, snapshot: draft.snapshot });
      return { token, quotationId, draftHash: draft.draftHash, status: 'PENDING', expiresAt };
    });
  } finally {
    database.close();
  }
}

export function inspectQuotationConfirmationToken({ databasePath, token, now = new Date().toISOString() }) {
  const currentTime = parseIsoInstant(now, 'now');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const confirmation = database.prepare(`
        SELECT * FROM pending_confirmations WHERE token = ? AND draft_type = 'quotation'
      `).get(requireText(token, 'token'));
      if (!confirmation) return { status: 'NOT_FOUND' };
      if (confirmation.status === 'PENDING') {
        const state = database.prepare('SELECT draft_hash FROM quotation_draft_state WHERE quotation_id = ?').get(confirmation.draft_id);
        let nextStatus = 'PENDING';
        if (!state || state.draft_hash !== confirmation.draft_hash) nextStatus = 'INVALIDATED';
        else if (currentTime.valueOf() >= new Date(confirmation.expires_at).valueOf()) nextStatus = 'EXPIRED';
        if (nextStatus !== 'PENDING') {
          database.prepare('UPDATE pending_confirmations SET status = ? WHERE id = ?').run(nextStatus, confirmation.id);
          confirmation.status = nextStatus;
        }
      }
      return {
        status: confirmation.status,
        quotationId: confirmation.draft_id,
        draftHash: confirmation.draft_hash,
        expiresAt: confirmation.expires_at
      };
    });
  } finally {
    database.close();
  }
}

function formatMinorUnits(amount, minorUnits = 2) {
  const digits = String(amount).padStart(minorUnits + 1, '0');
  const whole = digits.slice(0, -minorUnits || undefined).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return minorUnits === 0 ? whole : `${whole}.${digits.slice(-minorUnits)}`;
}

export function formatQuotationDraftPreview(draft, { token = null, minorUnits = 2 } = {}) {
  const snapshot = draft.snapshot;
  const lines = [
    'QUOTATION DRAFT — NOT ISSUED',
    `Draft version: ${draft.version}`,
    `Customer: ${snapshot.customer?.legalName ?? 'MISSING'}`,
    `Currency: ${snapshot.currency}`,
    `Issue date: ${snapshot.issueDate}`,
    `Valid until: ${snapshot.validUntil}`,
    '',
    ...snapshot.lineItems.map((line) => `${line.sequence}. ${line.description} | ${line.quantity} ${line.unit ?? ''} | ${snapshot.currency} ${formatMinorUnits(line.subtotalMinor, minorUnits)}`.trim()),
    '',
    `Subtotal: ${snapshot.currency} ${formatMinorUnits(snapshot.totals.subtotalMinor, minorUnits)}`,
    `Discount: ${snapshot.currency} ${formatMinorUnits(snapshot.totals.discountMinor, minorUnits)}`,
    `Tax: ${snapshot.currency} ${formatMinorUnits(snapshot.totals.taxMinor, minorUnits)}`,
    `TOTAL: ${snapshot.currency} ${formatMinorUnits(snapshot.totals.totalMinor, minorUnits)}`
  ];
  if (snapshot.validationIssues.length > 0) lines.push('', `Needs attention: ${snapshot.validationIssues.join(', ')}`);
  if (token) lines.push('', `Confirmation token: ${token}`);
  return lines.join('\n');
}
