#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDatabasePath } from './lib/database.mjs';
import { migrateDown, migrateUp } from './lib/migrations.mjs';

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const databasePath = valueAfter('--database') ? path.resolve(valueAfter('--database')) : defaultDatabasePath;
const direction = process.argv.includes('--down') ? 'down' : 'up';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = direction === 'down'
    ? await migrateDown({ databasePath })
    : await migrateUp({ databasePath });
  console.log(`PASS database migration ${direction}; schema version ${result.version}`);
}
