import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repositoryRoot } from '../validate-config.mjs';

export const defaultDatabasePath = path.join(repositoryRoot, 'data', 'finance.sqlite3');

export function openDatabase(databasePath = defaultDatabasePath, { readOnly = false } = {}) {
  const resolved = path.resolve(databasePath);
  if (!readOnly) mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(resolved, { readOnly });
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 10000');
  if (!readOnly) {
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = FULL');
    chmodSync(resolved, 0o600);
  }
  return database;
}

export function withImmediateTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  }
}
