import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import { confirmEscalationReply, prepareEscalationReply, processInboundCustomerMessage } from '../../scripts/lib/customer-inbound.mjs';

const NOW = '2026-08-02T00:00:00.000Z';
const configuration = {
  enabled: true, autoReply: true, confirmationTtlMinutes: 15, maxMessageCharacters: 8000,
  email: { enabled: true }, whatsApp: { enabled: true }
};
const signature = ['Mira Karkova — TEST / NOT VALID', 'Finance Manager', 'Test Entity — NOT VALID'];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-f17b-')); const databasePath = path.join(root, 'finance.sqlite3');
  await migrateUp({ databasePath, now: () => NOW }); const db = openDatabase(databasePath);
  const customerId = Number(db.prepare(`INSERT INTO customers
    (customer_code,legal_name,display_name,default_currency,active,created_at,updated_at)
    VALUES ('TEST-CUSTOMER','Test Customer — NOT VALID','Test Customer','MYR',1,?,?)`).run(NOW, NOW).lastInsertRowid);
  const emailId = Number(db.prepare(`INSERT INTO customer_delivery_contacts
    (customer_id,channel,destination,normalized_destination,verified_at,verified_by,active,created_at,updated_at)
    VALUES (?,'EMAIL','billing@example.test','billing@example.test',?,'test-admin',1,?,?)`).run(customerId, NOW, NOW, NOW).lastInsertRowid);
  db.prepare(`INSERT INTO customer_delivery_contacts
    (customer_id,channel,destination,normalized_destination,verified_at,verified_by,consent_at,consent_source,active,created_at,updated_at)
    VALUES (?,'WHATSAPP','+15555550123','+15555550123',?,'test-admin',?,'TEST CONSENT / NOT VALID',1,?,?)`).run(customerId, NOW, NOW, NOW, NOW);
  db.prepare(`INSERT INTO invoices
    (invoice_number,status,customer_id,currency,issue_date,due_date,subtotal_minor,total_minor,amount_paid_minor,balance_due_minor,payment_status,created_by,created_at,issued_at)
    VALUES ('2608021001-TC','ISSUED',?,'MYR','2026-08-02','2026-09-01',123456,123456,20000,103456,'PARTIALLY_PAID','test',?,?)`).run(customerId, NOW, NOW);
  db.prepare(`INSERT INTO quotations
    (quotation_number,status,customer_id,currency,issue_date,valid_until,subtotal_minor,total_minor,created_by,created_at,issued_at)
    VALUES ('2608021002-TC','ISSUED',?,'SGD','2026-08-02','2026-09-01',50000,50000,'test',?,?)`).run(customerId, NOW, NOW);
  db.close(); return { root, databasePath, customerId, emailId };
}

test('verified exact-document question receives only deterministic ledger facts and deduplicates', async () => {
  const value = await fixture();
  try {
    let payload; const client = { reply: async (item) => { payload = item; return { providerReference: 'TEST-REPLY-ID' }; } };
    const first = await processInboundCustomerMessage({ databasePath: value.databasePath, configuration, channel: 'EMAIL',
      sender: 'Test Contact <billing@example.test>', providerMessageId: 'TEST-MESSAGE-1', providerThreadId: 'TEST-THREAD-1',
      subject: 'Invoice status — TEST / NOT VALID', body: 'What is the outstanding balance for 2608021001-TC?', receivedAt: NOW,
      responseClient: client, signature, now: NOW });
    assert.equal(first.status, 'AUTO_REPLIED');
    assert.match(payload.body, /MYR 1,034\.56/); assert.match(payload.body, /PARTIALLY_PAID/); assert.match(payload.body, /TEST \/ NOT VALID/);
    const duplicate = await processInboundCustomerMessage({ databasePath: value.databasePath, configuration, channel: 'EMAIL',
      sender: 'billing@example.test', providerMessageId: 'TEST-MESSAGE-1', body: 'What is the balance for 2608021001-TC?', receivedAt: NOW, responseClient: client });
    assert.equal(duplicate.duplicate, true);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
test('unknown and attachment-bearing questions escalate and Ray reply requires confirmation', async () => {
  const value = await fixture();
  try {
    let alert; const notifier = { notify: async (item) => { alert = item.body; return { providerReference: 'TEST-ALERT' }; } };
    const ackClient = { reply: async () => ({ providerReference: 'TEST-ACK' }) };
    const escalated = await processInboundCustomerMessage({ databasePath: value.databasePath, configuration, channel: 'EMAIL',
      sender: 'billing@example.test', providerMessageId: 'TEST-MESSAGE-2', subject: 'Question', body: 'Can you change our bank details?',
      receivedAt: NOW, hasAttachments: true, responseClient: ackClient, escalationClient: notifier, signature, now: NOW,
      escalationTokenFactory: () => 'ES-AAAAAAAAAAAAAAAA' });
    assert.equal(escalated.status, 'ESCALATED'); assert.match(alert, /ES-AAAAAAAAAAAAAAAA/); assert.doesNotMatch(alert, /billing@example\.test/);
    const prepared = prepareEscalationReply({ databasePath: value.databasePath, token: escalated.escalationToken,
      response: 'Ray has reviewed this request. TEST / NOT VALID', requestingUser: 'whatsapp:test-ray', sourceChannel: 'whatsapp',
      sourceChat: 'group:test-finance', now: NOW, signature, confirmationTokenFactory: () => 'RR-BBBBBBBBBBBBBBBB' });
    assert.equal(prepared.destination, 'b***@example.test');
    await assert.rejects(() => confirmEscalationReply({ databasePath: value.databasePath, confirmationToken: prepared.confirmationToken,
      confirmingUser: 'whatsapp:wrong', sourceChannel: 'whatsapp', sourceChat: 'group:test-finance', emailClient: ackClient, now: NOW }), /CONTEXT_MISMATCH/);
    let final; const finalClient = { reply: async (item) => { final = item; return { providerReference: 'TEST-FINAL' }; } };
    const confirmed = await confirmEscalationReply({ databasePath: value.databasePath, confirmationToken: prepared.confirmationToken,
      confirmingUser: 'whatsapp:test-ray', sourceChannel: 'whatsapp', sourceChat: 'group:test-finance', emailClient: finalClient, now: NOW });
    assert.equal(confirmed.status, 'RESOLVED'); assert.equal(final.body, prepared.response);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('unverified sender is ignored without disclosure or reply', async () => {
  const value = await fixture();
  try {
    let replied = false;
    const result = await processInboundCustomerMessage({ databasePath: value.databasePath, configuration, channel: 'WHATSAPP',
      sender: '+15555559999', providerMessageId: 'TEST-UNKNOWN', body: 'Status of 2608021001-TC?', receivedAt: NOW,
      responseClient: { reply: async () => { replied = true; } }, now: NOW });
    assert.deepEqual(result, { handled: false, status: 'UNVERIFIED_SENDER' }); assert.equal(replied, false);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
