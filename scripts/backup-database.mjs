#!/usr/bin/env node
import { access, chmod, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { checkDatabase } from './check-database.mjs';
import { defaultDatabasePath, openDatabase } from './lib/database.mjs';
import { repositoryRoot } from './validate-config.mjs';

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function backupDatabase({ sourcePath = defaultDatabasePath, destinationPath } = {}) {
  if (!destinationPath) throw new TypeError('destinationPath is required.');
  const resolvedDestination = path.resolve(destinationPath);
  if (await exists(resolvedDestination)) throw new Error('Backup destination already exists.');
  await mkdir(path.dirname(resolvedDestination), { recursive: true, mode: 0o700 });
  const temporary = `${resolvedDestination}.tmp-${process.pid}`;
  const database = openDatabase(sourcePath);
  try {
    await backup(database, temporary);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    database.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, resolvedDestination);
  const result = checkDatabase(resolvedDestination);
  if (!result.ok) throw new Error('Created backup did not pass the integrity check.');
  return { path: resolvedDestination, ...result };
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function defaultBackupPath() {
  const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return path.join(repositoryRoot, 'data', 'backups', `finance-${stamp}.sqlite3`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourcePath = valueAfter('--database') ? path.resolve(valueAfter('--database')) : defaultDatabasePath;
  const destinationPath = valueAfter('--output') ? path.resolve(valueAfter('--output')) : defaultBackupPath();
  const result = await backupDatabase({ sourcePath, destinationPath });
  console.log(`PASS SQLite-safe backup created; schema version ${result.schemaVersion}`);
}
