import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { canonicalJson } from './quotation-drafts.mjs';
import {
  inspectReceiptAttachment as inspectDocumentAttachment,
  preserveReceiptAttachment as preserveDocumentAttachment
} from './receipt-attachments.mjs';
import { extractReceiptText as extractDocumentText } from './receipt-extraction.mjs';
import {
  classifyIncomingSupplierInvoice, extractSupplierInvoiceFields,
  probableSupplierInvoiceFingerprint
} from './supplier-invoice-extraction.mjs';
import { resolveSupplier } from './supplier-registry.mjs';
import { createGogDriveClient, DriveClientError } from './gog-drive-client.mjs';
import { loadDriveConfiguration } from './drive-configuration.mjs';
import { repositoryRoot } from '../validate-config.mjs';

const currencies = new Set(['MYR', 'SGD', 'USD']);
const tokenAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}
function optional(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function positiveId(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}
function instant(value, name = 'now') {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new TypeError(`${name} must be an ISO-8601 UTC instant.`);
  return parsed;
}
function calendarDate(value, name) {
  if (value == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${name} must use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new TypeError(`${name} must be a real calendar date.`);
  return value;
}
function minor(value, name, nullable = false) {
  if (nullable && value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer in minor units.`);
  return value;
}
function draftHash(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function secureToken() {
  const bytes = randomBytes(10);
  return `SI-${[...bytes].map((byte) => tokenAlphabet[byte % tokenAlphabet.length]).join('')}`;
}
function audit(database, { now, actor, action, invoiceId, beforeHash = null, afterHash = null, result = 'PASS', details = {} }) {
  database.prepare(`INSERT INTO audit_events
    (timestamp,actor,action,entity_type,entity_id,before_hash,after_hash,result,details_json)
    VALUES (?,?,?,'supplier_invoice',?,?,?,?,?)`)
    .run(now, actor, action, invoiceId, beforeHash, afterHash, result, canonicalJson(details));
}
async function categories(root) {
  const config = JSON.parse(await readFile(path.join(root, 'config', 'claim-categories.json'), 'utf8'));
  if (config.schemaVersion !== 1 || !Array.isArray(config.categories)) throw new Error('EXPENSE_CATEGORY_CONFIGURATION_INVALID');
  return config.categories;
}
function normalizeFields(fields, categoryIds) {
  const classification = fields.classification;
  if (classification !== 'SUPPLIER_INVOICE') throw new Error('INCOMING_SUPPLIER_INVOICE_CLASSIFICATION_REQUIRED');
  const supplierId = fields.supplierId == null ? null : positiveId(Number(fields.supplierId), 'supplier_id');
  const currency = fields.currency ? String(fields.currency).toUpperCase() : null;
  if (currency && !currencies.has(currency)) throw new TypeError('Unsupported supplier invoice currency.');
  const subtotalMinor = minor(fields.subtotalMinor, 'subtotal_minor', true);
  const taxMinor = minor(fields.taxMinor ?? 0, 'tax_minor');
  const totalMinor = minor(fields.totalMinor, 'total_minor', true);
  if (totalMinor != null && subtotalMinor != null && totalMinor !== subtotalMinor + taxMinor) throw new RangeError('Supplier invoice totals do not reconcile.');
  const expenseCategory = optional(fields.expenseCategory);
  if (expenseCategory && !categoryIds.has(expenseCategory)) throw new TypeError('Unknown expense category.');
  const issueDate = calendarDate(fields.issueDate, 'issue_date');
  const dueDate = calendarDate(fields.dueDate, 'due_date');
  if (fields.probableDuplicateReviewed != null && typeof fields.probableDuplicateReviewed !== 'boolean') {
    throw new TypeError('probable_duplicate_reviewed must be boolean.');
  }
  if (issueDate && dueDate && dueDate < issueDate) throw new RangeError('due_date cannot be before issue_date.');
  return {
    classification, supplierId, supplierInvoiceNumber: optional(fields.supplierInvoiceNumber),
    issueDate, dueDate, expenseCategory, projectAllocation: optional(fields.projectAllocation),
    currency, subtotalMinor, taxMinor, totalMinor, description: optional(fields.description),
    purchaseOrderReference: optional(fields.purchaseOrderReference),
    probableDuplicateReviewed: fields.probableDuplicateReviewed === true
  };
}
function validationIssues(fields) {
  const requiredFields = [
    ['missing_supplier', fields.supplierId], ['missing_supplier_invoice_number', fields.supplierInvoiceNumber],
    ['missing_issue_date', fields.issueDate], ['missing_due_date', fields.dueDate],
    ['missing_expense_category', fields.expenseCategory], ['missing_currency', fields.currency],
    ['missing_subtotal', fields.subtotalMinor], ['missing_total', fields.totalMinor]
  ];
  return requiredFields.filter(([, value]) => value == null || value === '').map(([issue]) => issue).sort();
}
function snapshot({ fields, document, extraction, probableDuplicateInvoiceId = null }) {
  return {
    kind: 'incoming-supplier-invoice-draft',
    fields,
    document: {
      filename: document.sourceFilename, mimeType: document.mimeType, size: document.size,
      sha256: document.sha256, storageRelativePath: document.storageRelativePath,
      extractionMethod: extraction.method, extractionStatus: extraction.status,
      rotationDegrees: extraction.rotationDegrees, extractedTextSha256: extraction.textSha256
    },
    probableDuplicate: probableDuplicateInvoiceId ? { supplierInvoiceId: probableDuplicateInvoiceId } : null,
    validationIssues: validationIssues(fields)
  };
}
function persistVersion(database, { invoiceId, version, value, actor, now }) {
  const versioned = { ...value, version };
  const hash = draftHash(versioned);
  database.prepare(`INSERT INTO supplier_invoice_draft_state
    (supplier_invoice_id,current_version,draft_hash,snapshot_json,validation_issues_json,updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(supplier_invoice_id) DO UPDATE SET current_version=excluded.current_version,draft_hash=excluded.draft_hash,
      snapshot_json=excluded.snapshot_json,validation_issues_json=excluded.validation_issues_json,updated_at=excluded.updated_at`)
    .run(invoiceId, version, hash, canonicalJson(versioned), canonicalJson(versioned.validationIssues), now);
  database.prepare(`INSERT INTO supplier_invoice_draft_versions
    (supplier_invoice_id,version,draft_hash,snapshot_json,created_by,created_at) VALUES (?,?,?,?,?,?)`)
    .run(invoiceId, version, hash, canonicalJson(versioned), actor, now);
  return { versioned, draftHash: hash };
}
function currentDraft(database, invoiceId) {
  const row = database.prepare(`SELECT i.id,i.status,s.current_version,s.draft_hash,s.snapshot_json
    FROM supplier_invoices i JOIN supplier_invoice_draft_state s ON s.supplier_invoice_id=i.id WHERE i.id=?`).get(invoiceId);
  if (!row) throw new Error('SUPPLIER_INVOICE_DRAFT_NOT_FOUND');
  return { id: row.id, status: row.status, version: row.current_version, draftHash: row.draft_hash, snapshot: JSON.parse(row.snapshot_json) };
}
function updateInvoice(database, invoiceId, fields) {
  database.prepare(`UPDATE supplier_invoices SET classification=?,supplier_id=?,supplier_invoice_number=?,issue_date=?,due_date=?,
    expense_category=?,project_allocation=?,currency=?,subtotal_minor=?,tax_minor=?,total_minor=?,description=?,purchase_order_reference=? WHERE id=?`)
    .run(fields.classification, fields.supplierId, fields.supplierInvoiceNumber, fields.issueDate, fields.dueDate,
      fields.expenseCategory, fields.projectAllocation, fields.currency, fields.subtotalMinor, fields.taxMinor,
      fields.totalMinor, fields.description, fields.purchaseOrderReference, invoiceId);
}
function classifyDriveError(error) {
  return error instanceof DriveClientError ? error.code : 'DRIVE_COMMAND_FAILED';
}

export async function createSupplierInvoiceDraft({
  databasePath, sourcePath, declaredMimeType = null, declaredClassification, actor,
  sourceChannel = null, sourceMessageReference = null, advisoryText = null, advisoryFields = {},
  root = repositoryRoot, intakeRoot = path.join(root, 'data', 'supplier-invoices', 'inbox'),
  storageRoot = path.join(root, 'data', 'supplier-invoices', 'originals'),
  now = new Date().toISOString(), pdfRunner, imageRunner
}) {
  required(actor, 'actor'); instant(now);
  classifyIncomingSupplierInvoice({ declaredClassification });
  const inspected = await inspectDocumentAttachment({ sourcePath, intakeRoot, declaredMimeType });
  const duplicateDb = openDatabase(databasePath, { readOnly: true });
  try {
    const duplicate = duplicateDb.prepare('SELECT supplier_invoice_id FROM supplier_invoice_documents WHERE source_sha256=?').get(inspected.sha256);
    if (duplicate) return { status: 'EXACT_DUPLICATE', existingSupplierInvoiceId: duplicate.supplier_invoice_id };
  } finally { duplicateDb.close(); }
  const extraction = await extractDocumentText({ filePath: inspected.sourcePath, mimeType: inspected.mimeType, advisoryText, pdfRunner, imageRunner });
  const classification = classifyIncomingSupplierInvoice({ declaredClassification, text: extraction.text });
  const categoryValues = await categories(root);
  const extracted = extractSupplierInvoiceFields({ text: extraction.text, advisoryFields, categories: categoryValues });
  const supplier = advisoryFields.supplierId
    ? { id: positiveId(Number(advisoryFields.supplierId), 'supplier_id') }
    : (extracted.supplierQuery ? resolveSupplier({ databasePath, query: extracted.supplierQuery }) : null);
  const fields = normalizeFields({ ...extracted, classification: classification.classification, supplierId: supplier?.id ?? null }, new Set(categoryValues.map((item) => item.id)));
  const validationDb = openDatabase(databasePath, { readOnly: true });
  try {
    if (fields.supplierId && !validationDb.prepare('SELECT id FROM suppliers WHERE id=? AND active=1').get(fields.supplierId)) throw new Error('SUPPLIER_NOT_FOUND_OR_INACTIVE');
    if (fields.supplierId && fields.supplierInvoiceNumber && validationDb.prepare(
      'SELECT id FROM supplier_invoices WHERE supplier_id=? AND lower(supplier_invoice_number)=lower(?)'
    ).get(fields.supplierId, fields.supplierInvoiceNumber)) throw new Error('SUPPLIER_INVOICE_NUMBER_DUPLICATE');
  } finally { validationDb.close(); }
  const preserved = await preserveDocumentAttachment({ inspected, storageRoot, receivedDate: now.slice(0, 10) });
  const fingerprint = probableSupplierInvoiceFingerprint(fields);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      if (fields.supplierId && !database.prepare('SELECT id FROM suppliers WHERE id=? AND active=1').get(fields.supplierId)) throw new Error('SUPPLIER_NOT_FOUND_OR_INACTIVE');
      const probable = fingerprint ? database.prepare(`SELECT supplier_invoice_id FROM supplier_invoice_documents
        WHERE probable_duplicate_fingerprint=? ORDER BY id LIMIT 1`).get(fingerprint) : null;
      const result = database.prepare(`INSERT INTO supplier_invoices
        (status,classification,supplier_id,supplier_invoice_number,issue_date,due_date,expense_category,project_allocation,
         currency,subtotal_minor,tax_minor,total_minor,description,purchase_order_reference,source_channel,
         source_message_reference,created_by,created_at)
        VALUES ('DRAFT',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        fields.classification, fields.supplierId, fields.supplierInvoiceNumber, fields.issueDate, fields.dueDate,
        fields.expenseCategory, fields.projectAllocation, fields.currency, fields.subtotalMinor, fields.taxMinor,
        fields.totalMinor, fields.description, fields.purchaseOrderReference, sourceChannel, sourceMessageReference, actor, now
      );
      const invoiceId = Number(result.lastInsertRowid);
      database.prepare(`INSERT INTO supplier_invoice_documents
        (supplier_invoice_id,source_filename,source_mime_type,source_size,source_sha256,storage_relative_path,
         extraction_method,extraction_status,extracted_text_sha256,rotation_degrees,probable_duplicate_fingerprint,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        invoiceId, inspected.sourceFilename, inspected.mimeType, inspected.size, inspected.sha256, preserved.relativePath,
        extraction.method, extraction.status, extracted.textSha256, extraction.rotationDegrees, fingerprint, now
      );
      const value = snapshot({
        fields, document: { ...inspected, storageRelativePath: preserved.relativePath },
        extraction: { ...extraction, textSha256: extracted.textSha256 },
        probableDuplicateInvoiceId: probable?.supplier_invoice_id ?? null
      });
      const state = persistVersion(database, { invoiceId, version: 1, value, actor, now });
      audit(database, { now, actor, action: 'supplier_invoice.draft_created', invoiceId, afterHash: state.draftHash, details: { advisoryMarkersPresent: classification.advisoryMarkersPresent, probableDuplicate: Boolean(probable) } });
      return { id: invoiceId, status: 'DRAFT', version: 1, draftHash: state.draftHash, snapshot: state.versioned };
    });
  } finally { database.close(); }
}

export async function reviseSupplierInvoiceDraft({ databasePath, supplierInvoiceId, fields: changes, actor, root = repositoryRoot, now = new Date().toISOString() }) {
  required(actor, 'actor'); instant(now);
  if (Object.hasOwn(changes, 'classification') && changes.classification !== 'SUPPLIER_INVOICE') throw new Error('INCOMING_SUPPLIER_INVOICE_CLASSIFICATION_REQUIRED');
  const categoryValues = await categories(root);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const before = currentDraft(database, supplierInvoiceId);
      if (!['DRAFT', 'PENDING_APPROVAL'].includes(before.status)) throw new Error('SUPPLIER_INVOICE_NOT_REVISABLE');
      const merged = normalizeFields({ ...before.snapshot.fields, ...changes, classification: 'SUPPLIER_INVOICE' }, new Set(categoryValues.map((item) => item.id)));
      if (merged.supplierId && !database.prepare('SELECT id FROM suppliers WHERE id=? AND active=1').get(merged.supplierId)) throw new Error('SUPPLIER_NOT_FOUND_OR_INACTIVE');
      const fingerprint = probableSupplierInvoiceFingerprint(merged);
      const probable = fingerprint ? database.prepare(`SELECT supplier_invoice_id FROM supplier_invoice_documents
        WHERE probable_duplicate_fingerprint=? AND supplier_invoice_id<>? ORDER BY id LIMIT 1`).get(fingerprint, supplierInvoiceId) : null;
      const document = database.prepare('SELECT * FROM supplier_invoice_documents WHERE supplier_invoice_id=?').get(supplierInvoiceId);
      const value = snapshot({
        fields: merged,
        document: { sourceFilename: document.source_filename, mimeType: document.source_mime_type, size: document.source_size, sha256: document.source_sha256, storageRelativePath: document.storage_relative_path },
        extraction: { method: document.extraction_method, status: document.extraction_status, rotationDegrees: document.rotation_degrees, textSha256: document.extracted_text_sha256 },
        probableDuplicateInvoiceId: probable?.supplier_invoice_id ?? null
      });
      updateInvoice(database, supplierInvoiceId, merged);
      database.prepare('UPDATE supplier_invoice_documents SET probable_duplicate_fingerprint=? WHERE supplier_invoice_id=?').run(fingerprint, supplierInvoiceId);
      database.prepare("UPDATE supplier_invoices SET status='DRAFT' WHERE id=?").run(supplierInvoiceId);
      database.prepare("UPDATE supplier_invoice_approvals SET status='INVALIDATED' WHERE supplier_invoice_id=? AND status='PENDING'").run(supplierInvoiceId);
      const state = persistVersion(database, { invoiceId: supplierInvoiceId, version: before.version + 1, value, actor, now });
      audit(database, { now, actor, action: 'supplier_invoice.draft_revised', invoiceId: supplierInvoiceId, beforeHash: before.draftHash, afterHash: state.draftHash });
      return { id: supplierInvoiceId, status: 'DRAFT', version: before.version + 1, draftHash: state.draftHash, snapshot: state.versioned };
    });
  } finally { database.close(); }
}

export function requestSupplierInvoiceApproval({
  databasePath, supplierInvoiceId, requestingUser, authorisedUser, sourceChannel, sourceChat,
  sourceMessageReference = null, now = new Date().toISOString(), ttlMinutes = 30
}) {
  if (required(requestingUser, 'requesting_user') !== required(authorisedUser, 'authorised_user')) throw new Error('SUPPLIER_INVOICE_APPROVAL_UNAUTHORISED');
  const current = instant(now);
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) throw new TypeError('ttlMinutes must be 1-1440.');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const draft = currentDraft(database, supplierInvoiceId);
      if (draft.snapshot.validationIssues.length) throw new Error(`SUPPLIER_INVOICE_INCOMPLETE:${draft.snapshot.validationIssues.join(',')}`);
      if (draft.snapshot.probableDuplicate && !draft.snapshot.fields.probableDuplicateReviewed) {
        throw new Error('SUPPLIER_INVOICE_PROBABLE_DUPLICATE_REQUIRES_REVIEW');
      }
      database.prepare("UPDATE supplier_invoice_approvals SET status='INVALIDATED' WHERE supplier_invoice_id=? AND status='PENDING'").run(supplierInvoiceId);
      const token = secureToken();
      const expiresAt = new Date(current.valueOf() + ttlMinutes * 60_000).toISOString();
      database.prepare(`INSERT INTO supplier_invoice_approvals
        (token,supplier_invoice_id,draft_version,draft_hash,requesting_user,source_channel,source_chat,
         source_message_reference,status,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,'PENDING',?,?)`).run(
        token, supplierInvoiceId, draft.version, draft.draftHash, requestingUser, required(sourceChannel, 'source_channel'),
        required(sourceChat, 'source_chat'), sourceMessageReference, expiresAt, now
      );
      database.prepare("UPDATE supplier_invoices SET status='PENDING_APPROVAL' WHERE id=?").run(supplierInvoiceId);
      audit(database, { now, actor: requestingUser, action: 'supplier_invoice.approval_requested', invoiceId: supplierInvoiceId, afterHash: draft.draftHash });
      return { supplierInvoiceId, token, expiresAt, version: draft.version, draftHash: draft.draftHash };
    });
  } finally { database.close(); }
}

export async function approveAndFileSupplierInvoice({
  databasePath, token, approvingUser, authorisedUser, root = repositoryRoot,
  now = new Date().toISOString(), driveClient = null
}) {
  if (required(approvingUser, 'approving_user') !== required(authorisedUser, 'authorised_user')) throw new Error('SUPPLIER_INVOICE_APPROVAL_UNAUTHORISED');
  const current = instant(now);
  const config = await loadDriveConfiguration({ root });
  const drive = driveClient ?? createGogDriveClient({ identity: config.identity, client: config.client });
  const database = openDatabase(databasePath);
  let reservation;
  try {
    reservation = withImmediateTransaction(database, () => {
      const approval = database.prepare('SELECT * FROM supplier_invoice_approvals WHERE token=?').get(required(token, 'token'));
      if (!approval || approval.status !== 'PENDING') throw new Error('SUPPLIER_INVOICE_APPROVAL_INVALID');
      if (approval.requesting_user !== approvingUser) throw new Error('SUPPLIER_INVOICE_APPROVAL_WRONG_USER');
      if (current.valueOf() >= new Date(approval.expires_at).valueOf()) {
        database.prepare("UPDATE supplier_invoice_approvals SET status='EXPIRED' WHERE id=?").run(approval.id);
        database.prepare("UPDATE supplier_invoices SET status='DRAFT' WHERE id=?").run(approval.supplier_invoice_id);
        return { errorCode: 'SUPPLIER_INVOICE_APPROVAL_EXPIRED' };
      }
      const draft = currentDraft(database, approval.supplier_invoice_id);
      if (draft.draftHash !== approval.draft_hash || draft.version !== approval.draft_version || draft.snapshot.validationIssues.length) throw new Error('SUPPLIER_INVOICE_DRAFT_CHANGED');
      let filing = database.prepare('SELECT * FROM supplier_invoice_filings WHERE supplier_invoice_id=?').get(draft.id);
      if (!filing) {
        database.prepare(`INSERT INTO supplier_invoice_filings
          (supplier_invoice_id,approval_id,draft_version,draft_hash,status,attempt_count,created_at,updated_at)
          VALUES (?,?,?,?, 'FILING',1,?,?)`).run(draft.id, approval.id, draft.version, draft.draftHash, now, now);
      } else {
        if (filing.approval_id !== approval.id || !['FILING', 'FILING_FAILED'].includes(filing.status)) throw new Error('SUPPLIER_INVOICE_FILING_STATE_INVALID');
        database.prepare("UPDATE supplier_invoice_filings SET status='FILING',attempt_count=attempt_count+1,last_error_code=NULL,updated_at=? WHERE supplier_invoice_id=?").run(now, draft.id);
      }
      database.prepare("UPDATE supplier_invoices SET status='FILING',approved_by=?,approved_at=? WHERE id=?").run(approvingUser, now, draft.id);
      return {
        approval, draft,
        filing: database.prepare('SELECT * FROM supplier_invoice_filings WHERE supplier_invoice_id=?').get(draft.id),
        document: database.prepare('SELECT * FROM supplier_invoice_documents WHERE supplier_invoice_id=?').get(draft.id)
      };
    });
  } finally { database.close(); }
  if (reservation.errorCode) throw new Error(reservation.errorCode);

  const filePath = path.resolve(root, 'data', 'supplier-invoices', 'originals', reservation.document.storage_relative_path);
  const metadata = await stat(filePath);
  const fileName = `supplier-invoice-${reservation.draft.id}-source${path.extname(reservation.document.storage_relative_path)}`;
  try {
    const candidates = await drive.findByName({ name: fileName, parentId: config.rootFolderId });
    if (candidates.length > 1) throw new DriveClientError('DRIVE_DUPLICATE_AMBIGUOUS');
    let remote = candidates[0] ?? await drive.uploadFile({ localPath: filePath, name: fileName, parentId: config.rootFolderId });
    remote = await drive.getMetadata(remote.id);
    if (remote.name !== fileName || remote.size !== metadata.size || !remote.parents.includes(config.rootFolderId)) throw new DriveClientError('DRIVE_UPLOAD_VERIFICATION_FAILED');
    const localMd5 = createHash('md5').update(await readFile(filePath)).digest('hex');
    if (remote.md5Checksum && remote.md5Checksum.toLowerCase() !== localMd5) throw new DriveClientError('DRIVE_UPLOAD_HASH_MISMATCH');
    const verifiedHash = remote.md5Checksum ? `md5:${localMd5}` : null;
    const writable = openDatabase(databasePath);
    try {
      return withImmediateTransaction(writable, () => {
        writable.prepare(`UPDATE supplier_invoice_filings SET status='FILED',drive_file_id=?,verified_size=?,verified_hash=?,
          filed_by=?,filed_at=?,updated_at=? WHERE supplier_invoice_id=?`).run(
          remote.id, remote.size, verifiedHash, approvingUser, now, now, reservation.draft.id
        );
        writable.prepare(`INSERT INTO supplier_invoice_filing_attempts
          (supplier_invoice_id,attempt_number,result,drive_file_id,verified_size,verified_hash,actor,occurred_at)
          VALUES (?,?,'SUCCEEDED',?,?,?,?,?)`).run(
          reservation.draft.id, reservation.filing.attempt_count, remote.id, remote.size, verifiedHash, approvingUser, now
        );
        writable.prepare("UPDATE supplier_invoices SET status='FILED',filed_at=?,drive_source_file_id=? WHERE id=?").run(now, remote.id, reservation.draft.id);
        writable.prepare("UPDATE supplier_invoice_documents SET drive_file_id=? WHERE supplier_invoice_id=?").run(remote.id, reservation.draft.id);
        writable.prepare("UPDATE supplier_invoice_approvals SET status='APPROVED',approved_at=? WHERE id=?").run(now, reservation.approval.id);
        audit(writable, { now, actor: approvingUser, action: 'supplier_invoice.filed', invoiceId: reservation.draft.id, afterHash: reservation.draft.draftHash, details: { sizeVerified: true, hashVerified: Boolean(verifiedHash) } });
        return { supplierInvoiceId: reservation.draft.id, status: 'FILED', driveFiled: true };
      });
    } finally { writable.close(); }
  } catch (error) {
    const errorCode = classifyDriveError(error);
    const writable = openDatabase(databasePath);
    try {
      withImmediateTransaction(writable, () => {
        writable.prepare("UPDATE supplier_invoice_filings SET status='FILING_FAILED',last_error_code=?,updated_at=? WHERE supplier_invoice_id=?").run(errorCode, now, reservation.draft.id);
        writable.prepare(`INSERT INTO supplier_invoice_filing_attempts
          (supplier_invoice_id,attempt_number,result,error_code,actor,occurred_at) VALUES (?,?,'FAILED',?,?,?)`)
          .run(reservation.draft.id, reservation.filing.attempt_count, errorCode, approvingUser, now);
        writable.prepare("UPDATE supplier_invoices SET status='FILING_FAILED' WHERE id=?").run(reservation.draft.id);
        audit(writable, { now, actor: approvingUser, action: 'supplier_invoice.filing_failed', invoiceId: reservation.draft.id, result: 'FAIL', details: { errorCode } });
      });
    } finally { writable.close(); }
    return { supplierInvoiceId: reservation.draft.id, status: 'FILING_FAILED', errorCode };
  }
}

export function getSupplierInvoiceRegister({ databasePath, includeDrafts = true }) {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    return database.prepare(`SELECT i.id,i.status,i.classification,i.supplier_invoice_number,s.supplier_code,s.display_name AS supplier_name,
      i.issue_date,i.due_date,i.expense_category,i.project_allocation,i.currency,i.subtotal_minor,i.tax_minor,i.total_minor,
      i.description,i.purchase_order_reference,i.created_at,i.approved_at,i.filed_at,
      CASE WHEN i.drive_source_file_id IS NULL THEN 0 ELSE 1 END AS source_filed,
      d.source_sha256,d.source_mime_type,d.source_size,d.extraction_status,
      CASE WHEN d.probable_duplicate_fingerprint IS NULL THEN 0 ELSE
        (SELECT COUNT(*) FROM supplier_invoice_documents d2 WHERE d2.probable_duplicate_fingerprint=d.probable_duplicate_fingerprint AND d2.supplier_invoice_id<>d.supplier_invoice_id) END AS probable_duplicate_count
      FROM supplier_invoices i LEFT JOIN suppliers s ON s.id=i.supplier_id
      JOIN supplier_invoice_documents d ON d.supplier_invoice_id=i.id
      ${includeDrafts ? '' : "WHERE i.status='FILED'"} ORDER BY i.issue_date,i.id`).all();
  } finally { database.close(); }
}
