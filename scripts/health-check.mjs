#!/usr/bin/env node
import { access, lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDatabase } from './check-database.mjs';
import { loadDriveConfiguration } from './lib/drive-configuration.mjs';
import { loadWhatsAppRoutingConfiguration } from './lib/whatsapp-routing.mjs';
import { loadCustomerDeliveryConfig } from './lib/customer-delivery-config.mjs';
import { loadCustomerInboundConfig } from './lib/customer-inbound-config.mjs';
import { assertDiskSpace } from './lib/runtime-safety.mjs';
import { runValidation, repositoryRoot } from './validate-config.mjs';

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function countFiles(root, extension) {
  if (!await exists(root)) return 0;
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) total += await countFiles(candidate, extension);
    if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) total += 1;
  }
  return total;
}

async function countAlertRecords(root) {
  try {
    const content = await readFile(path.join(root, 'logs', 'alerts.jsonl'), 'utf8');
    return content.split(/\r?\n/).filter(Boolean).length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

function check(name, status, detail) {
  return { name, status, detail };
}

async function auditWorkspaceTree(root) {
  const permissionExceptions = [];
  const symlinks = [];

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const metadata = await lstat(candidate);
      const relative = path.relative(root, candidate).split(path.sep).join('/');

      if ((metadata.mode & 0o077) !== 0) permissionExceptions.push(relative);
      if (metadata.isSymbolicLink()) {
        symlinks.push(relative);
      } else if (metadata.isDirectory()) {
        await walk(candidate);
      }
    }
  }

  await walk(root);
  return { permissionExceptions, symlinks };
}

