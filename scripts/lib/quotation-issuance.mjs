import path from 'node:path';
import { rm } from 'node:fs/promises';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import {
  allocateDocumentNumberInTransaction,
  updateDocumentNumberStatusInTransaction
} from './numbering.mjs';
import { canonicalJson } from './quotation-drafts.mjs';
import { renderConvertAndFile } from './quotation-renderer.mjs';
import { repositoryRoot } from '../validate-config.mjs';

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} is required.`);
  return value.trim();
}

function requireInstant(value, name) {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TypeError(`${name} must be an ISO-8601 UTC instant.`);
  }
  return parsed;
}

function errorCode(error) {
  const candidate = typeof error?.code === 'string' ? error.code : error?.message;
  return typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(candidate)
    ? candidate
    : 'RENDER_OR_VALIDATION_FAILED';
}

export class QuotationIssuanceError extends Error {
  constructor(code) {
    super(`Quotation issuance failed (${code}).`);
    this.name = 'QuotationIssuanceError';
    this.code = code;
  }
}

function appendAudit(database, {
  now, actor, action, quotationId, result = 'PASS', beforeHash = null,
  afterHash = null, sourceChannel = null, sourceChat = null, sourceMessageReference = null, details = {}
}) {
  database.prepare(`
    INSERT INTO audit_events (
      timestamp, actor, action, entity_type, entity_id, before_hash, after_hash,
      source_channel, source_chat, source_message_reference, result, details_json
    ) VALUES (?, ?, ?, 'quotation', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now, actor, action, quotationId, beforeHash, afterHash,
    sourceChannel, sourceChat, sourceMessageReference, result, canonicalJson(details)
  );
}

function validateSnapshotAgainstLedger(row, snapshot) {
  const totals = snapshot.totals;
  if (
    row.subtotal_minor !== totals.subtotalMinor
    || row.discount_minor !== totals.discountMinor
    || row.tax_minor !== totals.taxMinor
    || row.total_minor !== totals.totalMinor
  ) throw new Error('DRAFT_LEDGER_TOTAL_MISMATCH');
  if (snapshot.validationIssues.length > 0) throw new Error('INCOMPLETE_QUOTATION_DRAFT');
  if (snapshot.lineItems.length < 1 || snapshot.lineItems.length > 7) throw new Error('LINE_ITEM_LIMIT_EXCEEDED');
  if (snapshot.taxMode !== 'NONE' || totals.taxMinor !== 0) throw new Error('NON_ZERO_TAX_NOT_RENDERABLE');
}

