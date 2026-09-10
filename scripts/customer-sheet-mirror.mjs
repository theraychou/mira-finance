#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defaultDatabasePath } from './lib/database.mjs';
import { loadCustomerSheetMirrorConfiguration } from './lib/customer-sheet-mirror-config.mjs';
import { syncCustomerSheetMirror } from './lib/customer-sheet-mirror.mjs';
import { createGogSheetsClient } from './lib/gog-sheets-client.mjs';

function value(flag) { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : undefined; }
function required(flag) { const result = value(flag); if (!result) throw new Error(`${flag} is required.`); return result; }

export async function runCustomerSheetCommand({ databasePath = defaultDatabasePath } = {}) {
  if (!process.argv.includes('--admin')) throw new Error('Customer Sheet commands require explicit --admin mode.');
  if (required('--action') !== 'sync') throw new Error('Unsupported customer Sheet action.');
  const actor = required('--actor');
  const configuration = await loadCustomerSheetMirrorConfiguration();
  if (!configuration.enabled) throw new Error('CUSTOMER_SHEET_MIRROR_DISABLED');
  const client = createGogSheetsClient({ identity: configuration.identity, client: configuration.client });
  return syncCustomerSheetMirror({ databasePath, configuration, client, actor });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCustomerSheetCommand({ databasePath: value('--database') ? path.resolve(value('--database')) : defaultDatabasePath })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(`FAIL ${/^[A-Z][A-Z0-9_]{2,63}$/.test(error?.message ?? '') ? error.message : 'CUSTOMER_SHEET_COMMAND_FAILED'}`); process.exitCode = 1; });
}
