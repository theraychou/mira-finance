import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../validate-config.mjs';

const folderIdPattern = /^[A-Za-z0-9_-]{10,128}$/;
const clientPattern = /^[a-z][a-z0-9-]{1,31}$/;

export function validateCustomerSheetMirrorConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Customer Sheet mirror configuration must be an object.');
  if (value.$schema !== '../schemas/customer-sheet-mirror.schema.json') throw new Error('Customer Sheet mirror schema reference is invalid.');
  if (value.schemaVersion !== 1) throw new Error('Unsupported customer Sheet mirror schema version.');
  if (typeof value.enabled !== 'boolean') throw new Error('Customer Sheet mirror enabled must be boolean.');
  if (typeof value.spreadsheetTitle !== 'string' || !value.spreadsheetTitle.trim() || value.spreadsheetTitle.length > 120) {
    throw new Error('Customer Sheet mirror title is invalid.');
  }
  if (typeof value.sheetName !== 'string' || !/^[A-Za-z0-9 _-]{1,50}$/.test(value.sheetName)) {
    throw new Error('Customer Sheet tab name is invalid.');
  }
  if (value.enabled) {
    if (typeof value.identity !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.identity)) {
      throw new Error('Customer Sheet identity must be an email address when enabled.');
    }
    if (typeof value.client !== 'string' || !clientPattern.test(value.client)) {
      throw new Error('Customer Sheet client profile is invalid when enabled.');
    }
    if (!folderIdPattern.test(value.folderId ?? '')) throw new Error('Customer Sheet folder ID is invalid when enabled.');
  }
  return Object.freeze({
    $schema: '../schemas/customer-sheet-mirror.schema.json',
    schemaVersion: 1,
    enabled: value.enabled,
    identity: value.identity ?? null,
    client: value.client ?? null,
    folderId: value.folderId ?? null,
    spreadsheetTitle: value.spreadsheetTitle.trim(),
    sheetName: value.sheetName.trim()
  });
}

export async function loadCustomerSheetMirrorConfiguration({
  root = repositoryRoot,
  configPath = path.join(root, 'config', 'customer-sheet-mirror.json')
} = {}) {
  return validateCustomerSheetMirrorConfiguration(JSON.parse(await readFile(configPath, 'utf8')));
}
