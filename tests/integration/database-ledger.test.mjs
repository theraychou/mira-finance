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

test('database migrations are reversible and create the complete F6 ledger', async () => {
  const { directory, databasePath } = await temporaryLedger();
  try {
    assert.deepEqual(checkDatabase(databasePath), {
      ok: true,
      integrity: ['ok'],
      foreignKeyViolations: 0,
      schemaVersion: 4
    });
    const database = openDatabase(databasePath, { readOnly: true });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    database.close();
    for (const table of [
      'business_entities', 'customers', 'customer_aliases', 'quotations',
      'quotation_line_items', 'invoices', 'invoice_line_items', 'claims',
      'pending_confirmations', 'audit_events', 'number_sequences', 'document_numbers',
      'currencies', 'bank_profiles', 'tax_rules', 'quotation_draft_state', 'quotation_draft_versions',
      'quotation_issuances', 'quotation_issuance_attempts'
    ]) assert.ok(tables.includes(table), `missing table ${table}`);

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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('number formatting rejects ambiguous or invalid inputs', () => {
  assert.equal(formatDocumentNumber({ sequenceDate: '2026-07-29', sequenceValue: 1001, clientInitials: 'RC' }), '2607291001-RC');
  assert.throws(() => formatDocumentNumber({ sequenceDate: '2026-02-30', sequenceValue: 1001, clientInitials: 'RC' }), /real calendar date/);
  assert.throws(() => formatDocumentNumber({ sequenceDate: '2026-07-29', sequenceValue: 1001, clientInitials: '../RC' }), /uppercase letters or digits/);
});
