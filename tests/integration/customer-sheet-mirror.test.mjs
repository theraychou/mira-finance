import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { buildCustomerSheetValues, syncCustomerSheetMirror } from '../../scripts/lib/customer-sheet-mirror.mjs';

const NOW = '2026-09-10T05:00:00.000Z';
const configuration = { enabled: true, folderId: 'TEST_FOLDER_123456', spreadsheetTitle: 'Mira Customer Register', sheetName: 'Customers' };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-f19-sheet-')); const databasePath = path.join(root, 'finance.sqlite3');
  await migrateUp({ databasePath, now: () => NOW });
  const database = openDatabase(databasePath);
  database.prepare(`INSERT INTO customers
    (customer_code,legal_name,display_name,registration_number,billing_address,billing_contact_name,billing_email,billing_phone,
     default_currency,default_payment_terms_days,tax_treatment,purchase_order_required,active,notes,created_at,updated_at)
    VALUES ('TESTF19','TEST Customer / NOT VALID','TEST Customer / NOT VALID','TEST-REG-NOT-VALID','TEST ADDRESS / NOT VALID',
      'TEST CONTACT / NOT VALID','test@example.invalid','+60000000000','MYR',14,'TEST NO TAX / NOT VALID',0,1,'TEST / NOT VALID',?,?)`).run(NOW, NOW);
  database.close(); return { root, databasePath };
}
async function cleanup(value) { const db = openDatabase(value.databasePath); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); await rm(value.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }

function fakeClient({ failUpdate = false } = {}) {
  const calls = [];
  return { calls,
    async createSpreadsheet(input) { calls.push(['create', input]); return { id: 'TEST_SHEET_123456' }; },
    async moveToFolder(input) { calls.push(['move', input]); return { id: input.spreadsheetId, parents: [input.folderId] }; },
    async updateValues(input) { calls.push(['update', input]); if (failUpdate) throw Object.assign(new Error('SHEETS_TRANSIENT_FAILURE'), { code: 'SHEETS_TRANSIENT_FAILURE' }); },
    async clearValues(input) { calls.push(['clear', input]); }, async format(input) { calls.push(['format', input]); },
    async freeze(input) { calls.push(['freeze', input]); }, async autoResize(input) { calls.push(['resize', input]); }
  };
}

test('customer mirror creates one ledger-owned Sheet view and records deterministic sync state', async () => {
  const value = await fixture();
  try {
    const client = fakeClient();
    const result = await syncCustomerSheetMirror({ databasePath: value.databasePath, configuration, client, actor: 'TEST-OPERATOR', now: NOW });
    assert.equal(result.status, 'SYNCED'); assert.equal(result.rowCount, 1); assert.match(result.spreadsheetUrl, /TEST_SHEET_123456/);
    const update = client.calls.find(([name]) => name === 'update')[1];
    assert.equal(update.values[0][0], 'Mira Customer Register'); assert.match(update.values[1][0], /READ ONLY MIRROR/);
    assert.deepEqual(update.values[3].slice(0, 4), ['Customer code', 'Legal name', 'Display name', 'Aliases']);
    assert.equal(update.values[4][0], 'TESTF19'); assert.equal(update.values[4][15], 'TEST / NOT VALID'); assert.equal(update.values[4][16], 'READY');
    const database = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT status FROM customer_sheet_mirror_state WHERE id=1').get().status, 'SYNCED');
    assert.equal(database.prepare('SELECT result FROM customer_sheet_sync_attempts').get().result, 'SUCCEEDED'); database.close();
    const unchanged = await syncCustomerSheetMirror({ databasePath: value.databasePath, configuration, client, actor: 'TEST-OPERATOR', now: '2026-09-10T05:01:00.000Z' });
    assert.equal(unchanged.status, 'UNCHANGED');
  } finally { await cleanup(value); }
});

test('mirror failure is redacted, recorded, and leaves the customer ledger intact', async () => {
  const value = await fixture();
  try {
    const result = await syncCustomerSheetMirror({ databasePath: value.databasePath, configuration,
      client: fakeClient({ failUpdate: true }), actor: 'TEST-OPERATOR', now: NOW });
    assert.deepEqual({ status: result.status, errorCode: result.errorCode, rowCount: result.rowCount },
      { status: 'FAILED', errorCode: 'SHEETS_TRANSIENT_FAILURE', rowCount: 1 });
    const database = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM customers').get().count, 1);
    assert.equal(database.prepare('SELECT result FROM customer_sheet_sync_attempts').get().result, 'FAILED'); database.close();
  } finally { await cleanup(value); }
});

test('Sheet values use one simple tabular view with no formulas or write-back fields', () => {
  const values = buildCustomerSheetValues([{ customer_code: 'TEST', legal_name: 'TEST / NOT VALID', display_name: 'TEST / NOT VALID', aliases: [],
    registration_number: null, tax_registration_number: null, billing_address: 'TEST / NOT VALID', billing_contact_name: null,
    billing_email: null, billing_phone: null, default_currency: 'MYR', default_payment_terms_days: 14,
    tax_treatment: 'TEST / NOT VALID', purchase_order_required: 0, active: 1, notes: 'TEST / NOT VALID', created_at: NOW, updated_at: NOW }], NOW);
  assert.equal(values.length, 5); assert.equal(values.every((row) => row.length === 19), true);
  assert.equal(values.flat().some((cell) => typeof cell === 'string' && cell.startsWith('=')), false);
});
