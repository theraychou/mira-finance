import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import { openDatabase } from '../../scripts/lib/database.mjs';
import {
  confirmWhatsAppInvoice, formatMinorAmount, parseMajorAmount, prepareWhatsAppInvoice
} from '../../scripts/lib/whatsapp-invoices.mjs';

const NOW = '2026-09-10T03:00:00.000Z';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-f18-'));
  const databasePath = path.join(root, 'finance.sqlite3');
  await migrateUp({ databasePath, now: () => NOW });
  const database = openDatabase(databasePath);
  const entityId = Number(database.prepare(`INSERT INTO business_entities
    (legal_name,trading_name,default_currency,active,created_at,updated_at)
    VALUES ('TEST Entity / NOT VALID','TEST Entity','MYR',1,?,?)`).run(NOW, NOW).lastInsertRowid);
  database.prepare(`INSERT INTO customers
    (customer_code,legal_name,display_name,billing_address,default_currency,default_payment_terms_days,tax_treatment,active,created_at,updated_at)
    VALUES ('TESTF18','TEST Customer / NOT VALID','TEST Customer','TEST ADDRESS / NOT VALID','MYR',14,'TEST NO TAX / NOT VALID',1,?,?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO bank_profiles
    (id,display_name,business_entity_id,currency,bank_name,account_name,account_number,active,created_at,updated_at)
    VALUES ('cimb-myr','TEST / NOT VALID',?,'MYR','TEST BANK','TEST ACCOUNT','0000000000',1,?,?)`).run(entityId, NOW, NOW);
  database.prepare("UPDATE currencies SET default_bank_profile_id='cimb-myr' WHERE code='MYR'").run();
  database.close();
  return { root, databasePath };
}

async function cleanup(value) {
  const database = openDatabase(value.databasePath);
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); database.exec('PRAGMA journal_mode=DELETE'); database.close();
  await rm(value.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function input(changes = {}) {
  return {
    customer: 'TESTF18', currency: 'MYR', issueDate: '2026-09-10', serviceDate: '2026-09-10',
    paymentTermsDays: 14, taxMode: 'NONE', notes: 'TEST / NOT VALID',
    lineItems: [
      { description: 'TEST AI Training / NOT VALID', quantity: '1', unitPrice: '10,000' },
      { description: 'TEST Transportation / NOT VALID', quantity: '1', unitPrice: '200.00' }
    ], ...changes
  };
}

test('major-unit strings convert without binary floating point', () => {
  assert.equal(parseMajorAmount('10,000', 2), 1000000);
  assert.equal(parseMajorAmount('200.05', 2), 20005);
  assert.equal(formatMinorAmount(1020000, 'MYR', 2), 'MYR 10,200.00');
  assert.throws(() => parseMajorAmount('1.001', 2), /too many decimal places/);
  assert.throws(() => parseMajorAmount('1,00,000', 2), /invalid thousands separators/);
});

test('Ray prepares an exact standalone invoice and confirms one immutable issuance', async () => {
  const value = await fixture();
  try {
    const prepared = prepareWhatsAppInvoice({ databasePath: value.databasePath, input: input(),
      requestingUser: 'whatsapp:test-ray', sourceChannel: 'whatsapp', sourceChat: 'group:test-finance',
      sourceMessageReference: 'tool:test-f18', tokenFactory: () => 'ID-CCCCCCCCCC', now: NOW });
    assert.equal(prepared.status, 'PENDING_CONFIRMATION');
    assert.equal(prepared.total, 'MYR 10,200.00');
    assert.equal(prepared.dueDate, '2026-09-24');
    assert.equal(prepared.clientInitials, 'TESTF18');
    assert.equal(prepared.confirmationToken, 'ID-CCCCCCCCCC');
    const before = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(before.prepare('SELECT invoice_number FROM invoices WHERE id=?').get(prepared.invoiceId).invoice_number, null);
    before.close();
    await assert.rejects(confirmWhatsAppInvoice({ databasePath: value.databasePath, token: prepared.confirmationToken,
      confirmingUser: 'whatsapp:wrong-user', sourceChannel: 'whatsapp', sourceChat: 'group:test-finance',
      outputRoot: path.join(value.root, 'generated'), testMode: true, now: '2026-09-10T03:01:00.000Z' }), /CONFIRMING_USER_MISMATCH/);
    const pdfText = '2609101001-TESTF18 RM 10,200.00 TEST / NOT VALID';
    const issued = await confirmWhatsAppInvoice({ databasePath: value.databasePath, token: prepared.confirmationToken,
      confirmingUser: 'whatsapp:test-ray', sourceChannel: 'whatsapp', sourceChat: 'group:test-finance',
      outputRoot: path.join(value.root, 'generated'), testMode: true,
      pdfConverter: async ({ pdfPath }) => writeFile(pdfPath, Buffer.from(`%PDF-1.4\n${pdfText}\n%%EOF`), { mode: 0o600 }),
      pdfInspector: async ({ pdfPath }) => ({ pageCount: 1, a4: true, text: await readFile(pdfPath, 'utf8') }),
      now: '2026-09-10T03:02:00.000Z' });
    assert.equal(issued.status, 'ISSUED');
    assert.equal(issued.invoiceNumber, '2609101001-TESTF18');
    assert.equal(issued.pdfReady, true);
    await assert.rejects(confirmWhatsAppInvoice({ databasePath: value.databasePath, token: prepared.confirmationToken,
      confirmingUser: 'whatsapp:test-ray', sourceChannel: 'whatsapp', sourceChat: 'group:test-finance' }), /CONFIRMATION_TOKEN_NOT_PENDING/);
  } finally { await cleanup(value); }
});

test('unknown or ambiguous customers and unsafe numbering initials fail before a draft is created', async () => {
  const value = await fixture();
  try {
    assert.throws(() => prepareWhatsAppInvoice({ databasePath: value.databasePath, input: input({ customer: 'NO-SUCH-CUSTOMER-999' }),
      requestingUser: 'whatsapp:test-ray', sourceChannel: 'whatsapp', sourceChat: 'group:test-finance', sourceMessageReference: 'tool:unknown' }), /CUSTOMER_NOT_FOUND/);
    assert.throws(() => prepareWhatsAppInvoice({ databasePath: value.databasePath, input: input({ clientInitials: '../BAD' }),
      requestingUser: 'whatsapp:test-ray', sourceChannel: 'whatsapp', sourceChat: 'group:test-finance', sourceMessageReference: 'tool:bad' }), /CLIENT_INITIALS_REQUIRED/);
    const database = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM invoices').get().count, 0); database.close();
  } finally { await cleanup(value); }
});
