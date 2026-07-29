#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDatabasePath, openDatabase } from './lib/database.mjs';

export function checkDatabase(databasePath = defaultDatabasePath) {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    const integrityRows = database.prepare('PRAGMA integrity_check').all();
    const integrity = integrityRows.map((row) => Object.values(row)[0]);
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
    const version = database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
    return {
      ok: integrity.length === 1 && integrity[0] === 'ok' && foreignKeys.length === 0 && version >= 1,
      integrity,
      foreignKeyViolations: foreignKeys.length,
      schemaVersion: version
    };
  } finally {
    database.close();
  }
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const databasePath = valueAfter('--database') ? path.resolve(valueAfter('--database')) : defaultDatabasePath;
  const result = checkDatabase(databasePath);
  console.log(`${result.ok ? 'PASS' : 'FAIL'} database integrity; schema version ${result.schemaVersion}; foreign-key violations ${result.foreignKeyViolations}`);
  if (!result.ok) process.exitCode = 1;
}