function reserveIssuance(database, {
  token, confirmingUser, sourceChannel, sourceChat, clientInitials, now
}) {
  const confirmation = database.prepare(`
    SELECT pc.*, q.status AS quotation_status, q.quotation_number,
      q.subtotal_minor, q.discount_minor, q.tax_minor, q.total_minor,
      s.current_version, s.draft_hash AS current_draft_hash, s.snapshot_json
    FROM pending_confirmations pc
    JOIN quotations q ON q.id = pc.draft_id
    JOIN quotation_draft_state s ON s.quotation_id = q.id
    WHERE pc.token = ? AND pc.draft_type = 'quotation'
  `).get(token);
  if (!confirmation) throw new Error('CONFIRMATION_TOKEN_NOT_FOUND');
  if (confirmation.status !== 'PENDING') throw new Error('CONFIRMATION_TOKEN_NOT_PENDING');
  if (new Date(confirmation.expires_at).valueOf() <= new Date(now).valueOf()) {
    database.prepare("UPDATE pending_confirmations SET status = 'EXPIRED' WHERE id = ?").run(confirmation.id);
    database.prepare("UPDATE quotations SET status = 'DRAFT' WHERE id = ? AND status = 'PENDING_CONFIRMATION'").run(confirmation.draft_id);
    return { rejectedCode: 'CONFIRMATION_TOKEN_EXPIRED' };
  }
  if (confirmation.requesting_user !== confirmingUser) throw new Error('CONFIRMING_USER_MISMATCH');
  if (confirmation.source_channel !== sourceChannel || confirmation.source_chat !== sourceChat) {
    throw new Error('CONFIRMATION_CONTEXT_MISMATCH');
  }
  if (confirmation.draft_hash !== confirmation.current_draft_hash) throw new Error('CONFIRMATION_DRAFT_HASH_MISMATCH');
  if (confirmation.quotation_status !== 'PENDING_CONFIRMATION' || confirmation.quotation_number !== null) {
    throw new Error('QUOTATION_NOT_PENDING_CONFIRMATION');
  }
  const snapshot = JSON.parse(confirmation.snapshot_json);
  validateSnapshotAgainstLedger(confirmation, snapshot);
  const allocation = allocateDocumentNumberInTransaction(database, {
    documentType: 'quotation', sequenceDate: snapshot.issueDate, clientInitials, now
  });
  updateDocumentNumberStatusInTransaction(database, {
    allocationId: allocation.id, status: 'GENERATING', entityId: confirmation.draft_id, now
  });
  database.prepare(`
    UPDATE pending_confirmations SET status = 'CONFIRMED', confirmed_at = ? WHERE id = ?
  `).run(now, confirmation.id);
  database.prepare(`
    UPDATE quotations SET quotation_number = ?, status = 'GENERATING', confirmed_by = ?, confirmed_at = ?
    WHERE id = ?
  `).run(allocation.documentNumber, confirmingUser, now, confirmation.draft_id);
  database.prepare(`
    INSERT INTO quotation_issuances (
      quotation_id, document_number_id, confirmation_id, draft_version, draft_hash,
      status, attempt_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'GENERATING', 1, ?, ?)
  `).run(
    confirmation.draft_id, allocation.id, confirmation.id,
    confirmation.current_version, confirmation.current_draft_hash, now, now
  );
  appendAudit(database, {
    now, actor: confirmingUser, action: 'quotation.issuance_started', quotationId: confirmation.draft_id,
    afterHash: confirmation.current_draft_hash, sourceChannel, sourceChat,
    sourceMessageReference: confirmation.source_message_reference,
    details: { attemptNumber: 1, documentNumber: allocation.documentNumber, draftVersion: confirmation.current_version }
  });
  return {
    quotationId: confirmation.draft_id,
    documentNumberId: allocation.id,
    confirmationId: confirmation.id,
    documentNumber: allocation.documentNumber,
    attemptNumber: 1,
    snapshot,
    actor: confirmingUser
  };
}

function reserveRetry(database, { quotationId, retryingUser, now }) {
  const row = database.prepare(`
    SELECT qi.*, q.status AS quotation_status, q.quotation_number, q.confirmed_by,
      dn.status AS number_status, s.snapshot_json, s.draft_hash AS current_draft_hash
    FROM quotation_issuances qi
    JOIN quotations q ON q.id = qi.quotation_id
    JOIN document_numbers dn ON dn.id = qi.document_number_id
    JOIN quotation_draft_state s ON s.quotation_id = qi.quotation_id
    WHERE qi.quotation_id = ?
  `).get(quotationId);
  if (!row) throw new Error('QUOTATION_ISSUANCE_NOT_FOUND');
  if (row.status !== 'ISSUE_FAILED' || row.quotation_status !== 'ISSUE_FAILED' || row.number_status !== 'ISSUE_FAILED') {
    throw new Error('QUOTATION_NOT_RETRYABLE');
  }
  if (row.confirmed_by !== retryingUser) throw new Error('RETRYING_USER_MISMATCH');
  if (row.draft_hash !== row.current_draft_hash) throw new Error('RETRY_DRAFT_HASH_MISMATCH');
  const attemptNumber = row.attempt_count + 1;
  updateDocumentNumberStatusInTransaction(database, {
    allocationId: row.document_number_id, status: 'GENERATING', entityId: quotationId, now
  });
  database.prepare("UPDATE quotations SET status = 'GENERATING' WHERE id = ?").run(quotationId);
  database.prepare(`
    UPDATE quotation_issuances
    SET status = 'GENERATING', attempt_count = ?, last_error_code = NULL, updated_at = ?
    WHERE quotation_id = ?
  `).run(attemptNumber, now, quotationId);
  appendAudit(database, {
    now, actor: retryingUser, action: 'quotation.issuance_retry_started', quotationId,
    afterHash: row.draft_hash,
    details: { attemptNumber, documentNumber: row.quotation_number }
  });
  return {
    quotationId,
    documentNumberId: row.document_number_id,
    confirmationId: row.confirmation_id,
    documentNumber: row.quotation_number,
    attemptNumber,
    snapshot: JSON.parse(row.snapshot_json),
    actor: retryingUser
  };
}

