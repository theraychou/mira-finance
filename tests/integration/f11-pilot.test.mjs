import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDriveConfiguration } from '../../scripts/lib/drive-configuration.mjs';
import { runF11Pilot, verifyF11PilotLedger } from '../../scripts/lib/f11-pilot.mjs';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { readDocumentXml } from '../../scripts/lib/template-contract.mjs';
import { repositoryRoot } from '../../scripts/validate-config.mjs';

const FOLDER = 'TEST_F11_APPROVED_FOLDER';
const CONFIGURATION = validateDriveConfiguration({
  schemaVersion: 1,
  identity: 'pilot@example.invalid',
  client: 'mira-drive',
  rootFolderId: FOLDER,
  destinations: { quotation: FOLDER, invoice: FOLDER }
});

class FakeDrive {
  constructor() { this.files = new Map(); }
  async getMetadata(id) {
    if (id === FOLDER) return { id, name: 'TEST Finance', mimeType: 'application/vnd.google-apps.folder', size: null, parents: [], md5Checksum: null };
    const file = this.files.get(id);
    if (!file) throw new Error('TEST_DRIVE_ITEM_NOT_FOUND');
    return file;
  }
  async findByName({ name, parentId }) {
    return [...this.files.values()].filter((file) => file.name === name && file.parents.includes(parentId));
  }
  async uploadFile({ localPath, name, parentId }) {
    const buffer = await readFile(localPath);
    const metadata = await stat(localPath);
    const id = `TEST_F11_FILE_${String(this.files.size + 1).padStart(2, '0')}`;
    const file = {
      id,
      name,
      mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: metadata.size,
      parents: [parentId],
      md5Checksum: createHash('md5').update(buffer).digest('hex')
    };
    this.files.set(id, file);
    return file;
  }
}

async function fakePdfConverter({ docxPath, pdfPath }) {
  const { xml } = readDocumentXml(await readFile(docxPath));
  const visible = xml.replaceAll(/<[^>]+>/g, ' ').replaceAll(/\s+/g, ' ');
  await writeFile(pdfPath, Buffer.from(`%PDF-1.4\n${visible}\n%%EOF`), { mode: 0o600 });
}

async function fakePdfInspector({ pdfPath }) {
  return { pageCount: 1, a4: true, text: await readFile(pdfPath, 'utf8') };
}

async function cleanup(directory, databasePath) {
  const database = openDatabase(databasePath);
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  database.exec('PRAGMA journal_mode = DELETE');
  database.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('F11 completes the synthetic MYR, SGD, and USD quotation-to-paid-invoice pilot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-f11-'));
  const databasePath = path.join(directory, 'data', 'f11-pilot.sqlite3');
  const drive = new FakeDrive();
  try {
    const result = await runF11Pilot({
      databasePath,
      storageRoot: directory,
      templateRoot: repositoryRoot,
      driveConfiguration: CONFIGURATION,
      driveClient: drive,
      pdfConverter: fakePdfConverter,
      pdfInspector: fakePdfInspector
    });
    assert.equal(result.phase, 'F11');
    assert.equal(result.classification, 'TEST / NOT VALID');
    assert.deepEqual(result.results.map((item) => item.currency), ['MYR', 'SGD', 'USD']);
    assert.equal(new Set(result.results.flatMap((item) => [item.quotationNumber, item.invoiceNumber])).size, 6);
    for (const item of result.results) {
      assert.match(item.quotationNumber, /^26073010\d{2}-F[MSU]$/);
      assert.match(item.invoiceNumber, /^26073010\d{2}-F[MSU]$/);
      assert.equal(item.paymentStatus, 'PAID');
    }
    assert.deepEqual(result.verification, {
      quotationCount: 3,
      invoiceCount: 3,
      paidInvoiceCount: 3,
      issuedNumberCount: 6,
      completedDriveUploadCount: 12
    });
    assert.equal(drive.files.size, 12);
    assert.deepEqual(verifyF11PilotLedger({ databasePath }), result.verification);
    const report = JSON.parse(await readFile(result.monthlyReport.filePath, 'utf8'));
    assert.equal(report.classification, 'TEST / NOT VALID');
    assert.equal(report.currencyPolicy, 'NO_CONVERSION');
    for (const currency of report.currencies) {
      assert.equal(currency.quotations.count, 1);
      assert.equal(currency.invoices.count, 1);
      assert.equal(currency.invoices.paidMinor, currency.invoices.totalMinor);
      assert.equal(currency.invoices.balanceDueMinor, 0);
    }
    const reportEvents = openDatabase(databasePath, { readOnly: true });
    assert.equal(reportEvents.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='report.monthly_test_generated'").get().count, 1);
    reportEvents.close();
  } finally {
    await cleanup(directory, databasePath);
  }
});

test('F11 CLI is fail-closed and does not expose the pilot through Mira tools', async () => {
  const [runner, policy] = await Promise.all([
    readFile(path.join(repositoryRoot, 'scripts', 'run-f11-pilot.mjs'), 'utf8'),
    readFile(path.join(repositoryRoot, 'config', 'openclaw-agent-policy.json'), 'utf8')
  ]);
  assert.match(runner, /--admin/);
  assert.match(runner, /--test-mode/);
  assert.match(runner, /--live-drive/);
  assert.doesNotMatch(policy, /run_f11|pilot:f11|monthly_report/);
});

test('F11 pilot numbering, totals, and monthly report are deterministic across fresh ledgers', async () => {
  const runs = [];
  for (let index = 0; index < 2; index += 1) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `mira-f11-repeat-${index}-`));
    const databasePath = path.join(directory, 'data', 'f11-pilot.sqlite3');
    try {
      const result = await runF11Pilot({
        databasePath,
        storageRoot: directory,
        templateRoot: repositoryRoot,
        driveConfiguration: CONFIGURATION,
        driveClient: new FakeDrive(),
        pdfConverter: fakePdfConverter,
        pdfInspector: fakePdfInspector
      });
      runs.push({
        documents: result.results,
        verification: result.verification,
        report: result.monthlyReport.report,
        reportHash: result.monthlyReport.reportHash
      });
    } finally {
      await cleanup(directory, databasePath);
    }
  }
  assert.deepEqual(runs[0], runs[1]);
});
