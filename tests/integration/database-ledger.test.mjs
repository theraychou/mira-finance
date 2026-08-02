import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { backupDatabase } from '../../scripts/backup-database.mjs';
import { checkDatabase } from '../../scripts/check-database.mjs';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { migrateDown, migrateUp } from '../../scripts/lib/migrations.mjs';
import {
  allocateDocumentNumber,
  formatDocumentNumber,
  updateDocumentNumberStatus
} from '../../scripts/lib/numbering.mjs';
import { verifyCommonLedgerEquivalence, verifyLedgerEquivalence } from '../../scripts/verify-ledger-equivalence.mjs';

async function temporaryLedger() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-f3-'));
  const databasePath = path.join(directory, 'finance.sqlite3');
  await migrateUp({ databasePath, now: () => '2026-07-29T00:00:00.000Z' });
  return { directory, databasePath };
}

function allocateInWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../helpers/allocate-number-worker.mjs', import.meta.url), { workerData });
    worker.once('message', (message) => message.ok ? resolve(message.allocation) : reject(new Error(message.error)));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`allocation worker exited with code ${code}`));
    });
  });
}

test('database migrations are reversible and create the complete F17B ledger', async () => {
  const { directory, databasePath } = await temporaryLedger();
  try {
    assert.deepEqual(checkDatabase(databasePath), {
      ok: true,
      integrity: ['ok'],
      foreignKeyViolations: 0,
      schemaVersion: 12
    });
    const database = openDatabase(databasePath, { readOnly: true });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    database.close();
    for (const table of [
      'business_entities', 'customers', 'customer_aliases', 'quotations',
      'quotation_line_items', 'invoices', 'invoice_line_items', 'claims',
      'pending_confirmations', 'audit_events', 'number_sequences', 'document_numbers',
      'currencies', 'bank_profiles', 'tax_rules', 'quotation_draft_state', 'quotation_draft_versions',
      'quotation_issuances', 'quotation_issuance_attempts', 'invoice_draft_state',
      'invoice_draft_versions', 'invoice_issuances', 'invoice_issuance_attempts',
      'invoice_payment_drafts', 'invoice_payment_events', 'drive_uploads', 'drive_upload_attempts',
      'claim_receipts', 'claim_draft_state', 'claim_draft_versions', 'claim_filings', 'claim_filing_attempts',
      'suppliers', 'supplier_aliases', 'supplier_invoices', 'supplier_invoice_documents',
      'supplier_invoice_draft_state', 'supplier_invoice_draft_versions', 'supplier_invoice_approvals',
      'supplier_invoice_filings', 'supplier_invoice_filing_attempts', 'claim_recharges',
      'claim_recharge_events', 'claim_recharge_confirmations', 'claim_invoice_links',
      'claim_submission_packs', 'claim_submission_pack_items', 'report_exports'
      , 'credit_notes', 'credit_note_line_items', 'credit_note_draft_state',
      'credit_note_draft_versions', 'correction_confirmations', 'credit_note_issuances',
      'credit_note_issuance_attempts', 'document_cancellations', 'replacement_document_links',
      'document_status_history', 'correction_drive_filings'
      , 'customer_delivery_contacts', 'customer_delivery_requests', 'customer_delivery_attempts',
      'customer_inbound_messages', 'customer_reply_escalations', 'customer_inbound_response_attempts'
    ]) assert.ok(tables.includes(table), `missing table ${table}`);

    const inboundDown = await migrateDown({ databasePath });
    assert.equal(inboundDown.version, 11);
    const deliveryDown = await migrateDown({ databasePath });
    assert.equal(deliveryDown.version, 10);
    const correctionsDown = await migrateDown({ databasePath });
    assert.equal(correctionsDown.version, 9);
    const reportsDown = await migrateDown({ databasePath });
    assert.equal(reportsDown.version, 8);
    const supplierInvoicesDown = await migrateDown({ databasePath });
    assert.equal(supplierInvoicesDown.version, 7);
    const claimsDown = await migrateDown({ databasePath });
    assert.equal(claimsDown.version, 6);
    const driveDown = await migrateDown({ databasePath });
    assert.equal(driveDown.version, 5);
    const invoiceDown = await migrateDown({ databasePath });
    assert.equal(invoiceDown.version, 4);
    const issuanceDown = await migrateDown({ databasePath });
    assert.equal(issuanceDown.version, 3);
    const draftDown = await migrateDown({ databasePath });
    assert.equal(draftDown.version, 2);
    const registryDown = await migrateDown({ databasePath });
    assert.equal(registryDown.version, 1);
    const down = await migrateDown({ databasePath });
    assert.equal(down.version, 0);
    const reverted = openDatabase(databasePath, { readOnly: true });
    const remaining = reverted.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    reverted.close();
    assert.deepEqual(remaining.filter((name) => name !== 'schema_migrations'), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('drafts do not consume or accept official numbers and duplicate numbers are rejected', async () => {
  const { directory, databasePath } = await temporaryLedger();
  try {
    const database = openDatabase(databasePath);
    database.prepare(`
      INSERT INTO quotations (status, created_by, created_at) VALUES ('DRAFT', 'test-operator', '2026-07-29T00:00:00.000Z')
    `).run();
    assert.throws(() => database.prepare(`
      INSERT INTO quotations (quotation_number, status, created_by, created_at)
      VALUES ('2607291001-TEST', 'DRAFT', 'test-operator', '2026-07-29T00:00:00.000Z')
    `).run(), /constraint/i);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_numbers').get().count, 0);
    database.close();

    const allocation = allocateDocumentNumber({
      databasePath,
      documentType: 'quotation',
      sequenceDate: '2026-07-29',
      clientInitials: 'TEST',
      now: '2026-07-29T00:01:00.000Z'
    });
    const duplicate = openDatabase(databasePath);
    assert.throws(() => duplicate.prepare(`
      INSERT INTO document_numbers (
        document_type, sequence_date, sequence_value, client_initials,
        document_number, status, allocated_at, updated_at
      ) VALUES ('quotation', '2026-07-30', 1001, 'TEST', ?, 'ALLOCATED', ?, ?)
    `).run(allocation.documentNumber, '2026-07-29T00:02:00.000Z', '2026-07-29T00:02:00.000Z'), /unique/i);
    duplicate.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent allocations remain unique and use the approved daily format', async () => {
  const { directory, databasePath } = await temporaryLedger();
  try {
    const allocations = await Promise.all(Array.from({ length: 12 }, () => allocateInWorker({
      databasePath,
      documentType: 'invoice',
      sequenceDate: '2026-07-29',
      clientInitials: 'AC',
      now: '2026-07-29T01:00:00.000Z'
    })));
    assert.equal(new Set(allocations.map((item) => item.documentNumber)).size, 12);
    assert.deepEqual(
      allocations.map((item) => item.sequenceValue).sort((left, right) => left - right),
      Array.from({ length: 12 }, (_, index) => 1001 + index)
    );
    for (const allocation of allocations) assert.match(allocation.documentNumber, /^26072910\d{2}-AC$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quotation and invoice numbers share one collision-free daily sequence', async () => {
  const { directory, databasePath } = await temporaryLedger();
  try {
    const quotation = allocateDocumentNumber({
      databasePath, documentType: 'quotation', sequenceDate: '2026-07-30',
      clientInitials: 'FM', now: '2026-07-30T00:00:00.000Z'
    });
    const invoice = allocateDocumentNumber({
      databasePath, documentType: 'invoice', sequenceDate: '2026-07-30',
      clientInitials: 'FM', now: '2026-07-30T00:01:00.000Z'
    });
    assert.equal(quotation.documentNumber, '2607301001-FM');
    assert.equal(invoice.documentNumber, '2607301002-FM');
    assert.notEqual(quotation.documentNumber, invoice.documentNumber);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed and cancelled allocations retain their numbers and are never reused', async () => {
  const { directory, databasePath } = await temporaryLedger();
  try {
    const first = allocateDocumentNumber({
      databasePath,
      documentType: 'quotation',
      sequenceDate: '2026-07-29',
      clientInitials: 'AB'
    });
    updateDocumentNumberStatus({ databasePath, allocationId: first.id, status: 'ISSUE_FAILED' });
    updateDocumentNumberStatus({ databasePath, allocationId: first.id, status: 'CANCELLED' });
    assert.throws(() => updateDocumentNumberStatus({ databasePath, allocationId: first.id, status: 'GENERATING' }), /Invalid number status transition/);
    const second = allocateDocumentNumber({
      databasePath,
      documentType: 'quotation',
      sequenceDate: '2026-07-29',
      clientInitials: 'AB'
    });
    assert.equal(first.documentNumber, '2607291001-AB');
    assert.equal(second.documentNumber, '2607291002-AB');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('audit events are append-only and SQLite-safe backups restore cleanly', async () => {
  const { directory, databasePath } = await temporaryLedger();
  try {
    const database = openDatabase(databasePath);
    const audit = database.prepare(`
      INSERT INTO audit_events (
        timestamp, actor, action, entity_type, result, details_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('2026-07-29T00:00:00.000Z', 'test-operator', 'test.created', 'test', 'PASS', '{}');
    assert.throws(() => database.prepare('UPDATE audit_events SET result = ? WHERE id = ?').run('FAIL', audit.lastInsertRowid), /append-only/);
    assert.throws(() => database.prepare('DELETE FROM audit_events WHERE id = ?').run(audit.lastInsertRowid), /append-only/);
    database.close();

    const backupPath = path.join(directory, 'backups', 'finance-test.sqlite3');
    const result = await backupDatabase({ sourcePath: databasePath, destinationPath: backupPath });
    assert.equal(result.ok, true);
    const restored = openDatabase(backupPath, { readOnly: true });
    assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);
    restored.close();
    assert.equal(verifyLedgerEquivalence(databasePath, backupPath).tableCount, 66);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('number formatting rejects ambiguous or invalid inputs', () => {
  assert.equal(formatDocumentNumber({ sequenceDate: '2026-07-29', sequenceValue: 1001, clientInitials: 'RC' }), '2607291001-RC');
  assert.throws(() => formatDocumentNumber({ sequenceDate: '2026-02-30', sequenceValue: 1001, clientInitials: 'RC' }), /real calendar date/);
  assert.throws(() => formatDocumentNumber({ sequenceDate: '2026-07-29', sequenceValue: 1001, clientInitials: '../RC' }), /uppercase letters or digits/);
});

test('F17B schema upgrade preserves every pre-existing ledger table', async () => {
  const { directory, databasePath } = await temporaryLedger();
  try {
    await migrateDown({ databasePath });
    const beforePath = path.join(directory, 'before-f17b.sqlite3');
    await backupDatabase({ sourcePath: databasePath, destinationPath: beforePath });
    await migrateUp({ databasePath, now: () => '2026-07-31T00:00:00.000Z' });
    assert.equal(verifyCommonLedgerEquivalence(databasePath, beforePath).tableCount, 62);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
