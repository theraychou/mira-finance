import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import { createQuotationConfirmationToken, createQuotationDraft } from '../../scripts/lib/quotation-drafts.mjs';
import { issueConfirmedQuotation } from '../../scripts/lib/quotation-issuance.mjs';
import { assertAuthorizedWhatsAppCommandSource } from '../../scripts/lib/whatsapp-routing.mjs';

const NOW = '2026-07-30T00:00:00.000Z';
const GROUP_ID = '120000000000000000@g.us';
const RAY = '+601100000000';
const configuration = {
  group: { id: GROUP_ID, requireMention: false },
  authorizedSenders: [{ e164: RAY, permissions: ['draft', 'confirm'] }]
};

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-f10-'));
  const databasePath = path.join(directory, 'finance.sqlite3');
  await migrateUp({ databasePath, now: () => NOW });
  const database = openDatabase(databasePath);
  const entityId = Number(database.prepare(`
    INSERT INTO business_entities (legal_name, trading_name, default_currency, active, created_at, updated_at)
    VALUES ('TEST Entity — NOT VALID', 'TEST Entity', 'MYR', 1, ?, ?)
  `).run(NOW, NOW).lastInsertRowid);
  const customerId = Number(database.prepare(`
    INSERT INTO customers (customer_code, legal_name, display_name, billing_address, default_currency,
      default_payment_terms_days, active, created_at, updated_at)
    VALUES ('TEST-F10', 'TEST Customer — NOT VALID', 'TEST Customer', 'TEST ADDRESS — NOT VALID',
      'MYR', 30, 1, ?, ?)
  `).run(NOW, NOW).lastInsertRowid);
  database.prepare(`
    INSERT INTO bank_profiles (id, display_name, business_entity_id, currency, bank_name, account_name,
      account_number, active, created_at, updated_at)
    VALUES ('test-f10-bank', 'TEST / NOT VALID', ?, 'MYR', 'TEST BANK', 'TEST ACCOUNT',
      '0000000000', 1, ?, ?)
  `).run(entityId, NOW, NOW);
  database.prepare("UPDATE currencies SET default_bank_profile_id = 'test-f10-bank' WHERE code = 'MYR'").run();
  database.close();
  return { directory, databasePath, entityId, customerId };
}

async function cleanup(ids) {
  const database = openDatabase(ids.databasePath);
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  database.exec('PRAGMA journal_mode = DELETE');
  database.close();
  await rm(ids.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('Ray can create a TEST draft but a wrong user cannot confirm it', async () => {
  const ids = await fixture();
  try {
    const source = assertAuthorizedWhatsAppCommandSource({
      configuration,
      metadata: {
        channel: 'whatsapp', groupId: GROUP_ID, senderId: RAY,
        messageId: 'TEST-F10-MESSAGE', receivedAt: '2026-07-30T00:01:00.000Z'
      },
      permission: 'draft'
    });
    const draft = createQuotationDraft({
      databasePath: ids.databasePath,
      actor: source.actor,
      now: '2026-07-30T00:02:00.000Z',
      input: {
        customer_id: ids.customerId, business_entity_id: ids.entityId, currency: 'MYR',
        issue_date: '2026-07-30', validity_days: 14, service_date: '2026-08-15',
        title: 'TEST / NOT VALID — F10 routing draft', description: 'Synthetic routing test',
        payment_terms: 'TEST terms only', notes: 'TEST / NOT VALID',
        source_channel: source.sourceChannel, source_message_reference: source.sourceMessageReference,
        line_items: [{ description: 'TEST service — NOT VALID', quantity: '1', unit_price_minor: 10000, unit: 'lot' }],
        discount: { type: 'NONE' }, tax: { mode: 'NONE' }
      }
    });
    assert.equal(draft.quotationNumber, null);
    const confirmation = createQuotationConfirmationToken({
      databasePath: ids.databasePath, quotationId: draft.id, requestingUser: source.actor,
      sourceChannel: source.sourceChannel, sourceChat: source.sourceChat,
      sourceMessageReference: source.sourceMessageReference, tokenFactory: () => 'QD-FFFFFFFFFF',
      now: '2026-07-30T00:03:00.000Z'
    });
    await assert.rejects(issueConfirmedQuotation({
      databasePath: ids.databasePath, token: confirmation.token,
      confirmingUser: 'whatsapp:unauthorised-test-user', sourceChannel: source.sourceChannel,
      sourceChat: source.sourceChat, clientInitials: 'TC', outputRoot: path.join(ids.directory, 'outputs'),
      testMode: true, now: '2026-07-30T00:04:00.000Z'
    }), /CONFIRMING_USER_MISMATCH/);
    const database = openDatabase(ids.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_numbers').get().count, 0);
    assert.equal(database.prepare('SELECT status FROM pending_confirmations WHERE token = ?').get(confirmation.token).status, 'PENDING');
    database.close();
  } finally {
    await cleanup(ids);
  }
});
