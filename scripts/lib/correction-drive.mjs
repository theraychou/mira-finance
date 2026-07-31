import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { approvedFolderFor, loadDriveConfiguration } from './drive-configuration.mjs';
import { createGogDriveClient } from './gog-drive-client.mjs';
import { canonicalJson } from './quotation-drafts.mjs';
import { publishImmutableBuffer } from './quotation-renderer.mjs';
import { repositoryRoot } from '../validate-config.mjs';

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}
function positiveId(value, name) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer.`);
  return result;
}
function instant(value) {
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new TypeError('now must be an ISO-8601 UTC instant.');
  }
}
function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function md5(buffer) { return createHash('md5').update(buffer).digest('hex'); }
function inside(root, relative) {
  const base = path.resolve(root);
  const candidate = path.resolve(base, relative);
  if (!candidate.startsWith(`${base}${path.sep}`)) throw new Error('CORRECTION_FILE_PATH_INVALID');
  return candidate;
}

async function artifacts({ databasePath, correctionType, entityId, actor, root, testMode, now }) {
  const database = openDatabase(databasePath, { readOnly: true });
  let rows;
  let driveType;
  try {
    if (correctionType === 'credit_note') {
      const note = database.prepare(`SELECT c.*,i.docx_relative_path,i.pdf_relative_path,i.docx_sha256,i.pdf_sha256
        FROM credit_notes c JOIN credit_note_issuances i ON i.credit_note_id=c.id
        WHERE c.id=? AND c.status='ISSUED' AND i.status='ISSUED'`).get(entityId);
      if (!note) throw new Error('CREDIT_NOTE_NOT_ISSUED');
      driveType = 'invoice';
      rows = ['DOCX','PDF'].map((kind) => {
        const key = kind.toLowerCase();
        return {
          kind, relative: note[`${key}_relative_path`], expectedHash: note[`${key}_sha256`],
          filePath: inside(path.join(root, 'generated', 'credit-notes'), note[`${key}_relative_path`])
        };
      });
    } else {
      const table = correctionType === 'cancellation' ? 'document_cancellations' : 'replacement_document_links';
      const record = database.prepare(`SELECT * FROM ${table} WHERE id=?`).get(entityId);
      if (!record) throw new Error('CORRECTION_RECORD_NOT_FOUND');
      driveType = record.document_type;
      if (correctionType === 'replacement') {
        const entityTable = driveType === 'invoice' ? 'invoices' : 'quotations';
        const replacement = database.prepare(`SELECT status,${driveType === 'invoice' ? 'invoice_number' : 'quotation_number'} AS document_number
          FROM ${entityTable} WHERE id=?`).get(record.replacement_entity_id);
        if (!replacement || replacement.status !== 'ISSUED') throw new Error('REPLACEMENT_NOT_ISSUED');
        record.replacement_document_number = replacement.document_number;
      }
      const manifest = Buffer.from(`${canonicalJson({
        schemaVersion: 1, phase: 'F15', classification: testMode ? 'TEST / NOT VALID' : 'OPERATIONAL',
        correctionType, generatedAt: now, record
      })}\n`);
      const hash = sha256(manifest);
      const relative = path.join(correctionType, `${entityId}-${hash.slice(0, 12)}.json`);
      const filePath = inside(path.join(root, 'generated', 'corrections'), relative);
      await publishImmutableBuffer(filePath, manifest);
      rows = [{ kind: 'JSON', relative, expectedHash: hash, filePath }];
    }
  } finally { database.close(); }
  const ready = [];
  for (const row of rows) {
    const buffer = await readFile(row.filePath);
    const metadata = await stat(row.filePath);
    if (!metadata.isFile() || metadata.size < 1 || sha256(buffer) !== row.expectedHash) throw new Error('CORRECTION_FILE_HASH_MISMATCH');
    ready.push({ ...row, buffer, size: metadata.size, fileName: path.basename(row.filePath) });
  }
  const writable = openDatabase(databasePath);
  try {
    return {
      driveType,
      artifacts: withImmediateTransaction(writable, () => ready.map((row) => {
        writable.prepare(`INSERT INTO correction_drive_filings
          (correction_type,entity_id,artifact_kind,local_relative_path,local_sha256,local_size,status,created_by,created_at)
          VALUES (?,?,?,?,?,?,'PENDING',?,?)
          ON CONFLICT(correction_type,entity_id,artifact_kind) DO NOTHING`).run(
          correctionType, entityId, row.kind, row.relative.split(path.sep).join('/'),
          row.expectedHash, row.size, actor, now
        );
        const filing = writable.prepare(`SELECT * FROM correction_drive_filings
          WHERE correction_type=? AND entity_id=? AND artifact_kind=?`).get(correctionType, entityId, row.kind);
        if (filing.local_sha256 !== row.expectedHash || filing.local_size !== row.size) {
          throw new Error('CORRECTION_DRIVE_SNAPSHOT_MISMATCH');
        }
        return { ...filing, filePath: row.filePath, fileName: row.fileName, localMd5: md5(row.buffer) };
      }))
    };
  } finally { writable.close(); }
}

export async function fileCorrectionToDrive({
  databasePath, correctionType, entityId, actor, root = repositoryRoot,
  testMode = false, configuration, client, now = new Date().toISOString()
}) {
  instant(now); required(actor, 'actor'); positiveId(entityId, 'entity_id');
  if (!['credit_note','cancellation','replacement'].includes(correctionType)) {
    throw new TypeError('Unsupported correction type.');
  }
  const config = configuration ?? await loadDriveConfiguration({ root });
  const drive = client ?? createGogDriveClient(config);
  const prepared = await artifacts({ databasePath, correctionType, entityId, actor, root, testMode, now });
  const folderId = approvedFolderFor(config, prepared.driveType);
  const results = [];
  for (const filing of prepared.artifacts) {
    if (filing.status === 'COMPLETED') { results.push(filing); continue; }
    if (filing.status === 'FAILED') {
      const database = openDatabase(databasePath);
      try {
        database.prepare("UPDATE correction_drive_filings SET status='PENDING' WHERE id=? AND status='FAILED'")
          .run(filing.id);
      } finally { database.close(); }
    }
    try {
      const candidates = await drive.findByName({ name: filing.fileName, parentId: folderId });
      if (candidates.length > 1) throw new Error('DRIVE_DUPLICATE_AMBIGUOUS');
      let remote = candidates[0] ?? await drive.uploadFile({
        localPath: filing.filePath, name: filing.fileName, parentId: folderId
      });
      remote = await drive.getMetadata(remote.id);
      if (remote.name !== filing.fileName || remote.size !== filing.local_size || !remote.parents.includes(folderId)) {
        throw new Error('DRIVE_UPLOAD_VERIFICATION_FAILED');
      }
      if (remote.md5Checksum && remote.md5Checksum.toLowerCase() !== filing.localMd5) {
        throw new Error('DRIVE_UPLOAD_HASH_MISMATCH');
      }
      const database = openDatabase(databasePath);
      try {
        results.push(withImmediateTransaction(database, () => {
          const completed = database.prepare(`UPDATE correction_drive_filings SET status='COMPLETED',drive_file_id=?,completed_at=?
            WHERE id=? AND status='PENDING'`).run(remote.id, now, filing.id);
          if (completed.changes !== 1) throw new Error('CORRECTION_DRIVE_STATE_CONFLICT');
          if (correctionType === 'credit_note') {
            const column = filing.artifact_kind === 'DOCX' ? 'drive_docx_file_id' : 'drive_pdf_file_id';
            database.prepare(`UPDATE credit_notes SET ${column}=? WHERE id=?`).run(remote.id, entityId);
          }
          database.prepare(`INSERT INTO audit_events
            (timestamp,actor,action,entity_type,entity_id,result,details_json)
            VALUES (?,?,'correction.drive_filed',?,?, 'PASS',?)`).run(
            now, actor, correctionType, entityId, canonicalJson({ artifactKind: filing.artifact_kind, originalPreserved: true })
          );
          return database.prepare('SELECT * FROM correction_drive_filings WHERE id=?').get(filing.id);
        }));
      } finally { database.close(); }
    } catch (error) {
      const database = openDatabase(databasePath);
      try {
        database.prepare("UPDATE correction_drive_filings SET status='FAILED' WHERE id=? AND status='PENDING'").run(filing.id);
      } finally { database.close(); }
      throw error;
    }
  }
  return { correctionType, entityId, status: 'COMPLETED', filings: results };
}
