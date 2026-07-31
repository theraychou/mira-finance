import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { canonicalJson } from './quotation-drafts.mjs';
import { allocateDocumentNumberInTransaction, updateDocumentNumberStatusInTransaction } from './numbering.mjs';
import { inspectReceiptAttachment, preserveReceiptAttachment } from './receipt-attachments.mjs';
import { extractReceiptFields, extractReceiptText, probableReceiptFingerprint } from './receipt-extraction.mjs';
import { createGogDriveClient, DriveClientError } from './gog-drive-client.mjs';
import { loadDriveConfiguration } from './drive-configuration.mjs';
import { repositoryRoot } from '../validate-config.mjs';

const tokenAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const supportedCurrencies = new Set(['MYR', 'SGD', 'USD']);

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}
function optional(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function instant(value, name = 'now') {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new TypeError(`${name} must be an ISO-8601 UTC instant.`);
  return parsed;
}
function date(value) {
  if (value == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('transaction_date must use YYYY-MM-DD.');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new TypeError('transaction_date must be a real calendar date.');
  return value;
}
function hash(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function requireMinor(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer in minor units.`);
  return value;
}
function audit(database, { now, actor, action, claimId, beforeHash = null, afterHash = null, result = 'PASS', details = {} }) {
  database.prepare(`INSERT INTO audit_events
    (timestamp,actor,action,entity_type,entity_id,before_hash,after_hash,result,details_json)
    VALUES (?,?,?,'claim',?,?,?,?,?)`).run(now, actor, action, claimId, beforeHash, afterHash, result, canonicalJson(details));
}
async function loadCategories(root) {
  const value = JSON.parse(await readFile(path.join(root, 'config', 'claim-categories.json'), 'utf8'));
  if (value.schemaVersion !== 1 || !Array.isArray(value.categories)) throw new Error('CLAIM_CATEGORY_CONFIGURATION_INVALID');
  const ids = new Set();
  for (const item of value.categories) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(item.id) || ids.has(item.id) || !Array.isArray(item.terms)) throw new Error('CLAIM_CATEGORY_CONFIGURATION_INVALID');
    ids.add(item.id);
  }
  return value.categories;
}
function normalizeFields(fields, categoryIds) {
  const currency = fields.currency ? String(fields.currency).toUpperCase() : null;
  if (currency && !supportedCurrencies.has(currency)) throw new TypeError('Unsupported claim currency.');
  const totalMinor = requireMinor(fields.totalMinor, 'total_minor', { nullable: true });
  const taxMinor = requireMinor(fields.taxMinor ?? 0, 'tax_minor');
  if (totalMinor != null && taxMinor > totalMinor) throw new RangeError('tax_minor cannot exceed total_minor.');
  const category = optional(fields.category);
  if (category && !categoryIds.has(category)) throw new TypeError('Unknown claim category.');
  const clientInitials = optional(fields.clientInitials)?.toUpperCase() ?? null;
  if (clientInitials && !/^[A-Z0-9]{1,8}$/.test(clientInitials)) throw new TypeError('client_initials must be 1-8 uppercase letters or digits.');
  return {
    transactionDate: date(fields.transactionDate),
    merchant: optional(fields.merchant),
    description: optional(fields.description),
    category,
    clientOrProject: optional(fields.clientOrProject),
    currency,
    subtotalMinor: totalMinor == null ? null : totalMinor - taxMinor,
    taxMinor,
    totalMinor,
    paymentMethod: optional(fields.paymentMethod),
    businessPurpose: optional(fields.businessPurpose),
    clientInitials
  };
}
function validationIssues(fields) {
  const issues = [];
  for (const [key, value] of [
    ['missing_date', fields.transactionDate], ['missing_merchant', fields.merchant],
    ['missing_category', fields.category], ['missing_currency', fields.currency],
    ['missing_total', fields.totalMinor], ['missing_business_purpose', fields.businessPurpose],
    ['missing_client_initials', fields.clientInitials]
  ]) if (value == null || value === '') issues.push(key);
  return issues.sort();
}
function snapshotFor({ fields, receipt, extraction, probableDuplicateClaimId = null }) {
  return {
    kind: 'claim-draft',
    fields,
    receipt: {
      filename: receipt.sourceFilename,
      mimeType: receipt.mimeType,
      size: receipt.size,
      sha256: receipt.sha256,
      storageRelativePath: receipt.storageRelativePath,
      extractionMethod: extraction.method,
      extractionStatus: extraction.status,
      rotationDegrees: extraction.rotationDegrees,
      extractedTextSha256: extraction.textSha256
    },
    probableDuplicate: probableDuplicateClaimId ? { claimId: probableDuplicateClaimId } : null,
    validationIssues: validationIssues(fields)
  };
}
function persistVersion(database, { claimId, version, snapshot, actor, now }) {
  const versioned = { ...snapshot, version };
  const draftHash = hash(versioned);
  database.prepare(`INSERT INTO claim_draft_state
    (claim_id,current_version,draft_hash,snapshot_json,validation_issues_json,updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(claim_id) DO UPDATE SET current_version=excluded.current_version,draft_hash=excluded.draft_hash,
    snapshot_json=excluded.snapshot_json,validation_issues_json=excluded.validation_issues_json,updated_at=excluded.updated_at`)
    .run(claimId, version, draftHash, canonicalJson(versioned), canonicalJson(versioned.validationIssues), now);
  database.prepare(`INSERT INTO claim_draft_versions
    (claim_id,version,draft_hash,snapshot_json,created_by,created_at) VALUES (?,?,?,?,?,?)`)
    .run(claimId, version, draftHash, canonicalJson(versioned), actor, now);
  return { versioned, draftHash };
}
function getDraftIn(database, claimId) {
  const row = database.prepare(`SELECT c.id,c.status,c.claim_number,s.current_version,s.draft_hash,s.snapshot_json
    FROM claims c JOIN claim_draft_state s ON s.claim_id=c.id WHERE c.id=?`).get(claimId);
  if (!row) throw new Error('CLAIM_DRAFT_NOT_FOUND');
  return { id: row.id, status: row.status, claimNumber: row.claim_number, version: row.current_version, draftHash: row.draft_hash, snapshot: JSON.parse(row.snapshot_json) };
}
function updateClaimRow(database, claimId, fields) {
  database.prepare(`UPDATE claims SET transaction_date=?,merchant=?,description=?,category=?,client_or_project=?,currency=?,
    subtotal_minor=?,tax_minor=?,total_minor=?,payment_method=?,business_purpose=? WHERE id=?`)
    .run(fields.transactionDate, fields.merchant, fields.description, fields.category, fields.clientOrProject, fields.currency,
      fields.subtotalMinor ?? 0, fields.taxMinor, fields.totalMinor ?? 0, fields.paymentMethod, fields.businessPurpose, claimId);
}

export async function createClaimDraftFromReceipt({
  databasePath, sourcePath, declaredMimeType = null, actor, sourceChannel = null,
  sourceMessageReference = null, advisoryText = null, advisoryFields = {}, root = repositoryRoot,
  intakeRoot = path.join(root, 'data', 'claims', 'inbox'),
  storageRoot = path.join(root, 'data', 'claims', 'originals'),
  now = new Date().toISOString(), pdfRunner, imageRunner
}) {
  text(actor, 'actor'); instant(now);
  const inspected = await inspectReceiptAttachment({ sourcePath, intakeRoot, declaredMimeType });
  const duplicateDb = openDatabase(databasePath, { readOnly: true });
  try {
    const duplicate = duplicateDb.prepare('SELECT claim_id FROM claim_receipts WHERE source_sha256=?').get(inspected.sha256);
    if (duplicate) return { status: 'EXACT_DUPLICATE', existingClaimId: duplicate.claim_id };
  } finally { duplicateDb.close(); }
  const preserved = await preserveReceiptAttachment({ inspected, storageRoot, receivedDate: now.slice(0, 10) });
  const extraction = await extractReceiptText({ filePath: preserved.destination, mimeType: inspected.mimeType, advisoryText, pdfRunner, imageRunner });
  const categories = await loadCategories(root);
  const extracted = extractReceiptFields({ text: extraction.text, categories, advisoryFields });
  const fields = normalizeFields({
    ...extracted,
    description: advisoryFields.description ?? null,
    clientOrProject: advisoryFields.clientOrProject ?? null,
    paymentMethod: advisoryFields.paymentMethod ?? null,
    businessPurpose: advisoryFields.businessPurpose ?? null,
    clientInitials: advisoryFields.clientInitials ?? null
  }, new Set(categories.map((item) => item.id)));
  const fingerprint = probableReceiptFingerprint(fields);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const probable = fingerprint ? database.prepare(`SELECT claim_id FROM claim_receipts
        WHERE probable_duplicate_fingerprint=? ORDER BY id LIMIT 1`).get(fingerprint) : null;
      const result = database.prepare(`INSERT INTO claims
        (status,transaction_date,merchant,description,category,client_or_project,currency,subtotal_minor,tax_minor,total_minor,
         payment_method,business_purpose,source_filename,source_mime_type,source_hash,created_by,created_at)
        VALUES ('DRAFT',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(fields.transactionDate, fields.merchant, fields.description, fields.category, fields.clientOrProject, fields.currency,
          fields.subtotalMinor ?? 0, fields.taxMinor, fields.totalMinor ?? 0, fields.paymentMethod, fields.businessPurpose,
          inspected.sourceFilename, inspected.mimeType, inspected.sha256, actor, now);
      const claimId = Number(result.lastInsertRowid);
      database.prepare(`INSERT INTO claim_receipts
        (claim_id,source_filename,source_mime_type,source_size,source_sha256,storage_relative_path,extraction_method,
         extraction_status,extracted_text_sha256,rotation_degrees,probable_duplicate_fingerprint,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(claimId, inspected.sourceFilename, inspected.mimeType, inspected.size, inspected.sha256, preserved.relativePath,
          extraction.method, extraction.status, extracted.textSha256, extraction.rotationDegrees, fingerprint, now);
      const snapshot = snapshotFor({ fields, receipt: { ...inspected, storageRelativePath: preserved.relativePath }, extraction: { ...extraction, textSha256: extracted.textSha256 }, probableDuplicateClaimId: probable?.claim_id ?? null });
      const state = persistVersion(database, { claimId, version: 1, snapshot, actor, now });
      audit(database, { now, actor, action: 'claim.draft_created', claimId, afterHash: state.draftHash, details: { extractionStatus: extraction.status, probableDuplicate: Boolean(probable) } });
      return { id: claimId, status: 'DRAFT', version: 1, draftHash: state.draftHash, snapshot: state.versioned };
    });
  } finally { database.close(); }
}

export async function reviseClaimDraft({ databasePath, claimId, fields, actor, root = repositoryRoot, now = new Date().toISOString() }) {
  text(actor, 'actor'); instant(now);
  const categories = await loadCategories(root);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const current = getDraftIn(database, claimId);
      if (!['DRAFT', 'PENDING_CONFIRMATION'].includes(current.status)) throw new Error('CLAIM_NOT_REVISABLE');
      const merged = normalizeFields({ ...current.snapshot.fields, ...fields }, new Set(categories.map((item) => item.id)));
      const fingerprint = probableReceiptFingerprint(merged);
      const receipt = database.prepare('SELECT * FROM claim_receipts WHERE claim_id=?').get(claimId);
      const probable = fingerprint ? database.prepare(`SELECT claim_id FROM claim_receipts
        WHERE probable_duplicate_fingerprint=? AND claim_id<>? ORDER BY id LIMIT 1`).get(fingerprint, claimId) : null;
      updateClaimRow(database, claimId, merged);
      database.prepare('UPDATE claim_receipts SET probable_duplicate_fingerprint=? WHERE claim_id=?').run(fingerprint, claimId);
      database.prepare("UPDATE pending_confirmations SET status='INVALIDATED' WHERE draft_type='claim' AND draft_id=? AND status='PENDING'").run(claimId);
      const snapshot = snapshotFor({
        fields: merged,
        receipt: { sourceFilename: receipt.source_filename, mimeType: receipt.source_mime_type, size: receipt.source_size, sha256: receipt.source_sha256, storageRelativePath: receipt.storage_relative_path },
        extraction: { method: receipt.extraction_method, status: receipt.extraction_status, rotationDegrees: receipt.rotation_degrees, textSha256: receipt.extracted_text_sha256 },
        probableDuplicateClaimId: probable?.claim_id ?? null
      });
      const state = persistVersion(database, { claimId, version: current.version + 1, snapshot, actor, now });
      audit(database, { now, actor, action: 'claim.draft_revised', claimId, beforeHash: current.draftHash, afterHash: state.draftHash, details: { probableDuplicate: Boolean(probable) } });
      return { id: claimId, status: 'DRAFT', version: current.version + 1, draftHash: state.draftHash, snapshot: state.versioned };
    });
  } finally { database.close(); }
}

export function getClaimDraft({ databasePath, claimId }) {
  const database = openDatabase(databasePath, { readOnly: true });
  try { return getDraftIn(database, claimId); } finally { database.close(); }
}

export function generateClaimToken(randomSource = randomBytes) {
  const bytes = randomSource(10);
  if (!(bytes instanceof Uint8Array) || bytes.length < 10) throw new TypeError('randomSource must return at least 10 bytes.');
  let body = ''; for (let index = 0; index < 10; index += 1) body += tokenAlphabet[bytes[index] % tokenAlphabet.length];
  return `CL-${body}`;
}

export function createClaimConfirmationToken({
  databasePath, claimId, requestingUser, authorisedUser, sourceChannel, sourceChat,
  sourceMessageReference = null, ttlMinutes = 15, now = new Date().toISOString(), tokenFactory = generateClaimToken
}) {
  const created = instant(now);
  if (requestingUser !== authorisedUser) throw new Error('CLAIM_CONFIRMATION_USER_NOT_AUTHORISED');
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) throw new RangeError('ttlMinutes must be from 1 to 1440.');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const draft = getDraftIn(database, claimId);
      if (draft.snapshot.validationIssues.length) throw new Error('INCOMPLETE_CLAIM_DRAFT');
      if (!['DRAFT', 'PENDING_CONFIRMATION'].includes(draft.status)) throw new Error('CLAIM_NOT_CONFIRMABLE');
      database.prepare("UPDATE pending_confirmations SET status='INVALIDATED' WHERE draft_type='claim' AND draft_id=? AND status='PENDING'").run(claimId);
      const token = tokenFactory();
      if (!/^CL-[A-Z2-9]{10}$/.test(token)) throw new TypeError('tokenFactory returned an invalid claim token.');
      const expiresAt = new Date(created.valueOf() + ttlMinutes * 60_000).toISOString();
      const result = database.prepare(`INSERT INTO pending_confirmations
        (token,draft_type,draft_id,draft_hash,requesting_user,source_channel,source_chat,source_message_reference,status,expires_at,created_at)
        VALUES (?,'claim',?,?,?,?,?,?, 'PENDING',?,?)`)
        .run(token, claimId, draft.draftHash, requestingUser, text(sourceChannel, 'sourceChannel'), text(sourceChat, 'sourceChat'), optional(sourceMessageReference), expiresAt, now);
      database.prepare("UPDATE claims SET status='PENDING_CONFIRMATION' WHERE id=?").run(claimId);
      audit(database, { now, actor: requestingUser, action: 'claim.confirmation_requested', claimId, afterHash: draft.draftHash, details: { confirmationId: Number(result.lastInsertRowid) } });
      return { token, claimId, draftHash: draft.draftHash, expiresAt };
    });
  } finally { database.close(); }
}

function classifyDriveError(error) {
  if (error instanceof DriveClientError) return error.code;
  return 'CLAIM_DRIVE_FILING_FAILED';
}

export async function confirmAndFileClaim({
  databasePath, token, confirmingUser, authorisedUser, root = repositoryRoot,
  configuration, client, now = new Date().toISOString()
}) {
  const current = instant(now);
  if (confirmingUser !== authorisedUser) throw new Error('CLAIM_CONFIRMATION_USER_NOT_AUTHORISED');
  const config = configuration ?? await loadDriveConfiguration({ root });
  const drive = client ?? createGogDriveClient(config);
  const approvedFolder = await drive.getMetadata(config.rootFolderId);
  if (approvedFolder?.id !== config.rootFolderId || approvedFolder?.mimeType !== 'application/vnd.google-apps.folder') {
    throw new DriveClientError('DRIVE_APPROVED_FOLDER_INVALID');
  }
  let reservation;
  const database = openDatabase(databasePath);
  try {
    reservation = withImmediateTransaction(database, () => {
      const confirmation = database.prepare("SELECT * FROM pending_confirmations WHERE token=? AND draft_type='claim'").get(text(token, 'token'));
      if (!confirmation || confirmation.status !== 'PENDING') throw new Error('CLAIM_CONFIRMATION_INVALID');
      if (confirmation.requesting_user !== confirmingUser) throw new Error('CLAIM_CONFIRMATION_WRONG_USER');
      if (current.valueOf() >= new Date(confirmation.expires_at).valueOf()) {
        database.prepare("UPDATE pending_confirmations SET status='EXPIRED' WHERE id=?").run(confirmation.id);
        return { errorCode: 'CLAIM_CONFIRMATION_EXPIRED' };
      }
      const draft = getDraftIn(database, confirmation.draft_id);
      if (draft.draftHash !== confirmation.draft_hash || draft.snapshot.validationIssues.length) throw new Error('CLAIM_DRAFT_CHANGED');
      let filing = database.prepare('SELECT * FROM claim_filings WHERE claim_id=?').get(draft.id);
      let allocation;
      if (!filing) {
        allocation = allocateDocumentNumberInTransaction(database, {
          documentType: 'claim', sequenceDate: draft.snapshot.fields.transactionDate,
          clientInitials: draft.snapshot.fields.clientInitials, now
        });
        updateDocumentNumberStatusInTransaction(database, { allocationId: allocation.id, status: 'GENERATING', entityId: draft.id, now });
        database.prepare("UPDATE claims SET claim_number=?,status='FILING_FAILED' WHERE id=?").run(allocation.documentNumber, draft.id);
        database.prepare(`INSERT INTO claim_filings
          (claim_id,document_number_id,confirmation_id,draft_version,draft_hash,status,attempt_count,created_at,updated_at)
          VALUES (?,?,?,?,?,'FILING',1,?,?)`).run(draft.id, allocation.id, confirmation.id, draft.version, draft.draftHash, now, now);
        filing = database.prepare('SELECT * FROM claim_filings WHERE claim_id=?').get(draft.id);
      } else {
        if (filing.confirmation_id !== confirmation.id || !['FILING', 'FILING_FAILED'].includes(filing.status)) throw new Error('CLAIM_FILING_STATE_INVALID');
        const number = database.prepare('SELECT * FROM document_numbers WHERE id=?').get(filing.document_number_id);
        if (number.status === 'ISSUE_FAILED') updateDocumentNumberStatusInTransaction(database, { allocationId: number.id, status: 'GENERATING', entityId: draft.id, now });
        database.prepare("UPDATE claim_filings SET status='FILING',attempt_count=attempt_count+1,last_error_code=NULL,updated_at=? WHERE claim_id=?").run(now, draft.id);
        filing = database.prepare('SELECT * FROM claim_filings WHERE claim_id=?').get(draft.id);
      }
      const receipt = database.prepare('SELECT * FROM claim_receipts WHERE claim_id=?').get(draft.id);
      const claim = database.prepare('SELECT claim_number FROM claims WHERE id=?').get(draft.id);
      return { confirmation, draft, filing, receipt, claim };
    });
  } finally { database.close(); }
  if (reservation.errorCode) throw new Error(reservation.errorCode);

  const filePath = path.resolve(root, 'data', 'claims', 'originals', reservation.receipt.storage_relative_path);
  const metadata = await stat(filePath);
  const extension = path.extname(reservation.receipt.storage_relative_path);
  const fileName = `${reservation.claim.claim_number}-receipt${extension}`;
  try {
    const candidates = await drive.findByName({ name: fileName, parentId: config.rootFolderId });
    if (candidates.length > 1) throw new DriveClientError('DRIVE_DUPLICATE_AMBIGUOUS');
    let remote = candidates[0] ?? await drive.uploadFile({ localPath: filePath, name: fileName, parentId: config.rootFolderId });
    remote = await drive.getMetadata(remote.id);
    if (remote.name !== fileName || remote.size !== metadata.size || !remote.parents.includes(config.rootFolderId)) throw new DriveClientError('DRIVE_UPLOAD_VERIFICATION_FAILED');
    const local = await readFile(filePath);
    const localMd5 = createHash('md5').update(local).digest('hex');
    if (remote.md5Checksum && remote.md5Checksum.toLowerCase() !== localMd5) throw new DriveClientError('DRIVE_UPLOAD_HASH_MISMATCH');
    const verifiedHash = remote.md5Checksum ? `md5:${localMd5}` : null;
    const writable = openDatabase(databasePath);
    try {
      return withImmediateTransaction(writable, () => {
        writable.prepare(`UPDATE claim_filings SET status='FILED',drive_file_id=?,verified_size=?,verified_hash=?,
          filed_by=?,filed_at=?,updated_at=? WHERE claim_id=?`)
          .run(remote.id, remote.size, verifiedHash, confirmingUser, now, now, reservation.draft.id);
        writable.prepare(`INSERT INTO claim_filing_attempts
          (claim_id,attempt_number,result,drive_file_id,verified_size,verified_hash,actor,occurred_at)
          VALUES (?,?,'SUCCEEDED',?,?,?,?,?)`)
          .run(reservation.draft.id, reservation.filing.attempt_count, remote.id, remote.size, verifiedHash, confirmingUser, now);
        writable.prepare("UPDATE claims SET status='FILED',confirmed_by=?,confirmed_at=?,filed_at=?,drive_source_file_id=? WHERE id=?")
          .run(confirmingUser, now, now, remote.id, reservation.draft.id);
        writable.prepare("UPDATE claim_receipts SET drive_file_id=? WHERE claim_id=?").run(remote.id, reservation.draft.id);
        writable.prepare("UPDATE pending_confirmations SET status='CONFIRMED',confirmed_at=? WHERE id=?").run(now, reservation.confirmation.id);
        updateDocumentNumberStatusInTransaction(writable, { allocationId: reservation.filing.document_number_id, status: 'ISSUED', entityId: reservation.draft.id, now });
        audit(writable, { now, actor: confirmingUser, action: 'claim.filed', claimId: reservation.draft.id, afterHash: reservation.draft.draftHash, details: { sizeVerified: true, hashVerified: Boolean(verifiedHash) } });
        return { claimId: reservation.draft.id, claimNumber: reservation.claim.claim_number, status: 'FILED', driveFiled: true };
      });
    } finally { writable.close(); }
  } catch (error) {
    const code = classifyDriveError(error);
    const writable = openDatabase(databasePath);
    try {
      withImmediateTransaction(writable, () => {
        writable.prepare("UPDATE claim_filings SET status='FILING_FAILED',last_error_code=?,updated_at=? WHERE claim_id=?").run(code, now, reservation.draft.id);
        writable.prepare(`INSERT INTO claim_filing_attempts
          (claim_id,attempt_number,result,error_code,actor,occurred_at) VALUES (?,?,'FAILED',?,?,?)`)
          .run(reservation.draft.id, reservation.filing.attempt_count, code, confirmingUser, now);
        writable.prepare("UPDATE claims SET status='FILING_FAILED' WHERE id=?").run(reservation.draft.id);
        updateDocumentNumberStatusInTransaction(writable, { allocationId: reservation.filing.document_number_id, status: 'ISSUE_FAILED', entityId: reservation.draft.id, now });
        audit(writable, { now, actor: confirmingUser, action: 'claim.filing_failed', claimId: reservation.draft.id, result: 'FAIL', details: { errorCode: code } });
      });
    } finally { writable.close(); }
    return { claimId: reservation.draft.id, claimNumber: reservation.claim.claim_number, status: 'FILING_FAILED', errorCode: code };
  }
}

export function getClaimRegister({ databasePath, includeDrafts = true }) {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    const where = includeDrafts ? '' : "WHERE c.status='FILED'";
    return database.prepare(`SELECT c.id,c.claim_number,c.status,c.transaction_date,c.merchant,c.category,c.client_or_project,
      c.currency,c.subtotal_minor,c.tax_minor,c.total_minor,c.payment_method,c.business_purpose,c.created_at,c.confirmed_at,c.filed_at,
      CASE WHEN c.drive_source_file_id IS NULL THEN 0 ELSE 1 END AS receipt_filed,
      r.source_sha256,r.source_mime_type,r.source_size,r.extraction_status,
      CASE WHEN r.probable_duplicate_fingerprint IS NULL THEN 0 ELSE
        (SELECT COUNT(*) FROM claim_receipts r2 WHERE r2.probable_duplicate_fingerprint=r.probable_duplicate_fingerprint AND r2.claim_id<>r.claim_id) END AS probable_duplicate_count
      FROM claims c JOIN claim_receipts r ON r.claim_id=c.id ${where} ORDER BY c.transaction_date,c.id`).all();
  } finally { database.close(); }
}
