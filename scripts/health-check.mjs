#!/usr/bin/env node
import { access, lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  checks.push(check('optional:database', databasePresent ? 'CONFIGURED' : 'NOT_CONFIGURED', 'Phase F3'));

  const templateCount = await countFiles(path.join(root, 'templates', 'normalized'), '.docx');
  checks.push(check('optional:document-templates', templateCount === 6 ? 'CONFIGURED' : 'NOT_CONFIGURED', 'Phase F2'));

  const driveConfigured = Boolean(env.MIRA_GOOGLE_IDENTITY && env.MIRA_DRIVE_ROOT_FOLDER_ID);
  checks.push(check('optional:google-drive', driveConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED', 'Phase F8'));

  const groupConfigured = /^\d+@g\.us$/.test(env.MIRA_WHATSAPP_GROUP_ID ?? '');
  checks.push(check('optional:whatsapp', groupConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED', 'Phase F10'));

  const healthy = !checks.some((item) => item.status === 'FAIL');
  return { healthy, phase: foundation.project.phase, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runHealthCheck();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Mira Finance health check (Phase ${report.phase})`);
    for (const item of report.checks) console.log(`${item.status.padEnd(14)} ${item.name} - ${item.detail}`);
  }
  if (!report.healthy) process.exitCode = 1;
}