function recordFailure(databasePath, reservation, error, now) {
  const code = errorCode(error);
  const database = openDatabase(databasePath);
  try {
    withImmediateTransaction(database, () => {
      const issuance = database.prepare('SELECT status FROM quotation_issuances WHERE quotation_id = ?').get(reservation.quotationId);
      if (!issuance || issuance.status !== 'GENERATING') return;
      updateDocumentNumberStatusInTransaction(database, {
        allocationId: reservation.documentNumberId, status: 'ISSUE_FAILED', entityId: reservation.quotationId, now
      });
      database.prepare("UPDATE quotations SET status = 'ISSUE_FAILED' WHERE id = ?").run(reservation.quotationId);
      database.prepare(`
        UPDATE quotation_issuances SET status = 'ISSUE_FAILED', last_error_code = ?, updated_at = ?
        WHERE quotation_id = ?
      `).run(code, now, reservation.quotationId);
      database.prepare(`
        INSERT INTO quotation_issuance_attempts (
          quotation_id, attempt_number, result, error_code, actor, occurred_at
        ) VALUES (?, ?, 'FAILED', ?, ?, ?)
      `).run(reservation.quotationId, reservation.attemptNumber, code, reservation.actor, now);
      appendAudit(database, {
        now, actor: reservation.actor, action: 'quotation.issuance_failed',
        quotationId: reservation.quotationId, result: 'FAIL',
        details: { attemptNumber: reservation.attemptNumber, errorCode: code, documentNumber: reservation.documentNumber }
      });
    });
  } finally {
    database.close();
  }
  return code;
}

function recordSuccess(databasePath, reservation, files, now) {
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const issuance = database.prepare('SELECT status FROM quotation_issuances WHERE quotation_id = ?').get(reservation.quotationId);
      if (!issuance || issuance.status !== 'GENERATING') throw new Error('ISSUANCE_STATE_CHANGED');
      updateDocumentNumberStatusInTransaction(database, {
        allocationId: reservation.documentNumberId, status: 'ISSUED', entityId: reservation.quotationId, now
      });
      database.prepare(`
        UPDATE quotation_issuances SET
          status = 'ISSUED', last_error_code = NULL,
          docx_relative_path = ?, pdf_relative_path = ?, docx_sha256 = ?, pdf_sha256 = ?,
          issued_by = ?, issued_at = ?, updated_at = ?
        WHERE quotation_id = ?
      `).run(
        files.docxRelativePath, files.pdfRelativePath, files.docxSha256, files.pdfSha256,
        reservation.actor, now, now, reservation.quotationId
      );
      database.prepare(`
        UPDATE quotations SET status = 'ISSUED', issued_at = ?, document_hash = ? WHERE id = ?
      `).run(now, files.pdfSha256, reservation.quotationId);
      database.prepare(`
        INSERT INTO quotation_issuance_attempts (
          quotation_id, attempt_number, result, docx_sha256, pdf_sha256, actor, occurred_at
        ) VALUES (?, ?, 'SUCCEEDED', ?, ?, ?, ?)
      `).run(
        reservation.quotationId, reservation.attemptNumber,
        files.docxSha256, files.pdfSha256, reservation.actor, now
      );
      appendAudit(database, {
        now, actor: reservation.actor, action: 'quotation.issued', quotationId: reservation.quotationId,
        afterHash: files.pdfSha256,
        details: {
          attemptNumber: reservation.attemptNumber,
          documentNumber: reservation.documentNumber,
          docxSha256: files.docxSha256,
          pdfSha256: files.pdfSha256
        }
      });
      return getIssuanceFromDatabase(database, reservation.quotationId);
    });
  } finally {
    database.close();
  }
}

function getIssuanceFromDatabase(database, quotationId) {
  const row = database.prepare(`
    SELECT qi.*, q.quotation_number, q.status AS quotation_status
    FROM quotation_issuances qi JOIN quotations q ON q.id = qi.quotation_id
    WHERE qi.quotation_id = ?
  `).get(quotationId);
  if (!row) throw new Error('Quotation issuance was not found.');
  return row;
}

