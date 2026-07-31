import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import PizZip from 'pizzip';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { buildFinanceReport } from '../../scripts/lib/finance-reports.mjs';
import { exportFinanceReport } from '../../scripts/lib/report-exports.mjs';
import {
  approveClaimRecharge, assignClaimRecharge, confirmRechargeInvoiceInclusion,
  requestRechargeInvoiceConfirmation
} from '../../scripts/lib/claim-recharges.mjs';
import {
  generateClaimSubmissionPack, markClaimSubmissionPackSubmitted
} from '../../scripts/lib/claim-submission-packs.mjs';
import { createInvoiceConfirmationToken, createStandaloneInvoiceDraft } from '../../scripts/lib/invoice-drafts.mjs';
import { issueConfirmedInvoice } from '../../scripts/lib/invoice-issuance.mjs';

const NOW = '2026-07-31T01:00:00.000Z';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-f14-'));
  const databasePath = path.join(root, 'data', 'finance.sqlite3');
  const outputRoot = path.join(root, 'output');
  await migrateUp({ databasePath, now: () => NOW });
  await mkdir(path.join(root, 'data', 'claims', 'originals', '2026', '07'), { recursive: true });
  const db = openDatabase(databasePath);
  const entityId = Number(db.prepare(`INSERT INTO business_entities
    (legal_name,trading_name,default_currency,active,created_at,updated_at)
    VALUES ('TEST ENTITY / NOT VALID','TEST ENTITY','MYR',1,?,?)`).run(NOW, NOW).lastInsertRowid);
  const customerId = Number(db.prepare(`INSERT INTO customers
    (customer_code,legal_name,display_name,billing_address,billing_contact_name,billing_email,default_currency,
     default_payment_terms_days,active,created_at,updated_at)
    VALUES ('TEST-F14','TEST CUSTOMER / NOT VALID','TEST CUSTOMER','TEST ADDRESS / NOT VALID','TEST CONTACT',
      'test@example.invalid','MYR',30,1,?,?)`).run(NOW, NOW).lastInsertRowid);
  const otherCustomerId = Number(db.prepare(`INSERT INTO customers
    (customer_code,legal_name,display_name,billing_address,default_currency,active,created_at,updated_at)
    VALUES ('TEST-OTHER','TEST OTHER / NOT VALID','TEST OTHER','TEST ADDRESS / NOT VALID','MYR',1,?,?)`).run(NOW, NOW).lastInsertRowid);
  db.prepare(`INSERT INTO bank_profiles
    (id,display_name,business_entity_id,currency,bank_name,account_name,account_number,active,created_at,updated_at)
    VALUES ('cimb-myr','TEST / NOT VALID',?,'MYR','TEST BANK','TEST ACCOUNT','TEST-0000',1,?,?)`).run(entityId, NOW, NOW);
  db.prepare("UPDATE currencies SET default_bank_profile_id='cimb-myr' WHERE code='MYR'").run();
  db.prepare(`INSERT INTO quotations
    (quotation_number,status,customer_id,business_entity_id,currency,issue_date,valid_until,subtotal_minor,total_minor,created_by,created_at,issued_at)
    VALUES ('2607011001-TF','ISSUED',?,?,'MYR','2026-07-01','2026-07-31',10000,10000,'test',?,?)`).run(customerId, entityId, NOW, NOW);
  db.prepare(`INSERT INTO quotations
    (quotation_number,status,customer_id,business_entity_id,currency,issue_date,subtotal_minor,total_minor,created_by,created_at)
    VALUES ('2607021001-TF','ISSUE_FAILED',?,?,'MYR','2026-07-02',30000,30000,'test',?)`).run(customerId, entityId, NOW);
  db.prepare(`INSERT INTO quotations
    (quotation_number,status,customer_id,business_entity_id,currency,issue_date,subtotal_minor,total_minor,created_by,created_at,cancelled_at)
    VALUES ('2607031001-TF','CANCELLED',?,?,'MYR','2026-07-03',20000,20000,'test',?,?)`).run(customerId, entityId, NOW, NOW);
  db.prepare(`INSERT INTO invoices
    (invoice_number,status,customer_id,business_entity_id,currency,issue_date,due_date,subtotal_minor,total_minor,
     amount_paid_minor,balance_due_minor,payment_status,created_by,created_at,issued_at)
    VALUES ('2607011002-TF','ISSUED',?,?,'MYR','2026-07-01','2026-07-15',10000,10000,4000,6000,'PARTIALLY_PAID','test',?,?)`).run(customerId, entityId, NOW, NOW);
  db.prepare(`INSERT INTO invoices
    (invoice_number,status,customer_id,business_entity_id,currency,issue_date,due_date,subtotal_minor,total_minor,
     amount_paid_minor,balance_due_minor,payment_status,created_by,created_at,issued_at)
    VALUES ('2606301001-OT','ISSUED',?,?,'MYR','2026-06-30','2026-07-10',5000,5000,0,5000,'UNPAID','test',?,?)`).run(otherCustomerId, entityId, NOW, NOW);
  const receipt = Buffer.from('TEST RECEIPT / NOT VALID');
  const receiptHash = createHash('sha256').update(receipt).digest('hex');
  const receiptRelative = `2026/07/${receiptHash}.png`;
  db.prepare(`INSERT INTO claims
    (claim_number,status,transaction_date,merchant,description,category,client_or_project,currency,subtotal_minor,tax_minor,
     total_minor,business_purpose,source_filename,source_mime_type,source_hash,created_by,confirmed_by,created_at,confirmed_at,filed_at)
    VALUES ('2607101001-TF','FILED','2026-07-10','TEST MERCHANT / NOT VALID','TEST CLAIM / NOT VALID','travel',
      'TEST PROJECT / NOT VALID','MYR',1500,0,1500,'TEST PURPOSE / NOT VALID','test.png','image/png',?,'test','test',?,?,?)`)
    .run(receiptHash, NOW, NOW, NOW);
  const claimId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  db.prepare(`INSERT INTO claim_receipts
    (claim_id,source_filename,source_mime_type,source_size,source_sha256,storage_relative_path,extraction_method,
     extraction_status,rotation_degrees,created_at)
    VALUES (?,'test.png','image/png',?,?,?,'ADVISORY','COMPLETE',0,?)`).run(claimId, receipt.length, receiptHash, receiptRelative, NOW);
  db.prepare(`INSERT INTO suppliers
    (supplier_code,display_name,default_currency,active,created_at,updated_at)
    VALUES ('TEST-SUP','TEST SUPPLIER / NOT VALID','MYR',1,?,?)`).run(NOW, NOW);
  const supplierId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  db.prepare(`INSERT INTO supplier_invoices
    (status,classification,supplier_id,supplier_invoice_number,issue_date,due_date,expense_category,project_allocation,
     currency,subtotal_minor,tax_minor,total_minor,description,created_by,created_at,filed_at)
    VALUES ('FILED','SUPPLIER_INVOICE',?,'TEST-SI-1','2026-07-11','2026-08-10','software','TEST PROJECT / NOT VALID',
      'MYR',2500,0,2500,'TEST / NOT VALID','test',?,?)`).run(supplierId, NOW, NOW);
  db.close();
  await writeFile(path.join(root, 'data', 'claims', 'originals', receiptRelative), receipt, { mode: 0o600 });
  return { root, databasePath, outputRoot, entityId, customerId, otherCustomerId, claimId, receiptHash };
}
async function cleanup(value) {
  const db = openDatabase(value.databasePath);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.exec('PRAGMA journal_mode=DELETE'); db.close();
  await rm(value.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
function invoiceInput(value) {
  return {
    customer_id: value.customerId, business_entity_id: value.entityId, currency: 'MYR',
    issue_date: '2026-07-31', payment_terms_days: 30, service_date: '2026-07-31',
    payment_terms: '30 days / TEST ONLY', notes: 'TEST / NOT VALID',
    line_items: [{ description: 'TEST SERVICE / NOT VALID', quantity: '1', unit: 'service', unit_price_minor: 5000 }],
    discount: { type: 'NONE' }, tax: { mode: 'NONE' }
  };
}
async function fakePdfConverter({ pdfPath }) {
  await writeFile(pdfPath, Buffer.from('%PDF-1.4\nTEST / NOT VALID\n%%EOF'), { mode: 0o600 });
}
async function fakePdfInspector() { return { pageCount: 1, a4: true, text: 'TEST / NOT VALID 2607311001-TF RM 65.00' }; }

test('monthly and annual summaries keep currencies separate and honor date boundaries', async () => {
  const value = await fixture();
  try {
    const monthly = buildFinanceReport({ databasePath: value.databasePath, reportType: 'monthly-summary', filters: { month: '2026-07' }, generatedAt: NOW });
    const myr = monthly.rows.find((row) => row.currency === 'MYR');
    assert.equal(myr.quotation_count, 1);
    assert.equal(myr.quotation_total_minor, 10000);
    assert.equal(myr.invoice_total_minor, 10000);
    assert.equal(myr.claim_total_minor, 1500);
    assert.equal(myr.supplier_invoice_total_minor, 2500);
    assert.equal(monthly.rows.find((row) => row.currency === 'SGD').invoice_total_minor, 0);
    const annual = buildFinanceReport({ databasePath: value.databasePath, reportType: 'annual-summary', filters: { year: 2026 }, generatedAt: NOW });
    assert.equal(annual.rows.find((row) => row.currency === 'MYR').invoice_total_minor, 15000);
  } finally { await cleanup(value); }
});

test('register filters and cancellation/failed-issuance rules are explicit', async () => {
  const value = await fixture();
  try {
    const report = buildFinanceReport({
      databasePath: value.databasePath, reportType: 'quotation-register',
      filters: { startDate: '2026-07-01', endDateExclusive: '2026-08-01', customerId: value.customerId }, generatedAt: NOW
    });
    assert.equal(report.rows.length, 2);
    assert.equal(report.rows.some((row) => row.status === 'CANCELLED'), false);
    assert.equal(report.rows.find((row) => row.status === 'ISSUE_FAILED').recognized_minor, 0);
    assert.equal(report.currencyTotals.find((row) => row.currency === 'MYR').totalMinor, 10000);
    const cancelled = buildFinanceReport({
      databasePath: value.databasePath, reportType: 'quotation-register',
      filters: { startDate: '2026-07-01', endDateExclusive: '2026-08-01', status: 'CANCELLED', includeCancelled: true }, generatedAt: NOW
    });
    assert.equal(cancelled.rows.length, 1);
  } finally { await cleanup(value); }
});

test('outstanding and overdue reports reconcile balances and filter customers', async () => {
  const value = await fixture();
  try {
    const outstanding = buildFinanceReport({ databasePath: value.databasePath, reportType: 'outstanding', filters: { customerId: value.customerId, asOfDate: '2026-07-31' }, generatedAt: NOW });
    assert.equal(outstanding.rows.length, 1);
    assert.equal(outstanding.rows[0].recognized_minor, 6000);
    assert.equal(outstanding.rows[0].total_minor - outstanding.rows[0].amount_paid_minor, outstanding.rows[0].recognized_minor);
    const overdue = buildFinanceReport({ databasePath: value.databasePath, reportType: 'overdue', filters: { customerId: value.customerId, asOfDate: '2026-07-31' }, generatedAt: NOW });
    assert.equal(overdue.rows[0].days_overdue, 16);
  } finally { await cleanup(value); }
});

test('claim and expense reports use filed records, status filters, and separate categories', async () => {
  const value = await fixture();
  try {
    const claims = buildFinanceReport({
      databasePath: value.databasePath, reportType: 'claim-register',
      filters: { startDate: '2026-07-01', endDateExclusive: '2026-08-01', status: 'FILED' }, generatedAt: NOW
    });
    assert.equal(claims.rows.length, 1);
    assert.equal(claims.currencyTotals.find((row) => row.currency === 'MYR').totalMinor, 1500);
    const expenses = buildFinanceReport({
      databasePath: value.databasePath, reportType: 'expense-by-category',
      filters: { startDate: '2026-07-01', endDateExclusive: '2026-08-01', currency: 'MYR' }, generatedAt: NOW
    });
    assert.deepEqual(
      expenses.rows.map((row) => [row.source_type, row.category, row.recognized_minor]),
      [['SUPPLIER_INVOICE', 'software', 2500], ['CLAIM', 'travel', 1500]]
    );
    assert.equal(expenses.currencyTotals.find((row) => row.currency === 'MYR').totalMinor, 4000);
  } finally { await cleanup(value); }
});

test('CSV and XLSX exports reconcile to report totals and are marked TEST / NOT VALID', async () => {
  const value = await fixture();
  try {
    const filters = { month: '2026-07' };
    const csv = await exportFinanceReport({
      databasePath: value.databasePath, reportType: 'monthly-summary', filters, format: 'CSV',
      actor: 'test-ray', generatedAt: NOW, testMode: true, root: value.root, outputRoot: path.join(value.root, 'exports-csv')
    });
    assert.match(await readFile(csv.filePath, 'utf8'), /TEST \/ NOT VALID/);
    const xlsx = await exportFinanceReport({
      databasePath: value.databasePath, reportType: 'monthly-summary', filters, format: 'XLSX',
      actor: 'test-ray', generatedAt: NOW, testMode: true, root: value.root, outputRoot: path.join(value.root, 'exports-xlsx')
    });
    const zip = new PizZip(await readFile(xlsx.filePath));
    assert.ok(zip.file('xl/worksheets/sheet1.xml'));
    assert.match(zip.file('xl/worksheets/sheet2.xml').asText(), /TEST \/ NOT VALID/);
    const db = openDatabase(value.databasePath, { readOnly: true });
    const exports = db.prepare('SELECT * FROM report_exports ORDER BY id').all();
    db.close();
    assert.equal(exports.length, 2);
    assert.deepEqual(JSON.parse(exports[1].currency_totals_json), xlsx.report.currencyTotals);
  } finally { await cleanup(value); }
});

test('a confirmed claim recharge becomes an immutable invoice line and is marked invoiced on issuance', async () => {
  const value = await fixture();
  try {
    const recharge = assignClaimRecharge({
      databasePath: value.databasePath, claimId: value.claimId, customerId: value.customerId,
      projectReference: 'TEST PROJECT / NOT VALID', description: 'Reimbursement: TEST TRAVEL / NOT VALID',
      actor: 'test-ray', now: NOW
    });
    approveClaimRecharge({ databasePath: value.databasePath, rechargeId: recharge.id, approvingUser: 'test-ray', authorisedUser: 'test-ray', now: '2026-07-31T01:01:00.000Z' });
    const draft = createStandaloneInvoiceDraft({ databasePath: value.databasePath, input: invoiceInput(value), actor: 'test-ray', now: '2026-07-31T01:02:00.000Z' });
    const confirmation = requestRechargeInvoiceConfirmation({
      databasePath: value.databasePath, invoiceId: draft.id, rechargeIds: [recharge.id],
      requestingUser: 'test-ray', authorisedUser: 'test-ray', sourceChannel: 'test', sourceChat: 'test-chat',
      tokenFactory: () => 'CR-CCCCCCCCCC', now: '2026-07-31T01:03:00.000Z'
    });
    const included = confirmRechargeInvoiceInclusion({
      databasePath: value.databasePath, token: confirmation.token, confirmingUser: 'test-ray',
      authorisedUser: 'test-ray', sourceChannel: 'test', sourceChat: 'test-chat', now: '2026-07-31T01:04:00.000Z'
    });
    assert.equal(included.invoice.snapshot.lineItems.length, 2);
    assert.equal(included.invoice.snapshot.totals.totalMinor, 6500);
    const db = openDatabase(value.databasePath);
    assert.throws(() => db.prepare('UPDATE claim_invoice_links SET amount_minor=1').run(), /immutable/);
    db.close();
    createInvoiceConfirmationToken({
      databasePath: value.databasePath, invoiceId: draft.id, requestingUser: 'test-ray',
      sourceChannel: 'test', sourceChat: 'test-chat', tokenFactory: () => 'ID-CCCCCCCCCC',
      now: '2026-07-31T01:05:00.000Z'
    });
    await issueConfirmedInvoice({
      databasePath: value.databasePath, token: 'ID-CCCCCCCCCC', confirmingUser: 'test-ray',
      sourceChannel: 'test', sourceChat: 'test-chat', clientInitials: 'TF', outputRoot: value.outputRoot,
      testMode: true, pdfConverter: fakePdfConverter, pdfInspector: fakePdfInspector, now: '2026-07-31T01:06:00.000Z'
    });
    const issued = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(issued.prepare('SELECT status FROM claim_recharges WHERE id=?').get(recharge.id).status, 'INVOICED');
    issued.close();
  } finally { await cleanup(value); }
});

test('expired claim-recharge confirmations fail closed and remain expired', async () => {
  const value = await fixture();
  try {
    const recharge = assignClaimRecharge({
      databasePath: value.databasePath, claimId: value.claimId, customerId: value.customerId,
      description: 'TEST EXPIRED RECHARGE / NOT VALID', actor: 'test-ray', now: NOW
    });
    approveClaimRecharge({
      databasePath: value.databasePath, rechargeId: recharge.id, approvingUser: 'test-ray',
      authorisedUser: 'test-ray', now: '2026-07-31T01:01:00.000Z'
    });
    const draft = createStandaloneInvoiceDraft({
      databasePath: value.databasePath, input: invoiceInput(value), actor: 'test-ray', now: '2026-07-31T01:02:00.000Z'
    });
    const confirmation = requestRechargeInvoiceConfirmation({
      databasePath: value.databasePath, invoiceId: draft.id, rechargeIds: [recharge.id],
      requestingUser: 'test-ray', authorisedUser: 'test-ray', sourceChannel: 'test', sourceChat: 'test-chat',
      ttlMinutes: 1, tokenFactory: () => 'CR-EEEEEEEEEE', now: '2026-07-31T01:03:00.000Z'
    });
    assert.throws(() => confirmRechargeInvoiceInclusion({
      databasePath: value.databasePath, token: confirmation.token, confirmingUser: 'test-ray',
      authorisedUser: 'test-ray', sourceChannel: 'test', sourceChat: 'test-chat',
      now: '2026-07-31T01:04:00.000Z'
    }), /RECHARGE_CONFIRMATION_EXPIRED/);
    const db = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(db.prepare('SELECT status FROM claim_recharge_confirmations WHERE token=?').get(confirmation.token).status, 'EXPIRED');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM claim_invoice_links').get().count, 0);
    db.close();
  } finally { await cleanup(value); }
});

test('monthly company claim packs contain a summary and hash-verified original receipts', async () => {
  const value = await fixture();
  try {
    const recharge = assignClaimRecharge({
      databasePath: value.databasePath, claimId: value.claimId, customerId: value.customerId,
      description: 'TEST CLAIM SUBMISSION / NOT VALID', actor: 'test-ray', now: NOW
    });
    approveClaimRecharge({ databasePath: value.databasePath, rechargeId: recharge.id, approvingUser: 'test-ray', authorisedUser: 'test-ray', now: '2026-07-31T01:01:00.000Z' });
    const pack = await generateClaimSubmissionPack({
      databasePath: value.databasePath, customerId: value.customerId, month: '2026-07',
      actor: 'test-ray', testMode: true, now: '2026-07-31T01:02:00.000Z', root: value.root,
      outputRoot: path.join(value.root, 'claim-packs')
    });
    assert.equal(pack.claimCount, 1);
    const zip = new PizZip(await readFile(pack.filePath));
    assert.match(zip.file('summary.csv').asText(), /TEST \/ NOT VALID/);
    assert.match(zip.file('manifest.json').asText(), /NO_CONVERSION/);
    assert.equal(zip.file(new RegExp(`receipts/claim-${value.claimId}-`)).length, 1);
    const db = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(pack.status, 'READY');
    assert.equal(db.prepare('SELECT status FROM claim_recharges WHERE id=?').get(recharge.id).status, 'APPROVED');
    assert.equal(db.prepare('SELECT receipt_sha256 FROM claim_submission_pack_items').get().receipt_sha256, value.receiptHash);
    db.close();
    const submitted = markClaimSubmissionPackSubmitted({
      databasePath: value.databasePath, packId: pack.packId, submittingUser: 'test-ray',
      authorisedUser: 'test-ray', submissionReference: 'TEST MANUAL SUBMISSION / NOT VALID',
      now: '2026-07-31T01:03:00.000Z'
    });
    assert.equal(submitted.status, 'SUBMITTED');
  } finally { await cleanup(value); }
});
