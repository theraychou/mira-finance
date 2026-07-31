import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import {
  allocateDocumentNumberInTransaction, updateDocumentNumberStatusInTransaction
} from './numbering.mjs';
import { canonicalJson } from './quotation-drafts.mjs';
import { createQuotationDraft } from './quotation-drafts.mjs';
import { createStandaloneInvoiceDraft } from './invoice-drafts.mjs';
import { renderConvertAndFile } from './quotation-renderer.mjs';
import { renderCreditNoteDocx } from './credit-note-renderer.mjs';
import { repositoryRoot } from '../validate-config.mjs';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TYPES = {
  invoice: { table: 'invoices', issuance: 'invoice_issuances', id: 'invoice_id', number: 'invoice_number' },
  quotation: { table: 'quotations', issuance: 'quotation_issuances', id: 'quotation_id', number: 'quotation_number' }
};

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}
function optional(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
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
  return date;
}
function realDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${name} must use YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new TypeError(`${name} must be a real date.`);
  return value;
}
function hash(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function token(prefix = 'CR') {
  return `${prefix}-${[...randomBytes(10)].map((byte) => ALPHABET[byte % ALPHABET.length]).join('')}`;
}
function errorCode(error) {
  const value = typeof error?.code === 'string' ? error.code : error?.message;
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value)
    ? value : 'CORRECTION_RENDER_OR_VALIDATION_FAILED';
}
function audit(database, { now, actor, action, entityType, entityId, result = 'PASS', details = {}, afterHash = null }) {
  database.prepare(`INSERT INTO audit_events
    (timestamp,actor,action,entity_type,entity_id,after_hash,result,details_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(now, actor, action, entityType, entityId, afterHash, result, canonicalJson(details));
}
function history(database, { documentType, entityId, fromStatus, toStatus, reason = null, actor, now }) {
  database.prepare(`INSERT INTO document_status_history
    (document_type,entity_id,from_status,to_status,reason,actor,occurred_at)
    VALUES (?,?,?,?,?,?,?)`).run(documentType, entityId, fromStatus, toStatus, reason, actor, now);
}
function confirmation(database, {
  correctionType, entityId, snapshotHash, requestingUser, sourceChannel, sourceChat,
  sourceMessageReference, ttlMinutes, now, tokenFactory
}) {
  const current = instant(now);
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
    throw new TypeError('ttlMinutes must be 1-1440.');
  }
  database.prepare(`UPDATE correction_confirmations SET status='INVALIDATED'
    WHERE correction_type=? AND entity_id=? AND status='PENDING'`).run(correctionType, entityId);
  const confirmationToken = tokenFactory();
  if (!/^CR-[A-Z2-9]{10}$/.test(confirmationToken)) throw new TypeError('tokenFactory returned an invalid correction token.');
  const expiresAt = new Date(current.valueOf() + ttlMinutes * 60_000).toISOString();
  const row = database.prepare(`INSERT INTO correction_confirmations
    (token,correction_type,entity_id,snapshot_hash,requesting_user,source_channel,source_chat,
     source_message_reference,status,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,'PENDING',?,?)`).run(
    confirmationToken, correctionType, entityId, snapshotHash, requestingUser,
    required(sourceChannel, 'source_channel'), required(sourceChat, 'source_chat'),
    optional(sourceMessageReference), expiresAt, now
  );
  return { id: Number(row.lastInsertRowid), token: confirmationToken, expiresAt, snapshotHash };
}

function creditAvailability(database, invoiceId) {
  const invoice = database.prepare(`SELECT i.*,c.customer_code,c.legal_name AS customer_legal_name,
    c.display_name AS customer_display_name,c.billing_address,c.billing_contact_name,c.billing_email,c.billing_phone
    FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=?`).get(invoiceId);
  if (!invoice || invoice.status !== 'ISSUED') throw new Error('CREDIT_NOTE_REQUIRES_ISSUED_INVOICE');
  const issuedCredits = Number(database.prepare(`SELECT COALESCE(SUM(total_minor),0) AS total
    FROM credit_notes WHERE original_invoice_id=? AND status='ISSUED'`).get(invoiceId).total);
  return { invoice, issuedCredits, availableMinor: invoice.balance_due_minor - issuedCredits };
}

export function createCreditNoteDraft({
  databasePath, originalInvoiceId, issueDate, reason, lines, actor, now = new Date().toISOString()
}) {
  required(actor, 'actor'); instant(now); realDate(issueDate, 'issue_date');
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 7) throw new TypeError('lines must contain 1-7 items.');
  const normalized = lines.map((line, index) => ({
    originalInvoiceLineItemId: line.original_invoice_line_item_id == null
      ? null : positiveId(line.original_invoice_line_item_id, `lines[${index}].original_invoice_line_item_id`),
    description: required(line.description, `lines[${index}].description`),
    amountMinor: positiveId(line.amount_minor, `lines[${index}].amount_minor`)
  }));
  const totalMinor = normalized.reduce((sum, line) => sum + line.amountMinor, 0);
  if (!Number.isSafeInteger(totalMinor)) throw new RangeError('Credit total exceeds the safe integer range.');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const { invoice, availableMinor } = creditAvailability(database, positiveId(originalInvoiceId, 'original_invoice_id'));
      if (availableMinor < 1 || totalMinor > availableMinor) throw new Error('CREDIT_NOTE_EXCEEDS_AVAILABLE_BALANCE');
      for (const line of normalized) {
        if (line.originalInvoiceLineItemId != null) {
          const source = database.prepare('SELECT invoice_id FROM invoice_line_items WHERE id=?').get(line.originalInvoiceLineItemId);
          if (!source || source.invoice_id !== invoice.id) throw new Error('CREDIT_NOTE_LINE_ORIGINAL_MISMATCH');
        }
      }
      const currency = database.prepare('SELECT invoice_template_id,default_bank_profile_id FROM currencies WHERE code=? AND enabled=1').get(invoice.currency);
      if (!currency?.invoice_template_id || !currency?.default_bank_profile_id) throw new Error('CREDIT_NOTE_CURRENCY_CONFIGURATION_MISSING');
      const created = database.prepare(`INSERT INTO credit_notes
        (status,original_invoice_id,customer_id,business_entity_id,currency,issue_date,reason,total_minor,created_by,created_at)
        VALUES ('DRAFT',?,?,?,?,?,?,?,?,?)`).run(
        invoice.id, invoice.customer_id, invoice.business_entity_id, invoice.currency, issueDate,
        required(reason, 'reason'), totalMinor, actor, now
      );
      const creditNoteId = Number(created.lastInsertRowid);
      const insertLine = database.prepare(`INSERT INTO credit_note_line_items
        (credit_note_id,sequence,original_invoice_line_item_id,description,amount_minor) VALUES (?,?,?,?,?)`);
      for (const [index, line] of normalized.entries()) {
        insertLine.run(creditNoteId, index + 1, line.originalInvoiceLineItemId,
          `Credit for invoice ${invoice.invoice_number}: ${line.description}`, line.amountMinor);
      }
      const snapshot = {
        kind: 'credit-note-draft', version: 1, originalInvoiceId: invoice.id,
        originalInvoiceNumber: invoice.invoice_number,
        customer: {
          id: invoice.customer_id, customerCode: invoice.customer_code,
          legalName: invoice.customer_legal_name, displayName: invoice.customer_display_name,
          billingAddress: invoice.billing_address, billingContactName: invoice.billing_contact_name,
          billingEmail: invoice.billing_email, billingPhone: invoice.billing_phone
        },
        businessEntity: { id: invoice.business_entity_id },
        currency: invoice.currency, invoiceTemplateId: currency.invoice_template_id,
        bankProfileId: currency.default_bank_profile_id, issueDate, reason: required(reason, 'reason'),
        lineItems: normalized.map((line, index) => ({
          sequence: index + 1, originalInvoiceLineItemId: line.originalInvoiceLineItemId,
          description: `Credit for invoice ${invoice.invoice_number}: ${line.description}`,
          amountMinor: line.amountMinor
        })),
        totals: { totalMinor }, validationIssues: []
      };
      const draftHash = hash(snapshot);
      const snapshotJson = canonicalJson(snapshot);
      database.prepare(`INSERT INTO credit_note_draft_state
        (credit_note_id,current_version,draft_hash,snapshot_json,updated_at) VALUES (?,1,?,?,?)`)
        .run(creditNoteId, draftHash, snapshotJson, now);
      database.prepare(`INSERT INTO credit_note_draft_versions
        (credit_note_id,version,draft_hash,snapshot_json,created_by,created_at) VALUES (?,1,?,?,?,?)`)
        .run(creditNoteId, draftHash, snapshotJson, actor, now);
      history(database, { documentType: 'credit_note', entityId: creditNoteId, fromStatus: null, toStatus: 'DRAFT', actor, now });
      audit(database, { now, actor, action: 'credit_note.draft_created', entityType: 'credit_note', entityId: creditNoteId, afterHash: draftHash, details: { originalInvoiceId: invoice.id, totalMinor } });
      return { id: creditNoteId, status: 'DRAFT', draftHash, snapshot };
    });
  } finally { database.close(); }
}

export function requestCreditNoteConfirmation({
  databasePath, creditNoteId, requestingUser, authorisedUser, sourceChannel, sourceChat,
  sourceMessageReference = null, ttlMinutes = 15, now = new Date().toISOString(), tokenFactory = () => token()
}) {
  if (required(requestingUser, 'requesting_user') !== required(authorisedUser, 'authorised_user')) {
    throw new Error('CREDIT_NOTE_CONFIRMATION_UNAUTHORISED');
  }
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const row = database.prepare(`SELECT c.status,s.draft_hash,s.snapshot_json
        FROM credit_notes c JOIN credit_note_draft_state s ON s.credit_note_id=c.id WHERE c.id=?`)
        .get(positiveId(creditNoteId, 'credit_note_id'));
      if (!row || !['DRAFT','PENDING_CONFIRMATION'].includes(row.status)) throw new Error('CREDIT_NOTE_NOT_CONFIRMABLE');
      const snapshot = JSON.parse(row.snapshot_json);
      const { availableMinor } = creditAvailability(database, snapshot.originalInvoiceId);
      if (snapshot.totals.totalMinor > availableMinor) throw new Error('CREDIT_NOTE_EXCEEDS_AVAILABLE_BALANCE');
      const result = confirmation(database, {
        correctionType: 'CREDIT_NOTE_ISSUANCE', entityId: creditNoteId, snapshotHash: row.draft_hash,
        requestingUser, sourceChannel, sourceChat, sourceMessageReference, ttlMinutes, now, tokenFactory
      });
      database.prepare("UPDATE credit_notes SET status='PENDING_CONFIRMATION' WHERE id=?").run(creditNoteId);
      history(database, { documentType: 'credit_note', entityId: creditNoteId, fromStatus: row.status, toStatus: 'PENDING_CONFIRMATION', actor: requestingUser, now });
      return { ...result, creditNoteId };
    });
  } finally { database.close(); }
}

function reserveCreditNote(database, args) {
  const row = database.prepare(`SELECT cc.*,c.status AS credit_status,c.credit_note_number,s.current_version,
    s.draft_hash AS current_hash,s.snapshot_json
    FROM correction_confirmations cc JOIN credit_notes c ON c.id=cc.entity_id
    JOIN credit_note_draft_state s ON s.credit_note_id=c.id
    WHERE cc.token=? AND cc.correction_type='CREDIT_NOTE_ISSUANCE'`).get(args.token);
  if (!row || row.status !== 'PENDING') throw new Error('CORRECTION_CONFIRMATION_INVALID');
  if (new Date(row.expires_at).valueOf() <= new Date(args.now).valueOf()) {
    database.prepare("UPDATE correction_confirmations SET status='EXPIRED' WHERE id=?").run(row.id);
    database.prepare("UPDATE credit_notes SET status='DRAFT' WHERE id=?").run(row.entity_id);
    return { errorCode: 'CORRECTION_CONFIRMATION_EXPIRED' };
  }
  if (row.requesting_user !== args.confirmingUser) throw new Error('CORRECTION_CONFIRMATION_WRONG_USER');
  if (row.source_channel !== args.sourceChannel || row.source_chat !== args.sourceChat) throw new Error('CORRECTION_CONFIRMATION_CONTEXT_MISMATCH');
  if (row.snapshot_hash !== row.current_hash || row.credit_status !== 'PENDING_CONFIRMATION') throw new Error('CORRECTION_SNAPSHOT_CHANGED');
  const snapshot = JSON.parse(row.snapshot_json);
  const { availableMinor } = creditAvailability(database, snapshot.originalInvoiceId);
  if (snapshot.totals.totalMinor > availableMinor) throw new Error('CREDIT_NOTE_EXCEEDS_AVAILABLE_BALANCE');
  const allocation = allocateDocumentNumberInTransaction(database, {
    documentType: 'credit_note', sequenceDate: snapshot.issueDate, clientInitials: args.clientInitials, now: args.now
  });
  updateDocumentNumberStatusInTransaction(database, { allocationId: allocation.id, status: 'GENERATING', entityId: row.entity_id, now: args.now });
  database.prepare("UPDATE correction_confirmations SET status='CONFIRMED',confirmed_at=? WHERE id=?").run(args.now, row.id);
  database.prepare("UPDATE credit_notes SET status='GENERATING',credit_note_number=?,confirmed_by=?,confirmed_at=? WHERE id=?")
    .run(allocation.documentNumber, args.confirmingUser, args.now, row.entity_id);
  database.prepare(`INSERT INTO credit_note_issuances
    (credit_note_id,document_number_id,confirmation_id,draft_version,draft_hash,status,attempt_count,created_at,updated_at)
    VALUES (?,?,?,?,?,'GENERATING',1,?,?)`).run(row.entity_id, allocation.id, row.id, row.current_version, row.current_hash, args.now, args.now);
  history(database, { documentType: 'credit_note', entityId: row.entity_id, fromStatus: 'PENDING_CONFIRMATION', toStatus: 'GENERATING', actor: args.confirmingUser, now: args.now });
  return {
    creditNoteId: row.entity_id, documentNumberId: allocation.id, documentNumber: allocation.documentNumber,
    snapshot, actor: args.confirmingUser
  };
}

export class CorrectionError extends Error {
  constructor(code) { super(`Correction failed (${code}).`); this.name = 'CorrectionError'; this.code = code; }
}

export async function issueConfirmedCreditNote({
  databasePath, token: confirmationToken, confirmingUser, sourceChannel, sourceChat, clientInitials,
  root = repositoryRoot, outputRoot = path.join(repositoryRoot, 'generated', 'credit-notes'),
  testMode = false, documentRenderer = renderCreditNoteDocx, pdfConverter, pdfInspector,
  now = new Date().toISOString()
}) {
  instant(now);
  const args = {
    token: required(confirmationToken, 'token'), confirmingUser: required(confirmingUser, 'confirming_user'),
    sourceChannel: required(sourceChannel, 'source_channel'), sourceChat: required(sourceChat, 'source_chat'),
    clientInitials: required(clientInitials, 'client_initials'), now
  };
  const database = openDatabase(databasePath);
  let reservation;
  try {
    reservation = withImmediateTransaction(database, () => reserveCreditNote(database, args));
  } catch (error) {
    throw new CorrectionError(errorCode(error));
  } finally { database.close(); }
  if (reservation.errorCode) throw new CorrectionError(reservation.errorCode);
  try {
    const files = await renderConvertAndFile({
      root, outputRoot, snapshot: reservation.snapshot, documentNumber: reservation.documentNumber,
      testMode, documentRenderer, pdfConverter, pdfInspector
    });
    const writable = openDatabase(databasePath);
    try {
      return withImmediateTransaction(writable, () => {
        updateDocumentNumberStatusInTransaction(writable, {
          allocationId: reservation.documentNumberId, status: 'ISSUED',
          entityId: reservation.creditNoteId, now
        });
        writable.prepare(`UPDATE credit_note_issuances SET status='ISSUED',docx_relative_path=?,pdf_relative_path=?,
          docx_sha256=?,pdf_sha256=?,issued_by=?,issued_at=?,updated_at=? WHERE credit_note_id=?`).run(
          files.docxRelativePath, files.pdfRelativePath, files.docxSha256, files.pdfSha256,
          reservation.actor, now, now, reservation.creditNoteId
        );
        writable.prepare("UPDATE credit_notes SET status='ISSUED',issued_at=?,document_hash=? WHERE id=?")
          .run(now, files.pdfSha256, reservation.creditNoteId);
        writable.prepare(`INSERT INTO credit_note_issuance_attempts
          (credit_note_id,attempt_number,result,docx_sha256,pdf_sha256,actor,occurred_at)
          VALUES (?,1,'SUCCEEDED',?,?,?,?)`).run(
          reservation.creditNoteId, files.docxSha256, files.pdfSha256, reservation.actor, now
        );
        history(writable, { documentType: 'credit_note', entityId: reservation.creditNoteId, fromStatus: 'GENERATING', toStatus: 'ISSUED', actor: reservation.actor, now });
        audit(writable, { now, actor: reservation.actor, action: 'credit_note.issued', entityType: 'credit_note', entityId: reservation.creditNoteId, afterHash: files.pdfSha256, details: { originalInvoiceId: reservation.snapshot.originalInvoiceId, documentNumber: reservation.documentNumber, totalMinor: reservation.snapshot.totals.totalMinor } });
        return writable.prepare('SELECT * FROM credit_notes WHERE id=?').get(reservation.creditNoteId);
      });
    } catch (error) {
      await rm(files.docxPath, { force: true }); await rm(files.pdfPath, { force: true });
      throw error;
    } finally { writable.close(); }
  } catch (error) {
    const code = errorCode(error);
    const writable = openDatabase(databasePath);
    try {
      withImmediateTransaction(writable, () => {
        updateDocumentNumberStatusInTransaction(writable, {
          allocationId: reservation.documentNumberId, status: 'ISSUE_FAILED',
          entityId: reservation.creditNoteId, now
        });
        writable.prepare("UPDATE credit_notes SET status='ISSUE_FAILED' WHERE id=?").run(reservation.creditNoteId);
        writable.prepare("UPDATE credit_note_issuances SET status='ISSUE_FAILED',last_error_code=?,updated_at=? WHERE credit_note_id=?")
          .run(code, now, reservation.creditNoteId);
        writable.prepare(`INSERT INTO credit_note_issuance_attempts
          (credit_note_id,attempt_number,result,error_code,actor,occurred_at)
          VALUES (?,1,'FAILED',?,?,?)`).run(reservation.creditNoteId, code, reservation.actor, now);
        history(writable, { documentType: 'credit_note', entityId: reservation.creditNoteId, fromStatus: 'GENERATING', toStatus: 'ISSUE_FAILED', reason: code, actor: reservation.actor, now });
      });
    } finally { writable.close(); }
    throw new CorrectionError(code);
  }
}

function cancellationSnapshot(database, documentType, entityId, reason) {
  const definition = TYPES[documentType];
  if (!definition) throw new TypeError('document_type must be invoice or quotation.');
  const row = database.prepare(`SELECT e.*,i.document_number_id,i.status AS issuance_status
    FROM ${definition.table} e JOIN ${definition.issuance} i ON i.${definition.id}=e.id WHERE e.id=?`)
    .get(positiveId(entityId, 'entity_id'));
  if (!row || row.status !== 'ISSUED' || row.issuance_status !== 'ISSUED') throw new Error('CANCELLATION_REQUIRES_ISSUED_DOCUMENT');
  if (documentType === 'invoice') {
    if (row.amount_paid_minor !== 0) throw new Error('PAID_OR_PARTIALLY_PAID_INVOICE_CANNOT_BE_CANCELLED');
    const credits = database.prepare("SELECT COUNT(*) AS count FROM credit_notes WHERE original_invoice_id=? AND status='ISSUED'").get(row.id).count;
    if (credits) throw new Error('CREDITED_INVOICE_CANNOT_BE_CANCELLED');
  }
  return {
    documentType, entityId: row.id, documentNumber: row[definition.number],
    status: row.status, issuanceStatus: row.issuance_status,
    documentNumberId: row.document_number_id, reason: required(reason, 'reason')
  };
}

export function requestDocumentCancellation({
  databasePath, documentType, entityId, reason, requestingUser, authorisedUser,
  sourceChannel, sourceChat, sourceMessageReference = null, ttlMinutes = 15,
  now = new Date().toISOString(), tokenFactory = () => token()
}) {
  if (required(requestingUser, 'requesting_user') !== required(authorisedUser, 'authorised_user')) throw new Error('CANCELLATION_UNAUTHORISED');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const snapshot = cancellationSnapshot(database, documentType, entityId, reason);
      const snapshotHash = hash(snapshot);
      const result = confirmation(database, {
        correctionType: documentType === 'invoice' ? 'INVOICE_CANCELLATION' : 'QUOTATION_CANCELLATION',
        entityId: snapshot.entityId, snapshotHash, requestingUser, sourceChannel, sourceChat,
        sourceMessageReference, ttlMinutes, now, tokenFactory
      });
      audit(database, { now, actor: requestingUser, action: `${documentType}.cancellation_requested`, entityType: documentType, entityId: snapshot.entityId, afterHash: snapshotHash, details: { reason: snapshot.reason } });
      return { ...result, documentType, entityId: snapshot.entityId, documentNumber: snapshot.documentNumber };
    });
  } finally { database.close(); }
}

export function confirmDocumentCancellation({
  databasePath, token: confirmationToken, confirmingUser, authorisedUser,
  sourceChannel, sourceChat, now = new Date().toISOString()
}) {
  if (required(confirmingUser, 'confirming_user') !== required(authorisedUser, 'authorised_user')) throw new Error('CANCELLATION_UNAUTHORISED');
  const current = instant(now);
  const database = openDatabase(databasePath);
  let result;
  try {
    result = withImmediateTransaction(database, () => {
      const row = database.prepare(`SELECT * FROM correction_confirmations
        WHERE token=? AND correction_type IN ('INVOICE_CANCELLATION','QUOTATION_CANCELLATION')`).get(required(confirmationToken, 'token'));
      if (!row || row.status !== 'PENDING') throw new Error('CORRECTION_CONFIRMATION_INVALID');
      if (current.valueOf() >= new Date(row.expires_at).valueOf()) {
        database.prepare("UPDATE correction_confirmations SET status='EXPIRED' WHERE id=?").run(row.id);
        return { errorCode: 'CORRECTION_CONFIRMATION_EXPIRED' };
      }
      if (row.requesting_user !== confirmingUser) throw new Error('CORRECTION_CONFIRMATION_WRONG_USER');
      if (row.source_channel !== sourceChannel || row.source_chat !== sourceChat) throw new Error('CORRECTION_CONFIRMATION_CONTEXT_MISMATCH');
      const documentType = row.correction_type === 'INVOICE_CANCELLATION' ? 'invoice' : 'quotation';
      const requested = database.prepare(`SELECT details_json FROM audit_events WHERE action=? AND entity_id=? AND after_hash=?
        ORDER BY id DESC LIMIT 1`).get(`${documentType}.cancellation_requested`, row.entity_id, row.snapshot_hash);
      if (!requested) throw new Error('CANCELLATION_REQUEST_AUDIT_MISSING');
      const cancellationReason = JSON.parse(requested.details_json).reason;
      const original = cancellationSnapshot(database, documentType, row.entity_id, cancellationReason);
      if (hash(original) !== row.snapshot_hash) throw new Error('CORRECTION_SNAPSHOT_CHANGED');
      const definition = TYPES[documentType];
      updateDocumentNumberStatusInTransaction(database, {
        allocationId: original.documentNumberId, status: 'CANCELLED', entityId: original.entityId, now
      });
      database.prepare(`UPDATE ${definition.table} SET status='CANCELLED',cancelled_at=? WHERE id=?`).run(now, original.entityId);
      if (documentType === 'invoice') {
        database.prepare(`UPDATE invoice_payment_drafts SET status='INVALIDATED'
          WHERE invoice_id=? AND status='PENDING'`).run(original.entityId);
        database.prepare(`UPDATE claim_recharge_confirmations SET status='INVALIDATED'
          WHERE invoice_id=? AND status='PENDING'`).run(original.entityId);
      }
      if (documentType === 'quotation') {
        database.prepare(`UPDATE quotation_issuances SET status='CANCELLED',cancelled_by=?,cancelled_at=?,
          cancellation_reason='Confirmed F15 cancellation',updated_at=? WHERE quotation_id=?`)
          .run(confirmingUser, now, now, original.entityId);
      }
      database.prepare("UPDATE correction_confirmations SET status='CONFIRMED',confirmed_at=? WHERE id=?").run(now, row.id);
      const cancellation = database.prepare(`INSERT INTO document_cancellations
        (document_type,entity_id,document_number,confirmation_id,reason,cancelled_by,cancelled_at)
        VALUES (?,?,?,?,?,?,?)`).run(
        documentType, original.entityId, original.documentNumber, row.id,
        cancellationReason, confirmingUser, now
      );
      history(database, { documentType, entityId: original.entityId, fromStatus: 'ISSUED', toStatus: 'CANCELLED', reason: cancellationReason, actor: confirmingUser, now });
      audit(database, { now, actor: confirmingUser, action: `${documentType}.cancelled`, entityType: documentType, entityId: original.entityId, details: { cancellationId: Number(cancellation.lastInsertRowid), originalPreserved: true } });
      return { documentType, entityId: original.entityId, documentNumber: original.documentNumber, status: 'CANCELLED' };
    });
  } finally { database.close(); }
  if (result?.errorCode) throw new CorrectionError(result.errorCode);
  return result;
}

function replacementReference(documentType, originalNumber, description) {
  return `Replacement for ${documentType} ${originalNumber}: ${description}`;
}

export function createReplacementInvoiceDraft({
  databasePath, originalInvoiceId, issueDate, paymentTermsDays, actor, reason, now = new Date().toISOString()
}) {
  const database = openDatabase(databasePath, { readOnly: true });
  let original;
  try {
    original = database.prepare(`SELECT i.*,s.snapshot_json FROM invoices i
      JOIN invoice_draft_state s ON s.invoice_id=i.id WHERE i.id=?`).get(positiveId(originalInvoiceId, 'original_invoice_id'));
    if (!original || original.status !== 'CANCELLED') throw new Error('REPLACEMENT_REQUIRES_CANCELLED_INVOICE');
    if (database.prepare("SELECT id FROM replacement_document_links WHERE document_type='invoice' AND original_entity_id=?").get(original.id)) {
      throw new Error('REPLACEMENT_ALREADY_EXISTS');
    }
  } finally { database.close(); }
  const source = JSON.parse(original.snapshot_json);
  const draft = createStandaloneInvoiceDraft({
    databasePath, actor, now, input: {
      customer_id: original.customer_id, business_entity_id: original.business_entity_id,
      currency: original.currency, issue_date: realDate(issueDate, 'issue_date'),
      payment_terms_days: paymentTermsDays, service_date: source.serviceDate,
      purchase_order_number: source.purchaseOrderNumber, payment_terms: source.paymentTerms,
      notes: replacementReference('invoice', original.invoice_number, required(reason, 'reason')),
      line_items: source.lineItems.map((line, index) => ({
        description: index === 0 ? replacementReference('invoice', original.invoice_number, line.description) : line.description,
        quantity: line.quantity, unit: line.unit, unit_price_minor: line.unitPriceMinor
      })),
      discount: source.discount.type === 'FIXED' ? { type: 'FIXED', amount_minor: source.discount.value }
        : source.discount.type === 'PERCENTAGE' ? { type: 'PERCENTAGE', basis_points: source.discount.value } : { type: 'NONE' },
      tax: { mode: 'NONE' }
    }
  });
  const writable = openDatabase(databasePath);
  try {
    withImmediateTransaction(writable, () => {
      writable.prepare(`INSERT INTO replacement_document_links
        (document_type,original_entity_id,original_document_number,replacement_entity_id,reason,created_by,created_at)
        VALUES ('invoice',?,?,?,?,?,?)`).run(original.id, original.invoice_number, draft.id, required(reason, 'reason'), actor, now);
      audit(writable, { now, actor, action: 'invoice.replacement_draft_created', entityType: 'invoice', entityId: draft.id, details: { originalInvoiceId: original.id, originalDocumentNumber: original.invoice_number } });
    });
  } finally { writable.close(); }
  return draft;
}

export function createReplacementQuotationDraft({
  databasePath, originalQuotationId, issueDate, validityDays, actor, reason, now = new Date().toISOString()
}) {
  const database = openDatabase(databasePath, { readOnly: true });
  let original;
  try {
    original = database.prepare(`SELECT q.*,s.snapshot_json FROM quotations q
      JOIN quotation_draft_state s ON s.quotation_id=q.id WHERE q.id=?`).get(positiveId(originalQuotationId, 'original_quotation_id'));
    if (!original || original.status !== 'CANCELLED') throw new Error('REPLACEMENT_REQUIRES_CANCELLED_QUOTATION');
    if (database.prepare("SELECT id FROM replacement_document_links WHERE document_type='quotation' AND original_entity_id=?").get(original.id)) {
      throw new Error('REPLACEMENT_ALREADY_EXISTS');
    }
  } finally { database.close(); }
  const source = JSON.parse(original.snapshot_json);
  const draft = createQuotationDraft({
    databasePath, actor, now, input: {
      customer_id: original.customer_id, business_entity_id: original.business_entity_id,
      currency: original.currency, issue_date: realDate(issueDate, 'issue_date'), validity_days: validityDays,
      service_date: source.serviceDate, title: replacementReference('quotation', original.quotation_number, source.title ?? 'replacement'),
      description: replacementReference('quotation', original.quotation_number, required(reason, 'reason')),
      payment_terms: source.paymentTerms, notes: replacementReference('quotation', original.quotation_number, required(reason, 'reason')),
      line_items: source.lineItems.map((line, index) => ({
        description: index === 0 ? replacementReference('quotation', original.quotation_number, line.description) : line.description,
        quantity: line.quantity, unit: line.unit, unit_price_minor: line.unitPriceMinor
      })),
      discount: source.discount.type === 'FIXED' ? { type: 'FIXED', amount_minor: source.discount.value }
        : source.discount.type === 'PERCENTAGE' ? { type: 'PERCENTAGE', basis_points: source.discount.value } : { type: 'NONE' },
      tax: { mode: 'NONE' }
    }
  });
  const writable = openDatabase(databasePath);
  try {
    withImmediateTransaction(writable, () => {
      writable.prepare(`INSERT INTO replacement_document_links
        (document_type,original_entity_id,original_document_number,replacement_entity_id,reason,created_by,created_at)
        VALUES ('quotation',?,?,?,?,?,?)`).run(original.id, original.quotation_number, draft.id, required(reason, 'reason'), actor, now);
      audit(writable, { now, actor, action: 'quotation.replacement_draft_created', entityType: 'quotation', entityId: draft.id, details: { originalQuotationId: original.id, originalDocumentNumber: original.quotation_number } });
    });
  } finally { writable.close(); }
  return draft;
}
