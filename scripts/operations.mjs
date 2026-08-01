#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDatabasePath } from './lib/database.mjs';
import { recoverInterruptedIssuances, runRestoreDrill } from './lib/recovery.mjs';
import { assertDiskSpace, auditPrivatePermissions, cleanupTemporaryFiles, recordFailureAlert, rotateJsonlLogs } from './lib/runtime-safety.mjs';
import { repositoryRoot } from './validate-config.mjs';
import { retryQuotationIssuance } from './lib/quotation-issuance.mjs';
import { retryInvoiceIssuance } from './lib/invoice-issuance.mjs';
import { retryCreditNoteIssuance } from './lib/corrections.mjs';

function value(flag) { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : undefined; }
function inside(relative, approvedRoot) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Only workspace-relative paths are accepted.');
  const base = path.resolve(repositoryRoot, approvedRoot), candidate = path.resolve(repositoryRoot, relative);
  if (!candidate.startsWith(`${base}${path.sep}`)) throw new Error('Path is outside the approved operations area.');
  return candidate;
}

async function main() {
  if (!process.argv.includes('--admin')) throw new Error('DENIED --admin is required for F16 operations.');
  const actor = value('--actor'); if (!actor) throw new Error('DENIED --actor is required.');
  const action = value('--action');
  const databasePath = value('--database') ? inside(value('--database'), 'data') : defaultDatabasePath;
  const config = JSON.parse(await readFile(path.join(repositoryRoot, 'config', 'foundation.json'), 'utf8'));
  let result;
  if (action === 'restore-drill') {
    result = await runRestoreDrill({ backupPath: inside(value('--backup'), path.join('data', 'backups')), targetPath: inside(value('--target'), path.join('data', 'restore-drills')) });
  } else if (action === 'recover-issuances') {
    result = recoverInterruptedIssuances({ databasePath, actor, staleBefore: value('--stale-before'), now: value('--now') ?? new Date().toISOString() });
    for (const item of result) await recordFailureAlert({ root: repositoryRoot, code: 'INTERRUPTED_ISSUANCE', operation: 'ISSUANCE_RECOVERY', entityType: item.documentType, entityId: item.entityId });
  } else if (action === 'permission-audit') {
    const audit = await auditPrivatePermissions(repositoryRoot);
    result = { ok: audit.ok, permissionExceptionCount: audit.exceptions.length, symlinkCount: audit.symlinks.length };
    if (!audit.ok) { await recordFailureAlert({ root: repositoryRoot, code: 'PERMISSION_AUDIT_FAILED', operation: 'PERMISSION_AUDIT' }); process.exitCode = 1; }
  } else if (action === 'disk-audit') {
    result = await assertDiskSpace({ targetPath: repositoryRoot, minimumFreeBytes: config.operations.minimumFreeBytes, minimumFreeRatio: config.operations.minimumFreeRatio });
  } else if (action === 'rotate-logs') {
    result = await rotateJsonlLogs({ root: repositoryRoot, maximumBytes: config.operations.logRotationMaximumBytes, retained: config.operations.logRotationRetained });
  } else if (action === 'cleanup-temp') {
    result = await cleanupTemporaryFiles({ root: repositoryRoot, olderThanMs: config.operations.temporaryFileMaximumAgeHours * 60 * 60 * 1000 });
  } else if (action === 'retry-quotation') {
    result = await retryQuotationIssuance({ databasePath, quotationId: Number(value('--entity-id')), retryingUser: actor, testMode: process.argv.includes('--test-mode') });
  } else if (action === 'retry-invoice') {
    result = await retryInvoiceIssuance({ databasePath, invoiceId: Number(value('--entity-id')), retryingUser: actor, testMode: process.argv.includes('--test-mode') });
  } else if (action === 'retry-credit-note') {
    result = await retryCreditNoteIssuance({ databasePath, creditNoteId: Number(value('--entity-id')), retryingUser: actor, testMode: process.argv.includes('--test-mode') });
  } else throw new Error('Unsupported --action.');
  console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const candidate = typeof error?.code === 'string' ? error.code : error?.message;
    const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(candidate) ? candidate : 'OPERATION_FAILED';
    await recordFailureAlert({ root: repositoryRoot, code, operation: 'F16_OPERATION' }).catch(() => {});
    console.error(`FAIL F16 operation (${code})`); process.exitCode = 1;
  });
}
