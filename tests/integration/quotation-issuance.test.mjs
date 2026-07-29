import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import {
  cancelQuotationIssuance,
  issueConfirmedQuotation,
  retryQuotationIssuance
} from '../../scripts/lib/quotation-issuance.mjs';
import {
  createQuotationConfirmationToken,
  createQuotationDraft
} from '../../scripts/lib/quotation-drafts.mjs';
import {
  convertDocxToPdf,
  publishImmutableBuffer,
  renderQuotationDocx
} from '../../scripts/lib/quotation-renderer.mjs';
import { readDocumentXml, sha256 } from '../../scripts/lib/template-contract.mjs';

const NOW = '2026-07-29T00:00:00.000Z';
const TOKEN = 'QD-CCCCCCCCCC';
const DOCUMENT_NUMBER = '2607291001-SC';
const PDF_TEXT = `${DOCUMENT_NUMBER} RM 100.00 TEST / NOT VALID`;

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-f6-'));
  const databasePath = path.join(directory, 'finance.sqlite3');
  const outputRoot = path.join(directory, 'outputs');
  await migrateUp({ databasePath, now: () => NOW });
  const database = openDatabase(databasePath);
  const entityId = Number(database.prepare(`
    INSERT INTO business_entities (legal_name, trading_name, default_currency, active, created_at, updated_at)
    VALUES ('Test Entity — TEST / NOT VALID', 'Test Entity', 'MYR', 1, ?, ?)
  `).run(NOW, NOW).lastInsertRowid);
  const customerId = Number(database.prepare(`
    INSERT INTO customers (
      customer_code, legal_name, display_name, billing_address, default_currency,
      default_payment_terms_days, active, created_at, updated_at
    ) VALUES ('TEST-001', 'Synthetic Customer — TEST / NOT VALID', 'Synthetic Customer',
      'TEST ADDRESS — NOT VALID', 'MYR', 30, 1, ?, ?)
  `).run(NOW, NOW).lastInsertRowid);
  database.prepare(`
    INSERT INTO bank_profiles (
      id, display_name, business_entity_id, currency, bank_name, account_name,
      account_number, active, created_at, updated_at
    ) VALUES ('cimb-myr', 'TEST / NOT VALID', ?, 'MYR', 'TEST BANK',
      'TEST ACCOUNT', '0000000000', 1, ?, ?)
  `).run(entityId, NOW, NOW);
  database.prepare("UPDATE currencies SET default_bank_profile_id = 'cimb-myr' WHERE code = 'MYR'").run();
  database.close();
  const draft = createQuotationDraft({
    databasePath,
    input: {
      customer_id: customerId,
      business_entity_id: entityId,
      currency: 'MYR',
      issue_date: '2026-07-29',
      validity_days: 30,
      service_date: '2026-08-15',
      title: 'TEST / NOT VALID — Synthetic services',
      description: 'Synthetic quotation fixture',
      payment_terms: 'TEST terms only',
      notes: 'TEST / NOT VALID',
      source_channel: 'test',
      source_message_reference: 'test-message-f6',
      line_items: [{ description: 'TEST service — NOT VALID', quantity: '1', unit_price_minor: 10000, unit: 'lot' }],
      discount: { type: 'NONE' },
      tax: { mode: 'NONE' }
    },
    actor: 'test-user',
    now: '2026-07-29T00:01:00.000Z'
  });
  return { directory, databasePath, outputRoot, draft };
}

async function addConfirmation(ids) {
  return createQuotationConfirmationToken({
    databasePath: ids.databasePath,
    quotationId: ids.draft.id,
    requestingUser: 'test-user',
    sourceChannel: 'test',
    sourceChat: 'test-chat',
    sourceMessageReference: 'test-message-f6',
    ttlMinutes: 30,
    tokenFactory: () => TOKEN,
    now: '2026-07-29T00:02:00.000Z'
  });
}

async function fakePdfConverter({ pdfPath }) {
  await writeFile(pdfPath, Buffer.from(`%PDF-1.4\n${PDF_TEXT}\n%%EOF`), { mode: 0o600 });
}

