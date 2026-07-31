import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { createSupplier, resolveSupplier } from '../../scripts/lib/supplier-registry.mjs';
import {
  approveAndFileSupplierInvoice, createSupplierInvoiceDraft, getSupplierInvoiceRegister,
  requestSupplierInvoiceApproval, reviseSupplierInvoiceDraft
} from '../../scripts/lib/supplier-invoice-workflow.mjs';

const now = '2026-07-31T04:00:00.000Z';
const later = '2026-07-31T04:01:00.000Z';
const operator = 'test-ray';

async function environment() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-f13-'));
  const databasePath = path.join(root, 'data', 'finance.sqlite3');
  await migrateUp({ databasePath, now: () => now });
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'data', 'supplier-invoices', 'inbox'), { recursive: true });
  await mkdir(path.join(root, 'data', 'supplier-invoices', 'originals'), { recursive: true });
  await writeFile(path.join(root, 'config', 'claim-categories.json'), JSON.stringify({
    schemaVersion: 1,
    categories: [
      { id: 'software', label: 'Software', terms: ['software'] },
      { id: 'other', label: 'Other', terms: [] }
    ]
  }));
  await writeFile(path.join(root, 'config', 'drive-folders.json'), JSON.stringify({
    schemaVersion: 1, identity: 'test@example.invalid', client: 'test-client',
    rootFolderId: 'TEST_ROOT_FOLDER_12345',
    destinations: { quotation: 'TEST_ROOT_FOLDER_12345', invoice: 'TEST_ROOT_FOLDER_12345' }
  }));
  const supplier = createSupplier({
    databasePath, actor: operator, now,
    supplier: { supplier_code: 'TEST-SUPPLIER', display_name: 'TEST SUPPLIER / NOT VALID', default_currency: 'MYR' },
    aliases: ['TEST SOFTWARE VENDOR']
  });
  return { root, databasePath, supplier };
}
async function attachment(root, name, marker = name) {
  const candidate = path.join(root, 'data', 'supplier-invoices', 'inbox', name);
  await writeFile(candidate, Buffer.from(`%PDF-1.4\n% TEST / NOT VALID\n${marker}\n`));
  return candidate;
}
function completeFields(supplierId, overrides = {}) {
  return {
    supplierId,
    supplierInvoiceNumber: 'TEST-SI-1001',
    issueDate: '2026-07-31',
    dueDate: '2026-08-30',
    expenseCategory: 'software',
    projectAllocation: 'TEST PROJECT / NOT VALID',
    currency: 'MYR',
    subtotalMinor: 12345,
    taxMinor: 0,
    totalMinor: 12345,
    description: 'TEST SOFTWARE / NOT VALID',
    ...overrides
  };
}
function fakeDrive(size) {
  const metadata = {
    id: 'TEST_DRIVE_FILE', name: 'supplier-invoice-1-source.pdf',
    size, parents: ['TEST_ROOT_FOLDER_12345'], md5Checksum: null
  };
  return {
    async findByName() { return []; },
    async uploadFile() { return metadata; },
    async getMetadata() { return metadata; }
  };
}

