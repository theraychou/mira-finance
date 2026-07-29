import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../../scripts/validate-config.mjs';

async function exists(relative) {
  try {
    await access(path.join(repositoryRoot, relative));
    return true;
  } catch {
    return false;
  }
}

test('only the Phase F4 database feature is enabled', async () => {
  const foundation = JSON.parse(await readFile(path.join(repositoryRoot, 'config/foundation.json'), 'utf8'));
  assert.deepEqual(foundation.features, {
    database: true,
    documentGeneration: false,
    googleDrive: false,
    whatsApp: false
  });
});

test('F4 retains all six templates and both database migrations', async () => {
  assert.equal(await exists('data/migrations/001_initial.up.sql'), true);
  assert.equal(await exists('data/migrations/001_initial.down.sql'), true);
  assert.equal(await exists('data/migrations/002_registries.up.sql'), true);
  assert.equal(await exists('data/migrations/002_registries.down.sql'), true);
  const currencies = ['myr', 'sgd', 'usd'];
  for (const currency of currencies) {
    const sourceFiles = await readdir(path.join(repositoryRoot, 'templates', 'source', currency));
    const normalizedFiles = await readdir(path.join(repositoryRoot, 'templates', 'normalized', currency));
    assert.equal(sourceFiles.filter((name) => /\.original\.docx$/i.test(name)).length, 2);
    assert.equal(normalizedFiles.filter((name) => /\.docx$/i.test(name)).length, 2);
  }
});

test('source specification and sensitive runtime files are ignored', async () => {
  const ignore = await readFile(path.join(repositoryRoot, '.gitignore'), 'utf8');
  for (const required of [
    'OpenClaw_Finance_Agent.docx',
    'config/bank-profiles.json',
    'config/drive-folders.json',
    'data/*.sqlite3',
    'data/*.sqlite3-*',
    'templates/**/*.docx',
    '.env'
  ]) {
    assert.ok(ignore.includes(required), `missing ignore rule: ${required}`);
  }
});
