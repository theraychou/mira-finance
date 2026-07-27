#!/usr/bin/env node
import { access, readdir, stat } from 'node:fs/promises';
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

export async function runHealthCheck({ root = repositoryRoot, env = process.env } = {}) {
  const checks = [];
  const requiredFiles = ['README.md', 'AGENTS.md', 'SOUL.md', 'config/foundation.json'];
  const requiredDirectories = ['logs', 'tests/unit', 'tests/integration', 'tests/regression'];

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
    checks.push(check('workspace-permissions', mode === 0o700 ? 'PASS' : 'FAIL', `expected 0700, found 0${mode.toString(8)}`));
  } else {
    checks.push(check('workspace-permissions', 'SKIP', 'checked on the Linux deployment host'));
  }

  const databasePresent = await exists(path.join(root, 'data', 'finance.sqlite3'));
  checks.push(check('optional:database', databasePresent ? 'CONFIGURED' : 'NOT_CONFIGURED', 'Phase F2'));

  const templateCount = await countFiles(path.join(root, 'templates'), '.docx');
  checks.push(check('optional:document-templates', templateCount > 0 ? 'CONFIGURED' : 'NOT_CONFIGURED', 'later approved template phase'));

  const driveConfigured = Boolean(env.MIRA_GOOGLE_IDENTITY && env.MIRA_DRIVE_ROOT_FOLDER_ID);
  checks.push(check('optional:google-drive', driveConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED', 'Phase F8'));

  const groupConfigured = /^\d+@g\.us$/.test(env.MIRA_WHATSAPP_GROUP_ID ?? '');
  checks.push(check('optional:whatsapp', groupConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED', 'Phase F10'));

  const healthy = !checks.some((item) => item.status === 'FAIL');
  return { healthy, phase: 'F1', checks };
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

