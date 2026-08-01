import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import {
  confirmCustomerDelivery,
  createDeliveryContact,
  listDeliveryContacts,
  prepareCustomerDelivery
} from '../../scripts/lib/customer-delivery.mjs';

const NOW = '2026-08-01T00:00:00.000Z';
const LATER = '2026-08-01T00:01:00.000Z';
const NUMBER = '2608011001-TC';

const configuration = {
  enabled: true,
  defaultChannel: 'EMAIL',
  confirmationTtlMinutes: 15,
  email: { enabled: true, account: 'finance@example.test', client: 'mira-gmail-send', from: 'finance@example.test', replyTo: null },
  whatsApp: { enabled: true, account: null },
  signature: ['Mira — TEST / NOT VALID', 'Finance Manager', 'Test Entity — NOT VALID', 'www.example.test']
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-f17a-'));
  const databasePath = path.join(root, 'data', 'finance.sqlite3');
  await migrateUp({ databasePath, now: () => NOW });
  const pdfRelativePath = `2026/08/${NUMBER}.pdf`;
  const pdfPath = path.join(root, 'generated', 'invoices', pdfRelativePath);
  await mkdir(path.dirname(pdfPath), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from('%PDF-1.4\nTEST / NOT VALID\n%%EOF');
  await writeFile(pdfPath, bytes, { mode: 0o600 });
  const pdfSha256 = createHash('sha256').update(bytes).digest('hex');
  const database = openDatabase(databasePath);
  const entityId = Number(database.prepare(`INSERT INTO business_entities
    (legal_name,trading_name,default_currency,active,created_at,updated_at)
    VALUES ('Test Issuer — NOT VALID','Test','MYR',1,?,?)`).run(NOW, NOW).lastInsertRowid);
  const customerId = Number(database.prepare(`INSERT INTO customers
    (customer_code,legal_name,display_name,billing_address,default_currency,active,created_at,updated_at)
    VALUES ('TEST-CUSTOMER','Test Customer — NOT VALID','Test Customer','Test Address — NOT VALID','MYR',1,?,?)`).run(NOW, NOW).lastInsertRowid);
  const numberId = Number(database.prepare(`INSERT INTO document_numbers
    (document_type,sequence_date,sequence_value,client_initials,document_number,status,entity_id,allocated_at,updated_at)
    VALUES ('invoice','2026-08-01',1001,'TC',?,'ISSUED',1,?,?)`).run(NUMBER, NOW, NOW).lastInsertRowid);
  const confirmationId = Number(database.prepare(`INSERT INTO pending_confirmations
    (token,draft_type,draft_id,draft_hash,requesting_user,source_channel,source_chat,status,expires_at,created_at,confirmed_at)
    VALUES ('ID-TEST-F17A','invoice',1,?,'test-operator','test','test-chat','CONFIRMED','2026-08-01T01:00:00.000Z',?,?)`)
    .run('a'.repeat(64), NOW, NOW).lastInsertRowid);
  const invoiceId = Number(database.prepare(`INSERT INTO invoices
    (invoice_number,status,customer_id,business_entity_id,currency,issue_date,due_date,subtotal_minor,discount_minor,tax_minor,total_minor,
     amount_paid_minor,balance_due_minor,payment_status,created_by,confirmed_by,created_at,confirmed_at,issued_at,document_hash)
    VALUES (?,'ISSUED',?,?,'MYR','2026-08-01','2026-08-31',123456,0,0,123456,0,123456,'UNPAID','test-operator','test-operator',?,?,?,?)`)
    .run(NUMBER, customerId, entityId, NOW, NOW, NOW, pdfSha256).lastInsertRowid);
  database.prepare('UPDATE document_numbers SET entity_id=? WHERE id=?').run(invoiceId, numberId);
  database.prepare(`INSERT INTO invoice_issuances
    (invoice_id,document_number_id,confirmation_id,draft_version,draft_hash,status,attempt_count,docx_relative_path,pdf_relative_path,
     docx_sha256,pdf_sha256,issued_by,issued_at,created_at,updated_at)
    VALUES (?,?,?,1,?,'ISSUED',1,?,?,?,?,'test-operator',?,?,?)`).run(invoiceId, numberId, confirmationId, 'a'.repeat(64),
      `2026/08/${NUMBER}.docx`, pdfRelativePath, 'b'.repeat(64), pdfSha256, NOW, NOW, NOW);
  database.close();
  return { root, databasePath, customerId, invoiceId, pdfPath };
}

async function cleanup(value) { await rm(value.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }

test('verified contacts are masked and WhatsApp requires explicit consent', async () => {
  const value = await fixture();
  try {
    const email = createDeliveryContact({ databasePath: value.databasePath, actor: 'test-admin', now: NOW,
      contact: { customer_id: value.customerId, channel: 'EMAIL', destination: 'BILLING@EXAMPLE.TEST', contact_name: 'Test Contact' } });
    assert.equal(email.destination, 'b***@example.test');
    assert.throws(() => createDeliveryContact({ databasePath: value.databasePath, actor: 'test-admin', now: NOW,
      contact: { customer_id: value.customerId, channel: 'WHATSAPP', destination: '+15555550123' } }), /WHATSAPP_CONSENT_REQUIRED/);
    const whatsapp = createDeliveryContact({ databasePath: value.databasePath, actor: 'test-admin', now: NOW,
      contact: { customer_id: value.customerId, channel: 'WHATSAPP', destination: '+15555550123', consent_at: NOW, consent_source: 'TEST CONSENT / NOT VALID' } });
    assert.equal(whatsapp.destination, '+15***0123');
    assert.deepEqual(listDeliveryContacts({ databasePath: value.databasePath, customerId: value.customerId }).map((item) => item.channel), ['EMAIL', 'WHATSAPP']);
  } finally { await cleanup(value); }
});

test('email is the default and confirmation sends one unchanged PDF to the verified contact', async () => {
  const value = await fixture();
  try {
    const contact = createDeliveryContact({ databasePath: value.databasePath, actor: 'test-admin', now: NOW,
      contact: { customer_id: value.customerId, channel: 'EMAIL', destination: 'billing@example.test', contact_name: 'Test Contact' } });
    const prepared = await prepareCustomerDelivery({ databasePath: value.databasePath, root: value.root, configuration,
      documentType: 'invoice', documentNumber: NUMBER, contactId: contact.id, requestingUser: 'whatsapp:test-ray',
      sourceChannel: 'whatsapp', sourceChat: 'group:test-rc-finance', now: NOW, tokenFactory: () => 'DL-AAAAAAAAAAAAAAAA' });
    assert.equal(prepared.channel, 'EMAIL');
    assert.equal(prepared.destination, 'b***@example.test');
    assert.equal(prepared.amount, 'MYR 1,234.56');
    assert.equal(prepared.status, 'PENDING_CONFIRMATION');
    let sent;
    const emailClient = { send: async (payload) => { sent = payload; return { providerReference: 'TEST-PROVIDER-REFERENCE-NOT-VALID' }; } };
    await assert.rejects(() => confirmCustomerDelivery({ databasePath: value.databasePath, root: value.root, configuration, emailClient,
      token: prepared.token, confirmingUser: 'whatsapp:test-ray', sourceChannel: 'whatsapp', sourceChat: 'group:wrong', now: LATER }), /DELIVERY_CONFIRMATION_CONTEXT_MISMATCH/);
    const delivered = await confirmCustomerDelivery({ databasePath: value.databasePath, root: value.root, configuration, emailClient,
      token: prepared.token, confirmingUser: 'whatsapp:test-ray', sourceChannel: 'whatsapp', sourceChat: 'group:test-rc-finance', now: LATER });
    assert.equal(delivered.status, 'SENT');
    assert.equal(sent.to, 'billing@example.test');
    assert.equal(sent.attachmentPath, value.pdfPath);
    assert.match(sent.body, /TEST \/ NOT VALID/);
    await assert.rejects(() => confirmCustomerDelivery({ databasePath: value.databasePath, root: value.root, configuration, emailClient,
      token: prepared.token, confirmingUser: 'whatsapp:test-ray', sourceChannel: 'whatsapp', sourceChat: 'group:test-rc-finance', now: LATER }), /DELIVERY_TOKEN_NOT_PENDING/);
    const database = openDatabase(value.databasePath, { readOnly: true });
    const attempt = database.prepare('SELECT * FROM customer_delivery_attempts').get();
    const audit = database.prepare("SELECT details_json FROM audit_events WHERE action LIKE 'customer_delivery.%'").all().map((row) => row.details_json).join('\n');
    database.close();
    assert.equal(attempt.result, 'SENT');
    assert.equal(attempt.provider_reference_hash.length, 64);
    assert.doesNotMatch(audit, /billing@example|TEST-PROVIDER-REFERENCE/);
  } finally { await cleanup(value); }
});

test('WhatsApp delivery must be explicit, consent-bound, and hash verification fails closed', async () => {
  const value = await fixture();
  try {
    const contact = createDeliveryContact({ databasePath: value.databasePath, actor: 'test-admin', now: NOW,
      contact: { customer_id: value.customerId, channel: 'WHATSAPP', destination: '+15555550123', consent_at: NOW, consent_source: 'TEST CONSENT / NOT VALID' } });
    const prepared = await prepareCustomerDelivery({ databasePath: value.databasePath, root: value.root, configuration,
      documentType: 'invoice', documentNumber: NUMBER, channel: 'WHATSAPP', contactId: contact.id, requestingUser: 'whatsapp:test-ray',
      sourceChannel: 'whatsapp', sourceChat: 'group:test-rc-finance', now: NOW, tokenFactory: () => 'DL-BBBBBBBBBBBBBBBB' });
    await writeFile(value.pdfPath, '%PDF-1.4\nTAMPERED TEST / NOT VALID');
    let called = false;
    await assert.rejects(() => confirmCustomerDelivery({ databasePath: value.databasePath, root: value.root, configuration,
      whatsAppClient: { send: async () => { called = true; return { providerReference: 'TEST' }; } }, token: prepared.token,
      confirmingUser: 'whatsapp:test-ray', sourceChannel: 'whatsapp', sourceChat: 'group:test-rc-finance', now: LATER }), /ISSUED_ARTIFACT_HASH_MISMATCH/);
    assert.equal(called, false);
    const database = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT status FROM customer_delivery_requests WHERE id=?').get(prepared.requestId).status, 'FAILED');
    database.close();
  } finally { await cleanup(value); }
});
