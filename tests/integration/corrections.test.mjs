import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { createStandaloneInvoiceDraft, createInvoiceConfirmationToken } from '../../scripts/lib/invoice-drafts.mjs';
import { issueConfirmedInvoice } from '../../scripts/lib/invoice-issuance.mjs';
import {
  confirmDocumentCancellation, createCreditNoteDraft, createReplacementInvoiceDraft,
  createReplacementQuotationDraft, issueConfirmedCreditNote, requestCreditNoteConfirmation,
  requestDocumentCancellation
} from '../../scripts/lib/corrections.mjs';
import { createQuotationConfirmationToken, createQuotationDraft } from '../../scripts/lib/quotation-drafts.mjs';
import { issueConfirmedQuotation } from '../../scripts/lib/quotation-issuance.mjs';
import { renderCreditNoteDocx } from '../../scripts/lib/credit-note-renderer.mjs';
import { buildFinanceReport } from '../../scripts/lib/finance-reports.mjs';
import { fileCorrectionToDrive } from '../../scripts/lib/correction-drive.mjs';
import { readDocumentXml } from '../../scripts/lib/template-contract.mjs';

const NOW = '2026-07-31T00:00:00.000Z';
const DRIVE_FOLDER = 'TEST_FOLDER_1234567890';
const DRIVE_CONFIG = {
  schemaVersion: 1, identity: 'test@example.invalid', client: 'test-client',
  rootFolderId: DRIVE_FOLDER, destinations: { quotation: DRIVE_FOLDER, invoice: DRIVE_FOLDER }
};
class FakeDrive {
  constructor() { this.files = new Map(); this.next = 1; }
  async findByName({ name, parentId }) {
    return [...this.files.values()].filter((file) => file.name === name && file.parents.includes(parentId));
  }
  async uploadFile({ localPath, name, parentId }) {
    const buffer = await readFile(localPath);
    const file = { id: `test-${this.next++}`, name, parents: [parentId], size: buffer.length, mimeType: 'application/octet-stream' };
    this.files.set(file.id, file);
    return file;
  }
  async getMetadata(id) {
    if (id === DRIVE_FOLDER) return { id, name: 'TEST FOLDER', mimeType: 'application/vnd.google-apps.folder', parents: [], size: 0 };
    return this.files.get(id);
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-f15-'));
  const databasePath = path.join(root, 'data', 'finance.sqlite3');
  const outputRoot = path.join(root, 'generated', 'invoices');
  await migrateUp({ databasePath, now: () => NOW });
  const db = openDatabase(databasePath);
  const entityId = Number(db.prepare(`INSERT INTO business_entities
    (legal_name,trading_name,default_currency,active,created_at,updated_at)
    VALUES ('TEST ENTITY / NOT VALID','TEST ENTITY','MYR',1,?,?)`).run(NOW, NOW).lastInsertRowid);
  const customerId = Number(db.prepare(`INSERT INTO customers
    (customer_code,legal_name,display_name,billing_address,billing_contact_name,billing_email,
     default_currency,default_payment_terms_days,active,created_at,updated_at)
    VALUES ('TEST-F15','TEST CUSTOMER / NOT VALID','TEST CUSTOMER','TEST ADDRESS / NOT VALID',
      'TEST CONTACT','test@example.invalid','MYR',30,1,?,?)`).run(NOW, NOW).lastInsertRowid);
  db.prepare(`INSERT INTO bank_profiles
    (id,display_name,business_entity_id,currency,bank_name,account_name,account_number,active,created_at,updated_at)
    VALUES ('cimb-myr','TEST / NOT VALID',?,'MYR','TEST BANK','TEST ACCOUNT','TEST-0000',1,?,?)`)
    .run(entityId, NOW, NOW);
  db.prepare("UPDATE currencies SET default_bank_profile_id='cimb-myr' WHERE code='MYR'").run();
  db.close();
  return { root, databasePath, outputRoot, entityId, customerId };
}

function invoiceInput(value) {
  return {
    customer_id: value.customerId, business_entity_id: value.entityId, currency: 'MYR',
    issue_date: '2026-07-29', payment_terms_days: 30, service_date: '2026-07-29',
    payment_terms: '30 days / TEST ONLY', notes: 'TEST / NOT VALID',
    line_items: [{ description: 'TEST SERVICE / NOT VALID', quantity: '1', unit: 'service', unit_price_minor: 10000 }],
    discount: { type: 'NONE' }, tax: { mode: 'NONE' }
  };
}
async function invoicePdf({ pdfPath }) {
  await writeFile(pdfPath, Buffer.from('%PDF-1.4\n2607291001-SC RM 100.00 TEST / NOT VALID\n%%EOF'), { mode: 0o600 });
}
async function creditPdf({ pdfPath }) {
  await writeFile(pdfPath, Buffer.from('%PDF-1.4\n2607301001-SC RM 40.00 TEST / NOT VALID\n%%EOF'), { mode: 0o600 });
}
async function inspector({ pdfPath }) { return { pageCount: 1, a4: true, text: await readFile(pdfPath, 'utf8') }; }

async function issueInvoice(value) {
  const draft = createStandaloneInvoiceDraft({
    databasePath: value.databasePath, input: invoiceInput(value), actor: 'test-ray',
    now: '2026-07-29T00:01:00.000Z'
  });
  createInvoiceConfirmationToken({
    databasePath: value.databasePath, invoiceId: draft.id, requestingUser: 'test-ray',
    sourceChannel: 'test', sourceChat: 'test-chat', tokenFactory: () => 'ID-CCCCCCCCCC',
    now: '2026-07-29T00:02:00.000Z'
  });
  await issueConfirmedInvoice({
    databasePath: value.databasePath, token: 'ID-CCCCCCCCCC', confirmingUser: 'test-ray',
    sourceChannel: 'test', sourceChat: 'test-chat', clientInitials: 'SC',
    outputRoot: value.outputRoot, testMode: true,
    pdfConverter: invoicePdf, pdfInspector: inspector, now: '2026-07-29T00:03:00.000Z'
  });
  return draft;
}
async function issueQuotation(value) {
  const draft = createQuotationDraft({
    databasePath: value.databasePath, actor: 'test-ray', now: '2026-07-29T00:01:00.000Z',
    input: {
      customer_id: value.customerId, business_entity_id: value.entityId, currency: 'MYR',
      issue_date: '2026-07-29', validity_days: 30, service_date: '2026-08-15',
      title: 'TEST QUOTATION / NOT VALID', description: 'TEST / NOT VALID',
      payment_terms: 'TEST ONLY', notes: 'TEST / NOT VALID',
      line_items: [{ description: 'TEST SERVICE / NOT VALID', quantity: '1', unit: 'service', unit_price_minor: 10000 }],
      discount: { type: 'NONE' }, tax: { mode: 'NONE' }
    }
  });
  createQuotationConfirmationToken({
    databasePath: value.databasePath, quotationId: draft.id, requestingUser: 'test-ray',
    sourceChannel: 'test', sourceChat: 'test-chat', tokenFactory: () => 'QD-EEEEEEEEEE',
    now: '2026-07-29T00:02:00.000Z'
  });
  await issueConfirmedQuotation({
    databasePath: value.databasePath, token: 'QD-EEEEEEEEEE', confirmingUser: 'test-ray',
    sourceChannel: 'test', sourceChat: 'test-chat', clientInitials: 'SC',
    outputRoot: path.join(value.root, 'generated', 'quotations'), testMode: true,
    pdfConverter: invoicePdf, pdfInspector: inspector, now: '2026-07-29T00:03:00.000Z'
  });
  return draft;
}
async function cleanup(value) {
  const db = openDatabase(value.databasePath);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.exec('PRAGMA journal_mode=DELETE'); db.close();
  await rm(value.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('credit note requires confirmation, references its invoice, issues immutably, and reduces reports', async () => {
  const value = await fixture();
  try {
    const invoice = await issueInvoice(value);
    const draft = createCreditNoteDraft({
      databasePath: value.databasePath, originalInvoiceId: invoice.id, issueDate: '2026-07-30',
      reason: 'TEST SERVICE ADJUSTMENT / NOT VALID',
      lines: [{ description: 'TEST PARTIAL CREDIT / NOT VALID', amount_minor: 4000 }],
      actor: 'test-ray', now: '2026-07-30T00:01:00.000Z'
    });
    assert.equal(draft.snapshot.originalInvoiceNumber, '2607291001-SC');
    const rendered = await renderCreditNoteDocx({
      root: path.resolve('.'), snapshot: draft.snapshot, documentNumber: '2607301001-SC', testMode: true
    });
    const xml = readDocumentXml(rendered.buffer).xml;
    assert.match(xml, /CREDIT NOTE/);
    assert.match(xml, /2607291001-SC/);
    assert.doesNotMatch(xml, /PREFERRED PAYMENT METHOD|Payment is due/);
    requestCreditNoteConfirmation({
      databasePath: value.databasePath, creditNoteId: draft.id, requestingUser: 'test-ray',
      authorisedUser: 'test-ray', sourceChannel: 'test', sourceChat: 'test-chat',
      tokenFactory: () => 'CR-CCCCCCCCCC', now: '2026-07-30T00:02:00.000Z'
    });
    const issued = await issueConfirmedCreditNote({
      databasePath: value.databasePath, token: 'CR-CCCCCCCCCC', confirmingUser: 'test-ray',
      sourceChannel: 'test', sourceChat: 'test-chat', clientInitials: 'SC', root: path.resolve('.'),
      outputRoot: path.join(value.root, 'generated', 'credit-notes'), testMode: true,
      pdfConverter: creditPdf, pdfInspector: inspector, now: '2026-07-30T00:03:00.000Z'
    });
    assert.equal(issued.status, 'ISSUED');
    assert.equal(issued.credit_note_number, '2607301001-SC');
    const report = buildFinanceReport({
      databasePath: value.databasePath, reportType: 'outstanding',
      filters: { asOfDate: '2026-07-31' }, generatedAt: NOW
    });
    assert.equal(report.rows[0].credited_minor, 4000);
    assert.equal(report.rows[0].recognized_minor, 6000);
    const summary = buildFinanceReport({
      databasePath: value.databasePath, reportType: 'monthly-summary',
      filters: { month: '2026-07' }, generatedAt: NOW
    }).rows.find((row) => row.currency === 'MYR');
    assert.equal(summary.credit_note_total_minor, 4000);
    assert.equal(summary.net_invoice_total_minor, 6000);
    const db = openDatabase(value.databasePath);
    assert.throws(() => db.prepare('UPDATE credit_note_draft_versions SET draft_hash=?').run('f'.repeat(64)), /immutable/);
    assert.throws(() => db.prepare('UPDATE document_status_history SET to_status=?').run('DRAFT'), /append-only/);
    db.close();
  } finally { await cleanup(value); }
});

test('confirmed invoice cancellation preserves issuance files and supports one linked replacement draft', async () => {
  const value = await fixture();
  try {
    const invoice = await issueInvoice(value);
    const beforeDocx = await readFile(path.join(value.outputRoot, '2026', '07', '2607291001-SC.docx'));
    const request = requestDocumentCancellation({
      databasePath: value.databasePath, documentType: 'invoice', entityId: invoice.id,
      reason: 'TEST WRONG BILLING DETAILS / NOT VALID', requestingUser: 'test-ray',
      authorisedUser: 'test-ray', sourceChannel: 'test', sourceChat: 'test-chat',
      tokenFactory: () => 'CR-DDDDDDDDDD', now: '2026-07-30T00:01:00.000Z'
    });
    const cancelled = confirmDocumentCancellation({
      databasePath: value.databasePath, token: request.token, confirmingUser: 'test-ray',
      authorisedUser: 'test-ray', sourceChannel: 'test', sourceChat: 'test-chat',
      now: '2026-07-30T00:02:00.000Z'
    });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.deepEqual(await readFile(path.join(value.outputRoot, '2026', '07', '2607291001-SC.docx')), beforeDocx);
    const db = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(db.prepare('SELECT status FROM invoice_issuances WHERE invoice_id=?').get(invoice.id).status, 'ISSUED');
    assert.equal(db.prepare("SELECT status FROM document_numbers WHERE document_type='invoice' AND entity_id=?").get(invoice.id).status, 'CANCELLED');
    db.close();
    const replacement = createReplacementInvoiceDraft({
      databasePath: value.databasePath, originalInvoiceId: invoice.id, issueDate: '2026-07-31',
      paymentTermsDays: 30, reason: 'TEST CORRECTED BILLING / NOT VALID',
      actor: 'test-ray', now: '2026-07-30T00:03:00.000Z'
    });
    assert.match(replacement.snapshot.lineItems[0].description, /Replacement for invoice 2607291001-SC/);
    const linked = openDatabase(value.databasePath);
    const replacementLink = linked.prepare('SELECT * FROM replacement_document_links').get();
    assert.equal(replacementLink.replacement_entity_id, replacement.id);
    const cancellation = linked.prepare('SELECT * FROM document_cancellations').get();
    assert.throws(() => linked.prepare('DELETE FROM replacement_document_links').run(), /immutable/);
    linked.close();
    const drive = new FakeDrive();
    const filed = await fileCorrectionToDrive({
      databasePath: value.databasePath, correctionType: 'cancellation', entityId: cancellation.id,
      actor: 'test-ray', root: value.root, testMode: true, configuration: DRIVE_CONFIG,
      client: drive, now: '2026-07-30T00:04:00.000Z'
    });
    assert.equal(filed.status, 'COMPLETED');
    assert.equal(filed.filings[0].artifact_kind, 'JSON');
    assert.match(await readFile(path.join(value.root, 'generated', 'corrections', filed.filings[0].local_relative_path), 'utf8'), /TEST \/ NOT VALID/);
    assert.deepEqual(await readFile(path.join(value.outputRoot, '2026', '07', '2607291001-SC.docx')), beforeDocx);
    assert.throws(() => createReplacementInvoiceDraft({
      databasePath: value.databasePath, originalInvoiceId: invoice.id, issueDate: '2026-08-01',
      paymentTermsDays: 30, reason: 'TEST DUPLICATE / NOT VALID', actor: 'test-ray'
    }), /REPLACEMENT_ALREADY_EXISTS/);
  } finally { await cleanup(value); }
});

test('paid invoices and unconfirmed cancellations fail closed', async () => {
  const value = await fixture();
  try {
    const invoice = await issueInvoice(value);
    const db = openDatabase(value.databasePath);
    db.prepare("UPDATE invoices SET amount_paid_minor=10000,balance_due_minor=0,payment_status='PAID',paid_at='2026-07-30' WHERE id=?").run(invoice.id);
    db.close();
    assert.throws(() => requestDocumentCancellation({
      databasePath: value.databasePath, documentType: 'invoice', entityId: invoice.id,
      reason: 'TEST / NOT VALID', requestingUser: 'test-ray', authorisedUser: 'test-ray',
      sourceChannel: 'test', sourceChat: 'test-chat'
    }), /PAID_OR_PARTIALLY_PAID/);
    assert.throws(() => createCreditNoteDraft({
      databasePath: value.databasePath, originalInvoiceId: invoice.id, issueDate: '2026-07-31',
      reason: 'TEST / NOT VALID', lines: [{ description: 'TEST / NOT VALID', amount_minor: 1 }],
      actor: 'test-ray'
    }), /CREDIT_NOTE_EXCEEDS_AVAILABLE_BALANCE/);
  } finally { await cleanup(value); }
});

test('issued quotation cancellation retires its number and creates a visibly linked replacement', async () => {
  const value = await fixture();
  try {
    const quotation = await issueQuotation(value);
    const request = requestDocumentCancellation({
      databasePath: value.databasePath, documentType: 'quotation', entityId: quotation.id,
      reason: 'TEST QUOTATION CORRECTION / NOT VALID', requestingUser: 'test-ray',
      authorisedUser: 'test-ray', sourceChannel: 'test', sourceChat: 'test-chat',
      tokenFactory: () => 'CR-EEEEEEEEEE', now: '2026-07-30T00:01:00.000Z'
    });
    assert.throws(() => confirmDocumentCancellation({
      databasePath: value.databasePath, token: request.token, confirmingUser: 'test-ray',
      authorisedUser: 'test-ray', sourceChannel: 'test', sourceChat: 'wrong-chat',
      now: '2026-07-30T00:02:00.000Z'
    }), /CORRECTION_CONFIRMATION_CONTEXT_MISMATCH/);
    const cancelled = confirmDocumentCancellation({
      databasePath: value.databasePath, token: request.token, confirmingUser: 'test-ray',
      authorisedUser: 'test-ray', sourceChannel: 'test', sourceChat: 'test-chat',
      now: '2026-07-30T00:02:00.000Z'
    });
    assert.equal(cancelled.status, 'CANCELLED');
    const replacement = createReplacementQuotationDraft({
      databasePath: value.databasePath, originalQuotationId: quotation.id, issueDate: '2026-07-31',
      validityDays: 30, reason: 'TEST CORRECTED QUOTATION / NOT VALID',
      actor: 'test-ray', now: '2026-07-30T00:03:00.000Z'
    });
    assert.match(replacement.snapshot.title, /Replacement for quotation 2607291001-SC/);
    const database = openDatabase(value.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT status FROM quotation_issuances WHERE quotation_id=?').get(quotation.id).status, 'CANCELLED');
    assert.equal(database.prepare("SELECT status FROM document_numbers WHERE document_type='quotation' AND entity_id=?").get(quotation.id).status, 'CANCELLED');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM document_status_history WHERE document_type='quotation' AND entity_id=?").get(quotation.id).count, 1);
    database.close();
  } finally { await cleanup(value); }
});

const hasLibreOffice = spawnSync('soffice', ['--version'], { windowsHide: true }).status === 0;
test('LibreOffice produces a validated one-page A4 test credit note', { skip: !hasLibreOffice }, async () => {
  const value = await fixture();
  try {
    const invoice = await issueInvoice(value);
    const draft = createCreditNoteDraft({
      databasePath: value.databasePath, originalInvoiceId: invoice.id, issueDate: '2026-07-30',
      reason: 'TEST VISUAL CREDIT / NOT VALID',
      lines: [{ description: 'TEST CREDIT LINE / NOT VALID', amount_minor: 4000 }],
      actor: 'test-ray', now: '2026-07-30T00:01:00.000Z'
    });
    requestCreditNoteConfirmation({
      databasePath: value.databasePath, creditNoteId: draft.id, requestingUser: 'test-ray',
      authorisedUser: 'test-ray', sourceChannel: 'test', sourceChat: 'test-chat',
      tokenFactory: () => 'CR-FFFFFFFFFF', now: '2026-07-30T00:02:00.000Z'
    });
    const issued = await issueConfirmedCreditNote({
      databasePath: value.databasePath, token: 'CR-FFFFFFFFFF', confirmingUser: 'test-ray',
      sourceChannel: 'test', sourceChat: 'test-chat', clientInitials: 'SC',
      root: path.resolve('.'), outputRoot: path.join(value.root, 'generated', 'credit-notes'),
      testMode: true, now: '2026-07-30T00:03:00.000Z'
    });
    assert.equal(issued.status, 'ISSUED');
    const database = openDatabase(value.databasePath, { readOnly: true });
    const relative = database.prepare('SELECT pdf_relative_path FROM credit_note_issuances WHERE credit_note_id=?').get(draft.id).pdf_relative_path;
    database.close();
    const pdf = await readFile(path.join(value.root, 'generated', 'credit-notes', relative));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  } finally { await cleanup(value); }
});
