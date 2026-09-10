import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import { openDatabase } from '../../scripts/lib/database.mjs';
import {
  confirmWhatsAppCustomerChange, listWhatsAppCustomers, prepareWhatsAppCustomerChange
} from '../../scripts/lib/whatsapp-customers.mjs';

const NOW = '2026-09-10T04:00:00.000Z';
const context = { requestingUser: 'whatsapp:TEST-RAY', sourceChannel: 'whatsapp', sourceChat: 'group:TEST-RC-FINANCE', sourceMessageReference: 'tool:TEST' };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-f19-customers-'));
  const databasePath = path.join(root, 'finance.sqlite3');
  await migrateUp({ databasePath, now: () => NOW });
  return { root, databasePath };
}

async function cleanup(value) {
  const database = openDatabase(value.databasePath); database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); database.close();
  await rm(value.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const fields = (changes = {}) => ({
  legalName: 'TEST Customer Sdn Bhd / NOT VALID', displayName: 'TEST Customer / NOT VALID',
  registrationNumber: 'TEST-REG-NOT-VALID', taxRegistrationNumber: null,
  billingAddress: 'TEST BILLING ADDRESS / NOT VALID', billingContactName: 'TEST CONTACT / NOT VALID',
  billingEmail: 'test@example.invalid', billingPhone: '+60000000000', defaultCurrency: 'MYR',
  defaultPaymentTermsDays: 14, taxTreatment: 'TEST NO TAX / NOT VALID', purchaseOrderRequired: false,
  notes: 'TEST / NOT VALID', ...changes
});

test('Ray creates, lists, modifies, and deactivates a customer only after exact confirmations', async () => {
  const value = await fixture();
  try {
    const create = prepareWhatsAppCustomerChange({ databasePath: value.databasePath,
      input: { operation: 'CREATE', customerCode: 'TESTF19', fields: fields() }, ...context,
      tokenFactory: () => 'CU-ABCDEFGHJK', now: NOW });
    assert.equal(create.status, 'PENDING_CONFIRMATION');
    assert.equal(create.readiness.ready, true);
    let database = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM customers').get().count, 0); database.close();
    assert.throws(() => confirmWhatsAppCustomerChange({ databasePath: value.databasePath, token: create.confirmationToken,
      confirmingUser: 'whatsapp:OTHER', sourceChannel: context.sourceChannel, sourceChat: context.sourceChat,
      now: '2026-09-10T04:01:00.000Z' }), /CUSTOMER_CONFIRMING_USER_MISMATCH/);
    const created = confirmWhatsAppCustomerChange({ databasePath: value.databasePath, token: create.confirmationToken,
      confirmingUser: context.requestingUser, sourceChannel: context.sourceChannel, sourceChat: context.sourceChat,
      now: '2026-09-10T04:01:00.000Z' });
    assert.equal(created.customer.customerCode, 'TESTF19'); assert.equal(created.customer.active, true);
    const listed = listWhatsAppCustomers({ databasePath: value.databasePath });
    assert.equal(listed.totalMatches, 1); assert.equal(listed.customers[0].readiness.ready, true);
    assert.equal(Object.hasOwn(listed.customers[0], 'billingEmail'), false);

    const update = prepareWhatsAppCustomerChange({ databasePath: value.databasePath,
      input: { operation: 'UPDATE', customerCode: 'TESTF19', fields: { defaultPaymentTermsDays: 30 } }, ...context,
      tokenFactory: () => 'CU-KJHGFEDCBA', now: '2026-09-10T04:02:00.000Z' });
    const updated = confirmWhatsAppCustomerChange({ databasePath: value.databasePath, token: update.confirmationToken,
      confirmingUser: context.requestingUser, sourceChannel: context.sourceChannel, sourceChat: context.sourceChat,
      now: '2026-09-10T04:03:00.000Z' });
    assert.equal(updated.customer.defaultPaymentTermsDays, 30);

    const remove = prepareWhatsAppCustomerChange({ databasePath: value.databasePath,
      input: { operation: 'DEACTIVATE', customerCode: 'TESTF19' }, ...context,
      tokenFactory: () => 'CU-23456789AB', now: '2026-09-10T04:04:00.000Z' });
    const removed = confirmWhatsAppCustomerChange({ databasePath: value.databasePath, token: remove.confirmationToken,
      confirmingUser: context.requestingUser, sourceChannel: context.sourceChannel, sourceChat: context.sourceChat,
      now: '2026-09-10T04:05:00.000Z' });
    assert.equal(removed.customer.active, false);
    assert.equal(listWhatsAppCustomers({ databasePath: value.databasePath }).totalMatches, 0);
    assert.equal(listWhatsAppCustomers({ databasePath: value.databasePath, status: 'INACTIVE' }).totalMatches, 1);
    database = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE entity_type='customer'").get().count, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM customer_change_requests WHERE status='CONFIRMED'").get().count, 3);
    database.close();
  } finally { await cleanup(value); }
});