async function fakePdfInspector({ pdfPath }) {
  return { pageCount: 1, a4: true, text: (await readFile(pdfPath, 'utf8')) };
}

async function cleanup(ids) {
  const database = openDatabase(ids.databasePath);
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  database.exec('PRAGMA journal_mode = DELETE');
  database.close();
  await rm(ids.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function issueArguments(ids, changes = {}) {
  return {
    databasePath: ids.databasePath,
    token: TOKEN,
    confirmingUser: 'test-user',
    sourceChannel: 'test',
    sourceChat: 'test-chat',
    clientInitials: 'SC',
    outputRoot: ids.outputRoot,
    testMode: true,
    pdfConverter: fakePdfConverter,
    pdfInspector: fakePdfInspector,
    now: '2026-07-29T00:03:00.000Z',
    ...changes
  };
}

test('confirmed quotation issues deterministically and totals match the issuance ledger', async () => {
  const ids = await fixture();
  try {
    await addConfirmation(ids);
    const firstRender = await renderQuotationDocx({ snapshot: ids.draft.snapshot, documentNumber: DOCUMENT_NUMBER, testMode: true });
    const secondRender = await renderQuotationDocx({ snapshot: ids.draft.snapshot, documentNumber: DOCUMENT_NUMBER, testMode: true });
    assert.equal(firstRender.sha256, secondRender.sha256);

    const issued = await issueConfirmedQuotation(issueArguments(ids));
    assert.equal(issued.status, 'ISSUED');
    assert.equal(issued.quotation_status, 'ISSUED');
    assert.equal(issued.quotation_number, DOCUMENT_NUMBER);
    const [docx, pdf] = await Promise.all([readFile(path.join(ids.outputRoot, issued.docx_relative_path)), readFile(path.join(ids.outputRoot, issued.pdf_relative_path))]);
    assert.equal(sha256(docx), issued.docx_sha256);
    assert.equal(sha256(pdf), issued.pdf_sha256);
    const { xml } = readDocumentXml(docx);
    assert.ok(xml.includes('TEST / NOT VALID'));
    assert.ok(xml.includes('RM 100.00'));
    const database = openDatabase(ids.databasePath, { readOnly: true });
    const quotation = database.prepare('SELECT * FROM quotations WHERE id = ?').get(ids.draft.id);
    assert.equal(quotation.total_minor, 10000);
    assert.equal(quotation.document_hash, issued.pdf_sha256);
    assert.equal(database.prepare('SELECT status FROM document_numbers WHERE entity_id = ?').get(ids.draft.id).status, 'ISSUED');
    database.close();

    await assert.rejects(
      publishImmutableBuffer(path.join(ids.outputRoot, issued.pdf_relative_path), Buffer.from('replacement')),
      /EEXIST/
    );
    assert.equal(sha256(await readFile(path.join(ids.outputRoot, issued.pdf_relative_path))), issued.pdf_sha256);
  } finally {
    await cleanup(ids);
  }
});

test('unconfirmed, reused, and wrong-user confirmation tokens are refused without extra allocations', async () => {
  const ids = await fixture();
  try {
    await assert.rejects(issueConfirmedQuotation(issueArguments(ids, { token: 'QD-DDDDDDDDDD' })), /CONFIRMATION_TOKEN_NOT_FOUND/);
    await addConfirmation(ids);
    await assert.rejects(issueConfirmedQuotation(issueArguments(ids, { confirmingUser: 'wrong-user' })), /CONFIRMING_USER_MISMATCH/);
    let database = openDatabase(ids.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_numbers').get().count, 0);
    assert.equal(database.prepare('SELECT status FROM pending_confirmations WHERE token = ?').get(TOKEN).status, 'PENDING');
    database.close();
    await issueConfirmedQuotation(issueArguments(ids));
    await assert.rejects(issueConfirmedQuotation(issueArguments(ids, { now: '2026-07-29T00:04:00.000Z' })), /CONFIRMATION_TOKEN_NOT_PENDING/);
    database = openDatabase(ids.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_numbers').get().count, 1);
    database.close();
  } finally {
    await cleanup(ids);
  }
});

test('renderer failure records ISSUE_FAILED and retry retains the allocated number', async () => {
  const ids = await fixture();
  try {
    await addConfirmation(ids);
    await assert.rejects(issueConfirmedQuotation(issueArguments(ids, {
      documentRenderer: async () => { throw new Error('SYNTHETIC_RENDER_FAILURE'); }
    })), /SYNTHETIC_RENDER_FAILURE/);
    let database = openDatabase(ids.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT status FROM quotations WHERE id = ?').get(ids.draft.id).status, 'ISSUE_FAILED');
    const failedNumber = database.prepare('SELECT * FROM document_numbers WHERE entity_id = ?').get(ids.draft.id);
    assert.equal(failedNumber.document_number, DOCUMENT_NUMBER);
    assert.equal(failedNumber.status, 'ISSUE_FAILED');
    assert.equal(database.prepare('SELECT result FROM quotation_issuance_attempts WHERE quotation_id = ?').get(ids.draft.id).result, 'FAILED');
    database.close();

    const retried = await retryQuotationIssuance({
      databasePath: ids.databasePath,
      quotationId: ids.draft.id,
      retryingUser: 'test-user',
      outputRoot: ids.outputRoot,
      testMode: true,
      pdfConverter: fakePdfConverter,
      pdfInspector: fakePdfInspector,
      now: '2026-07-29T00:05:00.000Z'
    });
    assert.equal(retried.quotation_number, DOCUMENT_NUMBER);
    assert.equal(retried.attempt_count, 2);
    database = openDatabase(ids.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_numbers').get().count, 1);
    assert.deepEqual(database.prepare('SELECT result FROM quotation_issuance_attempts WHERE quotation_id = ? ORDER BY attempt_number').all(ids.draft.id).map((row) => row.result), ['FAILED', 'SUCCEEDED']);
    database.close();
  } finally {
    await cleanup(ids);
  }
});

test('cancellation preserves issued files and retires the allocated number', async () => {
  const ids = await fixture();
  try {
    await addConfirmation(ids);
    const issued = await issueConfirmedQuotation(issueArguments(ids));
    const pdfPath = path.join(ids.outputRoot, issued.pdf_relative_path);
    const before = sha256(await readFile(pdfPath));
    const cancelled = cancelQuotationIssuance({
      databasePath: ids.databasePath,
      quotationId: ids.draft.id,
      cancellingUser: 'test-user',
      reason: 'TEST cancellation — NOT VALID',
      now: '2026-07-29T00:06:00.000Z'
    });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(before, sha256(await readFile(pdfPath)));
    const database = openDatabase(ids.databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT status FROM document_numbers WHERE entity_id = ?').get(ids.draft.id).status, 'CANCELLED');
    database.close();
  } finally {
    await cleanup(ids);
  }
});

const hasLibreOffice = spawnSync('soffice', ['--version'], { windowsHide: true }).status === 0;
test('LibreOffice produces a validated local A4 PDF from a confirmed test quotation', { skip: !hasLibreOffice }, async () => {
  const ids = await fixture();
  try {
    await addConfirmation(ids);
    const issued = await issueConfirmedQuotation(issueArguments(ids, { pdfConverter: undefined, pdfInspector: undefined }));
    assert.equal(issued.status, 'ISSUED');
    const issuedDocxPath = path.join(ids.outputRoot, issued.docx_relative_path);
    const issuedPdf = await readFile(path.join(ids.outputRoot, issued.pdf_relative_path));
    assert.equal(issuedPdf.subarray(0, 5).toString(), '%PDF-');
    const repeatDirectory = await mkdtemp(path.join(ids.directory, 'repeat-pdf-'));
    const repeatPdfPath = path.join(repeatDirectory, 'quotation.pdf');
    await convertDocxToPdf({ docxPath: issuedDocxPath, pdfPath: repeatPdfPath });
    assert.equal(sha256(await readFile(repeatPdfPath)), sha256(issuedPdf));
  } finally {
    await cleanup(ids);
  }
});