export async function runHealthCheck({ root = repositoryRoot, env = process.env } = {}) {
  const checks = [];
  const foundation = JSON.parse(await readFile(path.join(root, 'config', 'foundation.json'), 'utf8'));
  const requiredFiles = ['README.md', 'AGENTS.md', 'SOUL.md', 'config/foundation.json'];
  const requiredDirectories = [
    'logs',
    'templates/source',
    'templates/normalized',
    'tests/unit',
    'tests/integration',
    'tests/regression'
  ];

  for (const relative of requiredFiles) {
    checks.push(check(`file:${relative}`, await exists(path.join(root, relative)) ? 'PASS' : 'FAIL', 'required foundation file'));
  }
  for (const relative of requiredDirectories) {
    checks.push(check(`directory:${relative}`, await exists(path.join(root, relative)) ? 'PASS' : 'FAIL', 'required foundation directory'));
  }

  const validation = await runValidation(root);
  checks.push(check('configuration', validation.ok ? 'PASS' : 'FAIL', validation.ok ? 'schema validation passed' : 'schema validation failed'));

  if (process.platform === 'linux') {
    const mode = (await stat(root)).mode & 0o777;
    const treeAudit = await auditWorkspaceTree(root);
    const privateTree = mode === 0o700 && treeAudit.permissionExceptions.length === 0;
    checks.push(check(
      'workspace-permissions',
      privateTree ? 'PASS' : 'FAIL',
      privateTree
        ? 'root is 0700 and all descendants deny group/other access'
        : `root mode 0${mode.toString(8)}; ${treeAudit.permissionExceptions.length} descendant permission exception(s)`
    ));
    checks.push(check(
      'workspace-symlinks',
      treeAudit.symlinks.length === 0 ? 'PASS' : 'FAIL',
      treeAudit.symlinks.length === 0 ? 'no symlinks found' : `${treeAudit.symlinks.length} symlink(s) found`
    ));
  } else {
    checks.push(check('workspace-permissions', 'SKIP', 'checked on the Linux deployment host'));
    checks.push(check('workspace-symlinks', 'SKIP', 'checked on the Linux deployment host'));
  }

  const databasePresent = await exists(path.join(root, 'data', 'finance.sqlite3'));
  let databaseDetail = `${foundation.project.phase} runtime database is not initialised`;
  let databaseStatus = 'NOT_CONFIGURED';
  if (databasePresent) {
    const databaseCheck = checkDatabase(path.join(root, 'data', 'finance.sqlite3'));
    const schemaVersions = { F3: 1, F4: 2, F5: 3, F6: 4, F7: 5, F8: 6, F9: 6, F10: 6, F11: 6, F12: 7, F13: 8, F14: 9, F15: 10, F16: 10, F17A: 11, F17B: 12 };
    const requiredSchemaVersion = schemaVersions[foundation.project.phase] ?? 1;
    const databaseReady = databaseCheck.ok && databaseCheck.schemaVersion >= requiredSchemaVersion;
    databaseStatus = databaseReady ? 'CONFIGURED' : 'FAIL';
    databaseDetail = databaseReady
      ? `${foundation.project.phase} schema version ${databaseCheck.schemaVersion}; integrity passed`
      : `Database requires schema version ${requiredSchemaVersion} and a passing integrity check`;
  }
  checks.push(check('optional:database', databaseStatus, databaseDetail));

  try {
    await assertDiskSpace({ targetPath: root, minimumFreeBytes: foundation.operations.minimumFreeBytes, minimumFreeRatio: foundation.operations.minimumFreeRatio });
    checks.push(check('operations:disk-space', 'PASS', 'production reserve available'));
  } catch {
    checks.push(check('operations:disk-space', 'FAIL', 'production reserve unavailable'));
  }

  try {
    const inbound = await loadCustomerInboundConfig({ root });
    checks.push(check('optional:customer-inbound', inbound.enabled ? 'CONFIGURED' : 'PREPARED', 'Phase F17B verified replies'));
  } catch {
    checks.push(check('optional:customer-inbound', 'NOT_CONFIGURED', 'Phase F17B private configuration pending'));
  }
  const alertCount = await countAlertRecords(root);
  checks.push(check('operations:failure-alerts', alertCount > 0 ? 'ATTENTION' : 'PASS', `${alertCount} redacted alert record(s)`));

  const templateCount = await countFiles(path.join(root, 'templates', 'normalized'), '.docx');
  checks.push(check('optional:document-templates', templateCount === 6 ? 'CONFIGURED' : 'NOT_CONFIGURED', 'Phase F2'));

  let driveConfigured = false;
  if (await exists(path.join(root, 'config', 'drive-folders.json'))) {
    try {
      await loadDriveConfiguration({ root });
      driveConfigured = true;
    } catch {
      driveConfigured = false;
    }
  } else {
    driveConfigured = Boolean(env.MIRA_GOOGLE_IDENTITY && env.MIRA_DRIVE_ROOT_FOLDER_ID);
  }
  checks.push(check('optional:google-drive', driveConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED', 'Phase F8'));

  let whatsAppConfigured = false;
  try {
    await loadWhatsAppRoutingConfiguration({ root, env });
    whatsAppConfigured = true;
  } catch {
    whatsAppConfigured = false;
  }
  checks.push(check('optional:whatsapp', whatsAppConfigured ? 'CONFIGURED' : 'FAIL', 'Phase F10'));

  try {
    const delivery = await loadCustomerDeliveryConfig({ root });
    checks.push(check('optional:customer-delivery', delivery.enabled ? 'CONFIGURED' : 'PREPARED', 'Phase F17A outbound only'));
  } catch {
    checks.push(check('optional:customer-delivery', 'NOT_CONFIGURED', 'Phase F17A private configuration pending'));
  }

  const healthy = !checks.some((item) => item.status === 'FAIL');
  return { healthy, phase: foundation.project.phase, checks };
}

async function main() {
  const report = await runHealthCheck();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Mira Finance health check (Phase ${report.phase})`);
    for (const item of report.checks) console.log(`${item.status.padEnd(14)} ${item.name} - ${item.detail}`);
  }
  if (!report.healthy) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL Mira Finance health check failed (${error?.code ?? 'HEALTH_ERROR'})`);
    process.exitCode = 1;
  });
}
