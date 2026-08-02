import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backupDatabase } from '../../scripts/backup-database.mjs';
import { createStandaloneInvoiceDraft, createInvoiceConfirmationToken } from '../../scripts/lib/invoice-drafts.mjs';
import { issueConfirmedInvoice, retryInvoiceIssuance } from '../../scripts/lib/invoice-issuance.mjs';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import { recoverInterruptedIssuances, runRestoreDrill } from '../../scripts/lib/recovery.mjs';
import { assertDiskSpace, cleanupTemporaryFiles, recordFailureAlert, rotateJsonlLogs } from '../../scripts/lib/runtime-safety.mjs';
import { renderConvertAndFile } from '../../scripts/lib/quotation-renderer.mjs';
import { renderInvoiceDocx } from '../../scripts/lib/invoice-renderer.mjs';

const NOW = '2026-08-01T00:00:00.000Z';

async function ledger() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-f16-'));
  const databasePath = path.join(root, 'data', 'finance.sqlite3');
  await migrateUp({ databasePath, now: () => NOW });
  return { root, databasePath };
}
async function cleanup(value) {
  await rm(value.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('backup restore drill recreates an equivalent ledger in an isolated location', async () => {
  const value = await ledger();
  try {
    const database = openDatabase(value.databasePath); database.prepare("INSERT INTO audit_events (timestamp,actor,action,entity_type,entity_id,result,details_json) VALUES (?,'test-operator','TEST_RESTORE_DRILL','system',1,'PASS','{}')").run(NOW); database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); database.exec('PRAGMA journal_mode=DELETE'); database.close();
    const backup = path.join(value.root, 'data', 'backups', 'TEST-NOT-VALID.sqlite3');
    const restored = path.join(value.root, 'data', 'restore-drills', 'TEST-NOT-VALID.sqlite3');
    await backupDatabase({ sourcePath: value.databasePath, destinationPath: backup });
    const result = await runRestoreDrill({ backupPath: backup, targetPath: restored });
    assert.equal(result.schemaVersion, 12); assert.equal(result.tableCount, 66); assert.equal((await stat(restored)).isFile(), true);
  } finally { await cleanup(value); }
});

test('runtime maintenance is scoped, bounded, private, and redacted', async () => {
  const value = await ledger();
  try {
    const staging = path.join(value.root, 'generated', '.staging-TEST-NOT-VALID'); await mkdir(staging, { recursive: true });
    const old = new Date('2026-07-01T00:00:00.000Z'); await utimes(staging, old, old);
    const unrelated = path.join(value.root, 'generated', 'keep.txt'); await writeFile(unrelated, 'TEST / NOT VALID');
    const removed = await cleanupTemporaryFiles({ root: value.root, olderThanMs: 1000, now: new Date(NOW).valueOf() });
    assert.deepEqual(removed.removed, ['generated/.staging-TEST-NOT-VALID']); assert.equal((await stat(unrelated)).isFile(), true);
    await recordFailureAlert({ root: value.root, code: 'PDF_CONVERSION_FAILED', operation: 'INVOICE_ISSUANCE', entityType: 'invoice', entityId: 1, now: NOW });
    const alert = await readFile(path.join(value.root, 'logs', 'alerts.jsonl'), 'utf8');
    assert.match(alert, /PDF_CONVERSION_FAILED/); assert.doesNotMatch(alert, /customer|token|bank|oauth/i);
    await writeFile(path.join(value.root, 'logs', 'large.jsonl'), `${'x'.repeat(2048)}\n`, { mode: 0o600 });
    assert.deepEqual((await rotateJsonlLogs({ root: value.root, maximumBytes: 1024, retained: 2 })).rotated, ['large.jsonl']);
    assert.ok((await assertDiskSpace({ targetPath: value.root, minimumFreeBytes: 0, minimumFreeRatio: 0 })).freeBytes > 0);
    await assert.rejects(() => assertDiskSpace({ targetPath: value.root, minimumFreeBytes: Number.MAX_SAFE_INTEGER, minimumFreeRatio: 0 }), /DISK_SPACE_PROTECTION_TRIGGERED/);
  } finally { await cleanup(value); }
});

async function invoiceFixture(value) {
  const database = openDatabase(value.databasePath);
  const entityId = Number(database.prepare("INSERT INTO business_entities (legal_name,trading_name,default_currency,active,created_at,updated_at) VALUES ('TEST ENTITY / NOT VALID','TEST','MYR',1,?,?)").run(NOW,NOW).lastInsertRowid);
  const customerId = Number(database.prepare("INSERT INTO customers (customer_code,legal_name,display_name,billing_address,default_currency,default_payment_terms_days,active,created_at,updated_at) VALUES ('TEST-F16','TEST CUSTOMER / NOT VALID','TEST','TEST ADDRESS / NOT VALID','MYR',30,1,?,?)").run(NOW,NOW).lastInsertRowid);
  database.prepare("INSERT INTO bank_profiles (id,display_name,business_entity_id,currency,bank_name,account_name,account_number,active,created_at,updated_at) VALUES ('cimb-myr','TEST / NOT VALID',?,'MYR','TEST BANK','TEST','TEST-0000',1,?,?)").run(entityId,NOW,NOW);
  database.prepare("UPDATE currencies SET default_bank_profile_id='cimb-myr' WHERE code='MYR'").run(); database.close();
  const draft = createStandaloneInvoiceDraft({ databasePath:value.databasePath,actor:'test-operator',now:NOW,input:{customer_id:customerId,business_entity_id:entityId,currency:'MYR',issue_date:'2026-08-01',payment_terms_days:30,service_date:'2026-08-01',payment_terms:'TEST ONLY',notes:'TEST / NOT VALID',line_items:[{description:'TEST / NOT VALID',quantity:'1',unit:'service',unit_price_minor:10000}],discount:{type:'NONE'},tax:{mode:'NONE'}} });
  createInvoiceConfirmationToken({databasePath:value.databasePath,invoiceId:draft.id,requestingUser:'test-operator',sourceChannel:'test',sourceChat:'test-chat',tokenFactory:()=> 'ID-FFFFFFFFFF',now:'2026-08-01T00:01:00.000Z'});
  return draft;
}
async function fakePdf({ pdfPath }) { await writeFile(pdfPath, Buffer.from('%PDF-1.4\n2608011001-SC RM 100.00 TEST / NOT VALID\n%%EOF'), { mode: 0o600 }); }
async function inspectPdf({ pdfPath }) { return { pageCount:1,a4:true,text:await readFile(pdfPath,'utf8') }; }

test('conversion failure and interrupted issuance recover with the same number; duplicate delivery cannot issue twice', async () => {
  const value = await ledger();
  try {
    const draft = await invoiceFixture(value), outputRoot = path.join(value.root, 'generated', 'invoices');
    await assert.rejects(() => issueConfirmedInvoice({databasePath:value.databasePath,token:'ID-FFFFFFFFFF',confirmingUser:'test-operator',sourceChannel:'test',sourceChat:'test-chat',clientInitials:'SC',root:path.resolve('.'),outputRoot,testMode:true,pdfConverter:async()=>{throw new Error('PDF_CONVERSION_FAILED');},pdfInspector:inspectPdf,now:'2026-08-01T00:02:00.000Z'}), /PDF_CONVERSION_FAILED/);
    let database = openDatabase(value.databasePath); const number = database.prepare('SELECT invoice_number FROM invoices WHERE id=?').get(draft.id).invoice_number;
    const crashOutput = await renderConvertAndFile({root:path.resolve('.'),outputRoot:path.join(value.root,'crash-output'),snapshot:draft.snapshot,documentNumber:number,testMode:true,documentRenderer:renderInvoiceDocx,pdfConverter:fakePdf,pdfInspector:inspectPdf});
    const finalDirectory=path.join(outputRoot,'2026','08');await mkdir(finalDirectory,{recursive:true,mode:0o700});await copyFile(crashOutput.docxPath,path.join(finalDirectory,`${number}.docx`));await copyFile(crashOutput.pdfPath,path.join(finalDirectory,`${number}.pdf`));
    database.prepare("UPDATE invoices SET status='GENERATING' WHERE id=?").run(draft.id); database.prepare("UPDATE invoice_issuances SET status='GENERATING',updated_at='2026-08-01T00:02:00.000Z' WHERE invoice_id=?").run(draft.id); database.prepare("UPDATE document_numbers SET status='GENERATING' WHERE entity_id=? AND document_type='invoice'").run(draft.id); database.close();
    assert.equal(recoverInterruptedIssuances({databasePath:value.databasePath,actor:'test-operator',staleBefore:'2026-08-01T00:03:00.000Z',now:'2026-08-01T00:04:00.000Z'}).length,1);
    const issued = await retryInvoiceIssuance({databasePath:value.databasePath,invoiceId:draft.id,retryingUser:'test-operator',root:path.resolve('.'),outputRoot,testMode:true,pdfConverter:fakePdf,pdfInspector:inspectPdf,now:'2026-08-01T00:05:00.000Z'});
    assert.equal(issued.invoice_status,'ISSUED'); assert.equal(issued.invoice_number,number); assert.equal(issued.attempt_count,2);
    await assert.rejects(() => issueConfirmedInvoice({databasePath:value.databasePath,token:'ID-FFFFFFFFFF',confirmingUser:'test-operator',sourceChannel:'test',sourceChat:'test-chat',clientInitials:'SC',root:path.resolve('.'),outputRoot,testMode:true,pdfConverter:fakePdf,pdfInspector:inspectPdf}), /CONFIRMATION_TOKEN_NOT_PENDING/);
    database = openDatabase(value.databasePath,{readOnly:true}); assert.equal(database.prepare('SELECT COUNT(*) count FROM invoice_issuances').get().count,1); const relative=database.prepare('SELECT pdf_relative_path FROM invoice_issuances WHERE invoice_id=?').get(draft.id).pdf_relative_path; database.close();
    assert.equal((await readFile(path.join(outputRoot,relative))).subarray(0,5).toString(),'%PDF-');
  } finally { await cleanup(value); }
});

test('database lock contention waits and completes without duplicate numbers', async () => {
  const value = await ledger();
  try {
    const database = openDatabase(value.databasePath); database.exec('BEGIN IMMEDIATE');
    const worker = new Worker(new URL('../helpers/allocate-number-worker.mjs', import.meta.url), { workerData:{databasePath:value.databasePath,documentType:'invoice',sequenceDate:'2026-08-01',clientInitials:'SC',now:NOW} });
    const outcome = new Promise((resolve,reject)=>{worker.once('message',m=>m.ok?resolve(m.allocation):reject(new Error(m.error)));worker.once('error',reject);});
    await new Promise((resolve)=>setTimeout(resolve,150)); database.exec('COMMIT'); database.close();
    const allocation = await outcome; await worker.terminate();
    assert.equal(allocation.documentNumber,'2608011001-SC');
  } finally { await cleanup(value); }
});
