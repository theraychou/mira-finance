#!/usr/bin/env node
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDriveConfiguration } from './lib/drive-configuration.mjs';
import { runF11Pilot } from './lib/f11-pilot.mjs';
import { repositoryRoot } from './validate-config.mjs';

async function exists(candidate) {
  try { await access(candidate); return true; } catch { return false; }
}

async function main() {
  if (!process.argv.includes('--admin') || !process.argv.includes('--test-mode') || !process.argv.includes('--live-drive')) {
    throw new Error('F11 requires explicit --admin --test-mode --live-drive flags.');
  }
  const databasePath = path.join(repositoryRoot, 'data', 'pilots', 'f11-pilot.sqlite3');
  if (await exists(databasePath)) throw new Error('The F11 pilot ledger already exists; refusing to overwrite or rerun it.');
  const driveConfiguration = await loadDriveConfiguration();
  const result = await runF11Pilot({
    databasePath,
    storageRoot: repositoryRoot,
    templateRoot: repositoryRoot,
    driveConfiguration
  });
  console.log(`PASS F11 TEST pilot completed: ${result.verification.quotationCount} quotations, ${result.verification.invoiceCount} paid invoices, ${result.verification.completedDriveUploadCount} verified Drive artifacts`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL F11 pilot did not complete (${error?.code ?? error?.message ?? 'F11_PILOT_FAILED'})`);
    process.exitCode = 1;
  });
}
