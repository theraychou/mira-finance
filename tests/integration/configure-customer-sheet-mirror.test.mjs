import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureCustomerSheetMirror } from '../../scripts/configure-customer-sheet-mirror.mjs';

test('customer Sheet configurator reuses the approved Google identity and writes an owner-only private config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-f19-config-'));
  try {
    await mkdir(path.join(root, 'config'), { recursive: true });
    await writeFile(path.join(root, 'config', 'drive-folders.json'), JSON.stringify({
      schemaVersion: 1,
      identity: 'test@example.invalid',
      client: 'test-client',
      rootFolderId: 'TEST_ROOT_FOLDER_123',
      destinations: { quotation: 'TEST_ROOT_FOLDER_123', invoice: 'TEST_ROOT_FOLDER_123' }
    }));
    const result = await configureCustomerSheetMirror({ root, folderId: 'TEST_SHEET_FOLDER_123', now: '2026-09-10T06:00:00.000Z' });
    const configuration = JSON.parse(await readFile(result.configPath, 'utf8'));
    assert.equal(configuration.identity, 'test@example.invalid');
    assert.equal(configuration.client, 'test-client');
    assert.equal(configuration.folderId, 'TEST_SHEET_FOLDER_123');
    if (process.platform !== 'win32') assert.equal((await stat(result.configPath)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});