async function executeReservedIssuance({
  databasePath, reservation, root, outputRoot, testMode,
  documentRenderer, pdfConverter, pdfInspector, now
}) {
  try {
    const files = await renderConvertAndFile({
      root, outputRoot, snapshot: reservation.snapshot,
      documentNumber: reservation.documentNumber, testMode,
      documentRenderer, pdfConverter, pdfInspector
    });
    try {
      return recordSuccess(databasePath, reservation, files, now);
    } catch (error) {
      await rm(files.docxPath, { force: true });
      await rm(files.pdfPath, { force: true });
      throw error;
    }
  } catch (error) {
    const code = recordFailure(databasePath, reservation, error, now);
    throw new QuotationIssuanceError(code);
  }
}

export async function issueConfirmedQuotation({
  databasePath, token, confirmingUser, sourceChannel, sourceChat, clientInitials,
  root = repositoryRoot, outputRoot = path.join(repositoryRoot, 'generated', 'quotations'),
  testMode = false, documentRenderer, pdfConverter, pdfInspector,
  now = new Date().toISOString()
}) {
  requireInstant(now, 'now');
  const validatedToken = requireText(token, 'token');
  const user = requireText(confirmingUser, 'confirmingUser');
  const channel = requireText(sourceChannel, 'sourceChannel');
  const chat = requireText(sourceChat, 'sourceChat');
  const initials = requireText(clientInitials, 'clientInitials');
  const database = openDatabase(databasePath);
  let reservation;
  try {
    reservation = withImmediateTransaction(database, () => reserveIssuance(database, {
      token: validatedToken, confirmingUser: user, sourceChannel: channel,
      sourceChat: chat, clientInitials: initials, now
    }));
    if (reservation.rejectedCode) throw new QuotationIssuanceError(reservation.rejectedCode);
  } catch (error) {
    if (error instanceof QuotationIssuanceError) throw error;
    const code = errorCode(error);
    throw new QuotationIssuanceError(code);
  } finally {
    database.close();
  }
  return executeReservedIssuance({
    databasePath, reservation, root, outputRoot, testMode,
    documentRenderer, pdfConverter, pdfInspector, now
  });
}

export async function retryQuotationIssuance({
  databasePath, quotationId, retryingUser,
  root = repositoryRoot, outputRoot = path.join(repositoryRoot, 'generated', 'quotations'),
  testMode = false, documentRenderer, pdfConverter, pdfInspector,
  now = new Date().toISOString()
}) {
  requireInstant(now, 'now');
  if (!Number.isSafeInteger(quotationId) || quotationId < 1) throw new TypeError('quotationId must be a positive integer.');
  const user = requireText(retryingUser, 'retryingUser');
  const database = openDatabase(databasePath);
  let reservation;
  try {
    reservation = withImmediateTransaction(database, () => reserveRetry(database, {
      quotationId, retryingUser: user, now
    }));
  } catch (error) {
    throw new QuotationIssuanceError(errorCode(error));
  } finally {
    database.close();
  }
  return executeReservedIssuance({
    databasePath, reservation, root, outputRoot, testMode,
    documentRenderer, pdfConverter, pdfInspector, now
  });
}

export function cancelQuotationIssuance({
  databasePath, quotationId, cancellingUser, reason, now = new Date().toISOString()
}) {
  requireInstant(now, 'now');
  const actor = requireText(cancellingUser, 'cancellingUser');
  const cancellationReason = requireText(reason, 'reason');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const issuance = getIssuanceFromDatabase(database, quotationId);
      if (!['ISSUE_FAILED', 'ISSUED'].includes(issuance.status)) throw new Error('Quotation issuance cannot be cancelled from its current status.');
      updateDocumentNumberStatusInTransaction(database, {
        allocationId: issuance.document_number_id, status: 'CANCELLED', entityId: quotationId, now
      });
      database.prepare(`
        UPDATE quotation_issuances SET status = 'CANCELLED', cancelled_by = ?,
          cancelled_at = ?, cancellation_reason = ?, updated_at = ? WHERE quotation_id = ?
      `).run(actor, now, cancellationReason, now, quotationId);
      database.prepare("UPDATE quotations SET status = 'CANCELLED', cancelled_at = ? WHERE id = ?").run(now, quotationId);
      appendAudit(database, {
        now, actor, action: 'quotation.cancelled', quotationId,
        details: { documentNumber: issuance.quotation_number, reasonRecorded: true }
      });
      return getIssuanceFromDatabase(database, quotationId);
    });
  } finally {
    database.close();
  }
}

export function getQuotationIssuance({ databasePath, quotationId }) {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    return getIssuanceFromDatabase(database, quotationId);
  } finally {
    database.close();
  }
}