test('duplicate, incomplete, expired, and stale customer changes fail closed', async () => {
  const value = await fixture();
  try {
    assert.throws(() => prepareWhatsAppCustomerChange({ databasePath: value.databasePath,
      input: { operation: 'CREATE', customerCode: 'TESTF19', fields: { displayName: 'TEST / NOT VALID' } }, ...context,
      now: NOW }), /CUSTOMER_REQUIRED_LEGAL_NAME/);
    const first = prepareWhatsAppCustomerChange({ databasePath: value.databasePath,
      input: { operation: 'CREATE', customerCode: 'TESTF19', fields: fields() }, ...context,
      tokenFactory: () => 'CU-ABCDEFGHJK', now: NOW });
    confirmWhatsAppCustomerChange({ databasePath: value.databasePath, token: first.confirmationToken,
      confirmingUser: context.requestingUser, sourceChannel: context.sourceChannel, sourceChat: context.sourceChat,
      now: '2026-09-10T04:01:00.000Z' });
    assert.throws(() => prepareWhatsAppCustomerChange({ databasePath: value.databasePath,
      input: { operation: 'CREATE', customerCode: 'TESTF20', fields: fields() }, ...context,
      now: '2026-09-10T04:02:00.000Z' }), /CUSTOMER_NAME_ALREADY_EXISTS/);
    const expiring = prepareWhatsAppCustomerChange({ databasePath: value.databasePath,
      input: { operation: 'UPDATE', customerCode: 'TESTF19', fields: { billingPhone: '+61111111111' } }, ...context,
      confirmationTtlMinutes: 1, tokenFactory: () => 'CU-KJHGFEDCBA', now: '2026-09-10T04:02:00.000Z' });
    assert.deepEqual(confirmWhatsAppCustomerChange({ databasePath: value.databasePath, token: expiring.confirmationToken,
      confirmingUser: context.requestingUser, sourceChannel: context.sourceChannel, sourceChat: context.sourceChat,
      now: '2026-09-10T04:03:00.000Z' }), { rejectedCode: 'CUSTOMER_CONFIRMATION_EXPIRED' });
    const tampered = prepareWhatsAppCustomerChange({ databasePath: value.databasePath,
      input: { operation: 'UPDATE', customerCode: 'TESTF19', fields: { billingPhone: '+63333333333' } }, ...context,
      tokenFactory: () => 'CU-ZYXWVUTSRQ', now: '2026-09-10T04:03:10.000Z' });
    let database = openDatabase(value.databasePath); database.prepare("UPDATE customer_change_requests SET payload_json='{}' WHERE token=?").run(tampered.confirmationToken); database.close();
    assert.deepEqual(confirmWhatsAppCustomerChange({ databasePath: value.databasePath, token: tampered.confirmationToken,
      confirmingUser: context.requestingUser, sourceChannel: context.sourceChannel, sourceChat: context.sourceChat,
      now: '2026-09-10T04:03:20.000Z' }), { rejectedCode: 'CUSTOMER_CONFIRMATION_HASH_MISMATCH' });
    const stale = prepareWhatsAppCustomerChange({ databasePath: value.databasePath,
      input: { operation: 'UPDATE', customerCode: 'TESTF19', fields: { billingPhone: '+62222222222' } }, ...context,
      tokenFactory: () => 'CU-23456789AB', now: '2026-09-10T04:04:00.000Z' });
    database = openDatabase(value.databasePath); database.prepare("UPDATE customers SET notes='TEST CHANGED / NOT VALID' WHERE customer_code='TESTF19'").run(); database.close();
    assert.deepEqual(confirmWhatsAppCustomerChange({ databasePath: value.databasePath, token: stale.confirmationToken,
      confirmingUser: context.requestingUser, sourceChannel: context.sourceChannel, sourceChat: context.sourceChat,
      now: '2026-09-10T04:05:00.000Z' }), { rejectedCode: 'CUSTOMER_RECORD_CHANGED' });
  } finally { await cleanup(value); }
});

test('customer changes are blocked while a document is awaiting confirmation or generation', async () => {
  const value = await fixture();
  try {
    const create = prepareWhatsAppCustomerChange({ databasePath: value.databasePath,
      input: { operation: 'CREATE', customerCode: 'TESTF19', fields: fields() }, ...context,
      tokenFactory: () => 'CU-ABCDEFGHJK', now: NOW });
    confirmWhatsAppCustomerChange({ databasePath: value.databasePath, token: create.confirmationToken,
      confirmingUser: context.requestingUser, sourceChannel: context.sourceChannel, sourceChat: context.sourceChat,
      now: '2026-09-10T04:01:00.000Z' });
    const database = openDatabase(value.databasePath); const customer = database.prepare("SELECT id FROM customers WHERE customer_code='TESTF19'").get();
    database.prepare("INSERT INTO invoices (status,customer_id,created_by,created_at) VALUES ('PENDING_CONFIRMATION',?,'TEST / NOT VALID',?)").run(customer.id, NOW); database.close();
    assert.throws(() => prepareWhatsAppCustomerChange({ databasePath: value.databasePath,
      input: { operation: 'UPDATE', customerCode: 'TESTF19', fields: { defaultPaymentTermsDays: 30 } }, ...context,
      now: '2026-09-10T04:02:00.000Z' }), /CUSTOMER_HAS_PENDING_DOCUMENT_WORKFLOW/);
  } finally { await cleanup(value); }
});
