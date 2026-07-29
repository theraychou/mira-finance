import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import {
  createQuotationConfirmationToken,
  createQuotationDraft,
  formatQuotationDraftPreview,
  inspectQuotationConfirmationToken,
  reviseQuotationDraft
} from '../../scripts/lib/quotation-drafts.mjs';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-f5-'));
  const databasePath = path.join(directory, 'finance.sqlite3');
  await migrateUp({ databasePath });
  const database = openDatabase(databasePath);
  const now = '2026-07-29T00:00:00.000Z';
  const entityId = Number(database.prepare(`
    INSERT INTO business_entities (legal_name, trading_name, default_currency, active, created_at, updated_at)
    VALUES ('Test Entity — TEST / NOT VALID', 'Test Entity', 'MYR', 1, ?, ?)
  `).run(now, now).lastInsertRowid);
  const customerId = Number(database.prepare(`
    INSERT INTO customers (
      customer_code, legal_name, display_name, billing_address, default_currency,
      default_payment_terms_days, active, created_at, updated_at
    ) VALUES ('TEST-001', 'Synthetic Customer — TEST / NOT VALID', 'Synthetic Customer',
      'TEST ADDRESS — NOT VALID', 'MYR', 30, 1, ?, ?)
  `).run(now, now).lastInsertRowid);
  database.prepare(`
    INSERT INTO bank_profiles (
      id, display_name, business_entity_id, currency, bank_name, account_name,
      account_number, active, created_at, updated_at
    ) VALUES ('test-myr-bank', 'TEST / NOT VALID', ?, 'MYR', 'TEST BANK',
      'TEST ACCOUNT', '0000000000', 1, ?, ?)
  `).run(entityId, now, now);
  database.prepare("UPDATE currencies SET default_bank_profile_id = 'test-myr-bank' WHERE code = 'MYR'").run();
  const taxRuleId = Number(database.prepare(`
    INSERT INTO tax_rules (
      country, name, code, rate_basis_points, calculation_method, display_label,
      effective_from, active, created_at, updated_at
    ) VALUES ('TEST', 'Synthetic tax — TEST / NOT VALID', 'test-tax', 600,
      'EXCLUSIVE', 'TEST TAX 6%', '2026-01-01', 1, ?, ?)
  `).run(now, now).lastInsertRowid);
  database.close();
  return { directory, databasePath, entityId, customerId, taxRuleId };
}

async function cleanupFixture(ids) {
  const database = openDatabase(ids.databasePath);
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  database.exec('PRAGMA journal_mode = DELETE');
  database.close();
  await rm(ids.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function input(ids, overrides = {}) {
  return {
    customer_id: ids.customerId,
    business_entity_id: ids.entityId,
    currency: 'MYR',
    issue_date: '2026-07-29',
    validity_days: 30,
    service_date: '2026-08-15',
    title: 'TEST / NOT VALID — Synthetic services',
    description: 'Synthetic quotation fixture',
    payment_terms: 'TEST terms only',
    notes: 'TEST / NOT VALID',
    source_channel: 'test',
    source_message_reference: 'test-message-1',
    line_items: [{ description: 'TEST service', quantity: '1', unit_price_minor: 10000, unit: 'lot' }],
    discount: { type: 'NONE' },
    tax: { mode: 'NONE' },
    ...overrides
  };
}

test('single and multiple-line drafts persist without consuming official numbers', async () => {
  const ids = await fixture();
  try {
    const single = createQuotationDraft({ databasePath: ids.databasePath, input: input(ids), actor: 'test-operator', now: '2026-07-29T01:00:00.000Z' });
    assert.equal(single.quotationNumber, null);
    assert.equal(single.version, 1);
    assert.equal(single.snapshot.totals.totalMinor, 10000);
    assert.deepEqual(single.snapshot.validationIssues, []);
    assert.match(formatQuotationDraftPreview(single), /^QUOTATION DRAFT — NOT ISSUED/);

    const revised = reviseQuotationDraft({
      databasePath: ids.databasePath,
      quotationId: single.id,
      input: input(ids, { line_items: [
        { description: 'TEST service A', quantity: '1.5', unit_price_minor: 10000, unit: 'hour' },
        { description: 'TEST service B', quantity: '2', unit_price_minor: 2500, unit: 'item' }
      ] }),
      actor: 'test-operator',
      now: '2026-07-29T01:01:00.000Z'
    });
    assert.equal(revised.version, 2);
    assert.equal(revised.snapshot.totals.totalMinor, 20000);
    const database = openDatabase(ids.databasePath);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM quotation_draft_versions WHERE quotation_id = ?').get(single.id).count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_numbers').get().count, 0);
    assert.throws(() => database.prepare('UPDATE quotation_draft_versions SET version = 9 WHERE quotation_id = ?').run(single.id), /immutable/);
    database.close();
  } finally {
    await cleanupFixture(ids);
  }
});

