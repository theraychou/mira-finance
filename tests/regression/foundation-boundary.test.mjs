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

test('Phase F15 preserves approved integrations and enables controlled corrections', async () => {
  const foundation = JSON.parse(await readFile(path.join(repositoryRoot, 'config/foundation.json'), 'utf8'));
  assert.deepEqual(foundation.features, {
    database: true,
    documentGeneration: true,
    googleDrive: true,
    whatsApp: true,
    claims: true,
    supplierInvoices: true,
    reports: true,
    corrections: true
  });
});

test('F15 retains all six templates and all ten reversible database migrations', async () => {
  assert.equal(await exists('data/migrations/001_initial.up.sql'), true);
  assert.equal(await exists('data/migrations/001_initial.down.sql'), true);
  assert.equal(await exists('data/migrations/002_registries.up.sql'), true);
  assert.equal(await exists('data/migrations/002_registries.down.sql'), true);
  assert.equal(await exists('data/migrations/003_quotation_drafts.up.sql'), true);
  assert.equal(await exists('data/migrations/003_quotation_drafts.down.sql'), true);
  assert.equal(await exists('data/migrations/004_quotation_issuance.up.sql'), true);
  assert.equal(await exists('data/migrations/004_quotation_issuance.down.sql'), true);
  assert.equal(await exists('data/migrations/005_invoice_workflow.up.sql'), true);
  assert.equal(await exists('data/migrations/005_invoice_workflow.down.sql'), true);
  assert.equal(await exists('data/migrations/006_drive_uploads.up.sql'), true);
  assert.equal(await exists('data/migrations/006_drive_uploads.down.sql'), true);
  assert.equal(await exists('data/migrations/007_claim_receipts.up.sql'), true);
  assert.equal(await exists('data/migrations/007_claim_receipts.down.sql'), true);
  assert.equal(await exists('data/migrations/008_supplier_invoices.up.sql'), true);
  assert.equal(await exists('data/migrations/008_supplier_invoices.down.sql'), true);
  assert.equal(await exists('data/migrations/009_reports_exports.up.sql'), true);
  assert.equal(await exists('data/migrations/009_reports_exports.down.sql'), true);
  assert.equal(await exists('data/migrations/010_corrections.up.sql'), true);
  assert.equal(await exists('data/migrations/010_corrections.down.sql'), true);
  assert.equal(await exists('schemas/quotation-draft.schema.json'), true);
  assert.equal(await exists('schemas/invoice-draft.schema.json'), true);
  assert.equal(await exists('schemas/drive-folders.schema.json'), true);
  assert.equal(await exists('schemas/claim-draft.schema.json'), true);
  assert.equal(await exists('schemas/supplier-invoice-draft.schema.json'), true);
  assert.equal(await exists('docs/phase-f14-boundary.md'), true);
  assert.equal(await exists('docs/phase-f15-boundary.md'), true);
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
    'config/whatsapp-routing.json',
    'data/pilots/*',
    'data/claims/inbox/*',
    'data/claims/originals/*',
    'data/supplier-invoices/inbox/*',
    'data/supplier-invoices/originals/*',
    'client_secret_*.json',
    'downloads/',
    'data/*.sqlite3',
    'data/*.sqlite3-*',
    'templates/**/*.docx',
    '.env'
  ]) {
    assert.ok(ignore.includes(required), `missing ignore rule: ${required}`);
  }
});
