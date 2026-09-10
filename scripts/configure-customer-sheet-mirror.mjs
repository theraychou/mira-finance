#!/usr/bin/env node
import { access, chmod, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadDriveConfiguration } from './lib/drive-configuration.mjs';
import { validateCustomerSheetMirrorConfiguration } from './lib/customer-sheet-mirror-config.mjs';
import { repositoryRoot } from './validate-config.mjs';

async function exists(candidate) {
  try { await access(candidate); return true; } catch { return false; }
}

export async function configureCustomerSheetMirror({
  root = repositoryRoot,
  folderId,
  enabled = true,
  spreadsheetTitle = 'Mira Customer Register',
  sheetName = 'Customers',
  now = new Date().toISOString()
} = {}) {
  const drive = await loadDriveConfiguration({ root });
  const configuration = validateCustomerSheetMirrorConfiguration({
    $schema: '../schemas/customer-sheet-mirror.schema.json',
    schemaVersion: 1,
    enabled,
    identity: drive.identity,
    client: drive.client,
    folderId,
    spreadsheetTitle,
    sheetName
  });
  const configDirectory = path.join(root, 'config');
  const configPath = path.join(configDirectory, 'customer-sheet-mirror.json');
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  let backupPath = null;
  if (await exists(configPath)) {
    const stamp = now.replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const backupDirectory = path.join(root, 'data', 'backups');
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    backupPath = path.join(backupDirectory, `customer-sheet-mirror-pre-${stamp}.json`);
    await copyFile(configPath, backupPath, 0);
    await chmod(backupPath, 0o600);
  }
  const temporary = `${configPath}.f19-${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, configPath);
    await chmod(configPath, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { configPath, backupPath, enabled: configuration.enabled };
}

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folderId = value('--folder-id');
  if (!folderId) throw new Error('--folder-id is required.');
  const result = await configureCustomerSheetMirror({ folderId });
  console.log(`PASS customer Sheet mirror configuration ${result.enabled ? 'enabled' : 'disabled'} with owner-only permissions`);
}
