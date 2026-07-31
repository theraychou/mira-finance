import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import {
  confirmAndFileClaim, createClaimConfirmationToken, createClaimDraftFromReceipt,
  getClaimRegister, reviseClaimDraft
} from '../../scripts/lib/claim-workflow.mjs';
import { inspectReceiptAttachment } from '../../scripts/lib/receipt-attachments.mjs';

const NOW = '2026-07-31T01:00:00.000Z';
const FOLDER = 'TEST_F12_APPROVED_FOLDER';
const CONFIG = { schemaVersion: 1, identity: 'operator@example.invalid', client: 'mira-drive', rootFolderId: FOLDER, destinations: { quotation: FOLDER, invoice: FOLDER } };

class FakeDrive {
  constructor() { this.files = new Map(); }
  async findByName({ name, parentId }) { return [...this.files.values()].filter((f) => f.name === name && f.parents.includes(parentId)); }
  async uploadFile({ localPath, name, parentId }) {
    const buffer = await readFile(localPath);
    const file = { id: `TEST_CLAIM_FILE_${this.files.size + 1}`, name, size: buffer.length, parents: [parentId], md5Checksum: createHash('md5').update(buffer).digest('hex') };
    this.files.set(file.id, file); return file;
  }
  async getMetadata(id) {
    if (id === FOLDER) return { id, name: 'TEST Finance', mimeType: 'application/vnd.google-apps.folder', parents: [], size: null };
    return this.files.get(id);
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-f12-'));
  const databasePath = path.join(root, 'data', 'finance.sqlite3');
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'data', 'claims', 'inbox'), { recursive: true });
  await writeFile(path.join(root, 'config', 'claim-categories.json'), JSON.stringify({
    schemaVersion: 1,
    categories: [
      { id: 'meals', label: 'Meals', terms: ['cafe'] },
      { id: 'transport', label: 'Transport', terms: ['taxi'] },
      { id: 'other', label: 'Other', terms: [] }
    ]
  }));
  await migrateUp({ databasePath, now: () => NOW });
  return { root, databasePath, inbox: path.join(root, 'data', 'claims', 'inbox') };
}

async function receiptFile(inbox, name, type, marker = '') {
  const headers = {
    pdf: Buffer.from(`%PDF-1.4\n${marker}`),
    png: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(marker)]),
    jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(marker)])
  };
  const file = path.join(inbox, name);
  await writeFile(file, headers[type]);
  await chmod(file, 0o600);
  return file;
}

const finalFields = {
  description: 'TEST receipt claim - NOT VALID',
  category: 'meals',
  clientOrProject: 'TEST PROJECT - NOT VALID',
  businessPurpose: 'TEST business purpose - NOT VALID',
  clientInitials: 'TP'
};