test('incoming classification is mandatory and never creates an outgoing invoice', async () => {
  const value = await environment();
  try {
    const sourcePath = await attachment(value.root, 'classification.pdf');
    await assert.rejects(() => createSupplierInvoiceDraft({
      databasePath: value.databasePath, sourcePath, declaredClassification: 'OUTGOING_INVOICE',
      actor: operator, advisoryText: 'TEST SUPPLIER INVOICE / NOT VALID', advisoryFields: completeFields(value.supplier.id),
      root: value.root, now
    }), /CLASSIFICATION_REQUIRED/);
    const database = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM invoices').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM supplier_invoices').get().count, 0);
    database.close();
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('a complete supplier invoice is approved, Drive-filed, and registered separately', async () => {
  const value = await environment();
  try {
    const sourcePath = await attachment(value.root, 'complete.pdf');
    const draft = await createSupplierInvoiceDraft({
      databasePath: value.databasePath, sourcePath, declaredClassification: 'SUPPLIER_INVOICE',
      actor: operator, advisoryText: 'TEST SUPPLIER INVOICE NO TEST-SI-1001 / NOT VALID',
      advisoryFields: completeFields(value.supplier.id), root: value.root, now
    });
    assert.deepEqual(draft.snapshot.validationIssues, []);
    const approval = requestSupplierInvoiceApproval({
      databasePath: value.databasePath, supplierInvoiceId: draft.id, requestingUser: operator,
      authorisedUser: operator, sourceChannel: 'test', sourceChat: 'test-chat', now
    });
    const size = (await readFile(path.join(value.root, 'data', 'supplier-invoices', 'originals', draft.snapshot.document.storageRelativePath))).length;
    const filed = await approveAndFileSupplierInvoice({
      databasePath: value.databasePath, token: approval.token, approvingUser: operator,
      authorisedUser: operator, root: value.root, now: later, driveClient: fakeDrive(size)
    });
    assert.deepEqual(filed, { supplierInvoiceId: 1, status: 'FILED', driveFiled: true });
    const register = getSupplierInvoiceRegister({ databasePath: value.databasePath });
    assert.equal(register.length, 1);
    assert.equal(register[0].supplier_invoice_number, 'TEST-SI-1001');
    assert.equal(register[0].source_filed, 1);
    const database = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM invoices').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_numbers').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM supplier_invoice_filing_attempts').get().count, 1);
    database.close();
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('exact documents are blocked and probable duplicates require resolution', async () => {
  const value = await environment();
  try {
    const firstPath = await attachment(value.root, 'first.pdf', 'first');
    const first = await createSupplierInvoiceDraft({
      databasePath: value.databasePath, sourcePath: firstPath, declaredClassification: 'SUPPLIER_INVOICE',
      actor: operator, advisoryText: 'TEST / NOT VALID', advisoryFields: completeFields(value.supplier.id), root: value.root, now
    });
    const exact = await createSupplierInvoiceDraft({
      databasePath: value.databasePath, sourcePath: firstPath, declaredClassification: 'SUPPLIER_INVOICE',
      actor: operator, advisoryText: 'TEST / NOT VALID', advisoryFields: completeFields(value.supplier.id), root: value.root, now: later
    });
    assert.deepEqual(exact, { status: 'EXACT_DUPLICATE', existingSupplierInvoiceId: first.id });
    const secondPath = await attachment(value.root, 'second.pdf', 'second');
    const probable = await createSupplierInvoiceDraft({
      databasePath: value.databasePath, sourcePath: secondPath, declaredClassification: 'SUPPLIER_INVOICE',
      actor: operator, advisoryText: 'TEST / NOT VALID',
      advisoryFields: completeFields(value.supplier.id, { supplierInvoiceNumber: 'TEST-SI-1002' }),
      root: value.root, now: later
    });
    assert.equal(probable.snapshot.probableDuplicate.supplierInvoiceId, first.id);
    assert.throws(() => requestSupplierInvoiceApproval({
      databasePath: value.databasePath, supplierInvoiceId: probable.id, requestingUser: operator,
      authorisedUser: operator, sourceChannel: 'test', sourceChat: 'test', now: later
    }), /PROBABLE_DUPLICATE/);
    const reviewed = await reviseSupplierInvoiceDraft({
      databasePath: value.databasePath, supplierInvoiceId: probable.id,
      fields: { probableDuplicateReviewed: true }, actor: operator, root: value.root,
      now: '2026-07-31T04:02:00.000Z'
    });
    assert.equal(reviewed.snapshot.fields.probableDuplicateReviewed, true);
    assert.doesNotThrow(() => requestSupplierInvoiceApproval({
      databasePath: value.databasePath, supplierInvoiceId: probable.id, requestingUser: operator,
      authorisedUser: operator, sourceChannel: 'test', sourceChat: 'test',
      now: '2026-07-31T04:02:00.000Z'
    }));
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('missing due date blocks approval until revision and wrong users cannot approve', async () => {
  const value = await environment();
  try {
    const sourcePath = await attachment(value.root, 'revise.pdf');
    const draft = await createSupplierInvoiceDraft({
      databasePath: value.databasePath, sourcePath, declaredClassification: 'SUPPLIER_INVOICE',
      actor: operator, advisoryText: 'TEST / NOT VALID',
      advisoryFields: completeFields(value.supplier.id, { dueDate: null }), root: value.root, now
    });
    assert.ok(draft.snapshot.validationIssues.includes('missing_due_date'));
    assert.throws(() => requestSupplierInvoiceApproval({
      databasePath: value.databasePath, supplierInvoiceId: draft.id, requestingUser: operator,
      authorisedUser: operator, sourceChannel: 'test', sourceChat: 'test', now
    }), /INCOMPLETE/);
    const revised = await reviseSupplierInvoiceDraft({
      databasePath: value.databasePath, supplierInvoiceId: draft.id,
      fields: { dueDate: '2026-08-30' }, actor: operator, root: value.root, now: later
    });
    const approval = requestSupplierInvoiceApproval({
      databasePath: value.databasePath, supplierInvoiceId: revised.id, requestingUser: operator,
      authorisedUser: operator, sourceChannel: 'test', sourceChat: 'test', now: later
    });
    await assert.rejects(() => approveAndFileSupplierInvoice({
      databasePath: value.databasePath, token: approval.token, approvingUser: 'wrong-user',
      authorisedUser: operator, root: value.root, now: '2026-07-31T04:02:00.000Z', driveClient: fakeDrive(1)
    }), /UNAUTHORISED/);
    const expiring = requestSupplierInvoiceApproval({
      databasePath: value.databasePath, supplierInvoiceId: revised.id, requestingUser: operator,
      authorisedUser: operator, sourceChannel: 'test', sourceChat: 'test', now: later, ttlMinutes: 1
    });
    await assert.rejects(() => approveAndFileSupplierInvoice({
      databasePath: value.databasePath, token: expiring.token, approvingUser: operator,
      authorisedUser: operator, root: value.root, now: '2026-07-31T04:02:00.000Z', driveClient: fakeDrive(1)
    }), /EXPIRED/);
    const database = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT status FROM supplier_invoice_approvals WHERE token=?').get(expiring.token).status, 'EXPIRED');
    database.close();
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('supplier registry resolves exact codes and aliases', async () => {
  const value = await environment();
  try {
    assert.equal(resolveSupplier({ databasePath: value.databasePath, query: 'test-supplier' }).id, value.supplier.id);
    assert.equal(resolveSupplier({ databasePath: value.databasePath, query: 'TEST SOFTWARE VENDOR' }).id, value.supplier.id);
    assert.equal(resolveSupplier({ databasePath: value.databasePath, query: 'unknown supplier' }), null);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('supplier invoice schema contains no payment execution or banking fields', async () => {
  const value = await environment();
  try {
    const database = openDatabase(value.databasePath, { readOnly: true });
    const columns = database.prepare("PRAGMA table_info('supplier_invoices')").all().map((row) => row.name);
    database.close();
    assert.equal(columns.some((name) => /payment_status|paid_at|bank|payment_instruction/.test(name)), false);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