test('fixed discount, percentage discount, taxable and non-taxable drafts reconcile', async () => {
  const ids = await fixture();
  try {
    const fixed = createQuotationDraft({
      databasePath: ids.databasePath,
      input: input(ids, { discount: { type: 'FIXED', amount_minor: 1000 } }),
      actor: 'test-operator', now: '2026-07-29T02:00:00.000Z'
    });
    assert.deepEqual(fixed.snapshot.totals, { subtotalMinor: 10000, discountMinor: 1000, taxMinor: 0, totalMinor: 9000 });
    const taxable = createQuotationDraft({
      databasePath: ids.databasePath,
      input: input(ids, { discount: { type: 'PERCENTAGE', basis_points: 1000 }, tax: { mode: 'RULE', tax_rule_id: ids.taxRuleId } }),
      actor: 'test-operator', now: '2026-07-29T02:01:00.000Z'
    });
    assert.deepEqual(taxable.snapshot.totals, { subtotalMinor: 10000, discountMinor: 1000, taxMinor: 540, totalMinor: 9540 });
    assert.equal(taxable.snapshot.totals.subtotalMinor - taxable.snapshot.totals.discountMinor + taxable.snapshot.totals.taxMinor, taxable.snapshot.totals.totalMinor);
  } finally {
    await cleanupFixture(ids);
  }
});

test('missing customer data creates an incomplete draft and blocks confirmation', async () => {
  const ids = await fixture();
  try {
    const draft = createQuotationDraft({
      databasePath: ids.databasePath,
      input: input(ids, { customer_id: null }),
      actor: 'test-operator', now: '2026-07-29T03:00:00.000Z'
    });
    assert.ok(draft.snapshot.validationIssues.includes('missing_customer'));
    assert.throws(() => createQuotationConfirmationToken({
      databasePath: ids.databasePath, quotationId: draft.id, requestingUser: 'test-user',
      sourceChannel: 'test', sourceChat: 'test-chat', tokenFactory: () => 'QD-AAAAAAAAAA',
      now: '2026-07-29T03:01:00.000Z'
    }), /Incomplete/);
  } finally {
    await cleanupFixture(ids);
  }
});

test('confirmation tokens expire and draft changes invalidate old tokens', async () => {
  const ids = await fixture();
  try {
    const draft = createQuotationDraft({ databasePath: ids.databasePath, input: input(ids), actor: 'test-operator', now: '2026-07-29T04:00:00.000Z' });
    const first = createQuotationConfirmationToken({
      databasePath: ids.databasePath, quotationId: draft.id, requestingUser: 'test-user',
      sourceChannel: 'test', sourceChat: 'test-chat', ttlMinutes: 1,
      tokenFactory: () => 'QD-AAAAAAAAAA', now: '2026-07-29T04:01:00.000Z'
    });
    assert.equal(inspectQuotationConfirmationToken({ databasePath: ids.databasePath, token: first.token, now: '2026-07-29T04:02:00.000Z' }).status, 'EXPIRED');
    const second = createQuotationConfirmationToken({
      databasePath: ids.databasePath, quotationId: draft.id, requestingUser: 'test-user',
      sourceChannel: 'test', sourceChat: 'test-chat', ttlMinutes: 15,
      tokenFactory: () => 'QD-BBBBBBBBBB', now: '2026-07-29T04:03:00.000Z'
    });
    reviseQuotationDraft({
      databasePath: ids.databasePath, quotationId: draft.id,
      input: input(ids, { title: 'TEST / NOT VALID — Changed draft' }),
      actor: 'test-operator', now: '2026-07-29T04:04:00.000Z'
    });
    assert.equal(inspectQuotationConfirmationToken({ databasePath: ids.databasePath, token: second.token, now: '2026-07-29T04:05:00.000Z' }).status, 'INVALIDATED');
  } finally {
    await cleanupFixture(ids);
  }
});