test('clear PDF receipt becomes a confirmed, Drive-filed claim with immutable source and register entry', async () => {
  const f = await fixture();
  try {
    const source = await receiptFile(f.inbox, 'test-clear.pdf', 'pdf');
    const draft = await createClaimDraftFromReceipt({
      databasePath: f.databasePath, sourcePath: source, actor: 'ray-test', root: f.root, now: NOW,
      pdfRunner: async () => ({ text: 'TEST CAFE\n31/07/2026\nTOTAL MYR 12.34', rotationDegrees: 0 }),
      advisoryFields: finalFields
    });
    assert.equal(draft.snapshot.fields.currency, 'MYR');
    assert.equal(draft.snapshot.fields.totalMinor, 1234);
    assert.deepEqual(draft.snapshot.validationIssues, []);
    const token = createClaimConfirmationToken({
      databasePath: f.databasePath, claimId: draft.id, requestingUser: 'ray-test', authorisedUser: 'ray-test',
      sourceChannel: 'whatsapp', sourceChat: 'TEST_GROUP_FINGERPRINT', now: NOW, tokenFactory: () => 'CL-ABCDEFGHJK'
    });
    const filed = await confirmAndFileClaim({
      databasePath: f.databasePath, token: token.token, confirmingUser: 'ray-test', authorisedUser: 'ray-test',
      root: f.root, configuration: CONFIG, client: new FakeDrive(), now: '2026-07-31T01:01:00.000Z'
    });
    assert.equal(filed.status, 'FILED');
    assert.match(filed.claimNumber, /^2607311001-TP$/);
    const register = getClaimRegister({ databasePath: f.databasePath, includeDrafts: false });
    assert.equal(register.length, 1);
    assert.equal(register[0].receipt_filed, 1);
    const original = path.join(f.root, 'data', 'claims', 'originals', draft.snapshot.receipt.storageRelativePath);
    assert.equal(createHash('sha256').update(await readFile(original)).digest('hex'), draft.snapshot.receipt.sha256);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('image, rotated image, multiple currencies, and handwritten advisory outcomes remain deterministic', async () => {
  const f = await fixture();
  try {
    const cases = [
      ['clear.png', 'png', 'TEST CAFE\n2026-07-31\nTOTAL SGD 20.00', 0, 'SGD', 2000],
      ['rotated.jpg', 'jpg', 'TEST TAXI\n2026-07-30\nTOTAL USD 30.50', 90, 'USD', 3050],
      ['handwritten.png', 'png', '', 0, null, null]
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const [name, type, text, rotationDegrees, currency, total] = cases[index];
      const source = await receiptFile(f.inbox, name, type, String(index));
      const draft = await createClaimDraftFromReceipt({
        databasePath: f.databasePath, sourcePath: source, actor: 'ray-test', root: f.root, now: NOW,
        imageRunner: async () => ({ text, rotationDegrees, confidence: text ? 0.9 : 0.1 }),
        advisoryFields: text ? finalFields : {}
      });
      assert.equal(draft.snapshot.receipt.rotationDegrees, rotationDegrees);
      assert.equal(draft.snapshot.fields.currency, currency);
      assert.equal(draft.snapshot.fields.totalMinor, total);
      if (!text) assert.ok(draft.snapshot.validationIssues.includes('missing_date'));
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('missing date and merchant block confirmation until Ray revises final fields', async () => {
  const f = await fixture();
  try {
    const source = await receiptFile(f.inbox, 'missing.png', 'png');
    const draft = await createClaimDraftFromReceipt({
      databasePath: f.databasePath, sourcePath: source, actor: 'ray-test', root: f.root, now: NOW,
      imageRunner: async () => ({ text: 'TOTAL MYR 8.00', rotationDegrees: 0 }),
      advisoryFields: finalFields
    });
    assert.ok(draft.snapshot.validationIssues.includes('missing_date'));
    assert.ok(draft.snapshot.validationIssues.includes('missing_merchant'));
    assert.throws(() => createClaimConfirmationToken({
      databasePath: f.databasePath, claimId: draft.id, requestingUser: 'ray-test', authorisedUser: 'ray-test',
      sourceChannel: 'whatsapp', sourceChat: 'TEST_GROUP', now: NOW
    }), /INCOMPLETE/);
    const revised = await reviseClaimDraft({
      databasePath: f.databasePath, claimId: draft.id, actor: 'ray-test', root: f.root, now: '2026-07-31T01:02:00.000Z',
      fields: { transactionDate: '2026-07-31', merchant: 'TEST MERCHANT - NOT VALID' }
    });
    assert.deepEqual(revised.snapshot.validationIssues, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('exact duplicates are blocked and probable duplicates are flagged', async () => {
  const f = await fixture();
  try {
    const first = await receiptFile(f.inbox, 'first.png', 'png', 'first');
    const input = {
      databasePath: f.databasePath, actor: 'ray-test', root: f.root, now: NOW,
      advisoryText: 'TEST CAFE\n2026-07-31\nTOTAL MYR 10.00', advisoryFields: finalFields
    };
    const created = await createClaimDraftFromReceipt({ ...input, sourcePath: first });
    const exact = await createClaimDraftFromReceipt({ ...input, sourcePath: first });
    assert.equal(exact.status, 'EXACT_DUPLICATE');
    assert.equal(exact.existingClaimId, created.id);
    const second = await receiptFile(f.inbox, 'second.png', 'png', 'different bytes');
    const probable = await createClaimDraftFromReceipt({ ...input, sourcePath: second });
    assert.equal(probable.snapshot.probableDuplicate.claimId, created.id);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('unsupported and oversized attachments are refused before persistence', async () => {
  const f = await fixture();
  try {
    const unsupported = path.join(f.inbox, 'bad.txt');
    await writeFile(unsupported, 'TEST / NOT VALID');
    await assert.rejects(inspectReceiptAttachment({ sourcePath: unsupported, intakeRoot: f.inbox }), /UNSUPPORTED/);
    const image = await receiptFile(f.inbox, 'large.png', 'png', '0123456789');
    await assert.rejects(inspectReceiptAttachment({ sourcePath: image, intakeRoot: f.inbox, maxBytes: 8 }), /TOO_LARGE/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('only the authorised requester can confirm and expired tokens remain unusable', async () => {
  const f = await fixture();
  try {
    const source = await receiptFile(f.inbox, 'auth.png', 'png', 'auth');
    const draft = await createClaimDraftFromReceipt({
      databasePath: f.databasePath, sourcePath: source, actor: 'ray-test', root: f.root, now: NOW,
      advisoryText: 'TEST CAFE\n2026-07-31\nTOTAL MYR 10.00', advisoryFields: finalFields
    });
    assert.throws(() => createClaimConfirmationToken({
      databasePath: f.databasePath, claimId: draft.id, requestingUser: 'other-user', authorisedUser: 'ray-test',
      sourceChannel: 'whatsapp', sourceChat: 'TEST_GROUP', now: NOW
    }), /NOT_AUTHORISED/);
    const confirmation = createClaimConfirmationToken({
      databasePath: f.databasePath, claimId: draft.id, requestingUser: 'ray-test', authorisedUser: 'ray-test',
      sourceChannel: 'whatsapp', sourceChat: 'TEST_GROUP', ttlMinutes: 1, now: NOW, tokenFactory: () => 'CL-ABCDEFGHJK'
    });
    await assert.rejects(confirmAndFileClaim({
      databasePath: f.databasePath, token: confirmation.token, confirmingUser: 'ray-test', authorisedUser: 'ray-test',
      root: f.root, configuration: CONFIG, client: new FakeDrive(), now: '2026-07-31T01:02:00.000Z'
    }), /EXPIRED/);
    await assert.rejects(confirmAndFileClaim({
      databasePath: f.databasePath, token: confirmation.token, confirmingUser: 'ray-test', authorisedUser: 'ray-test',
      root: f.root, configuration: CONFIG, client: new FakeDrive(), now: '2026-07-31T01:03:00.000Z'
    }), /INVALID/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
