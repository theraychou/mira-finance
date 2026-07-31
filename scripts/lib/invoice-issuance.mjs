import path from 'node:path';
import { rm } from 'node:fs/promises';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { allocateDocumentNumberInTransaction, updateDocumentNumberStatusInTransaction } from './numbering.mjs';
import { canonicalJson } from './quotation-drafts.mjs';
import { renderConvertAndFile } from './quotation-renderer.mjs';
import { renderInvoiceDocx } from './invoice-renderer.mjs';
import { repositoryRoot } from '../validate-config.mjs';

function text(value, name) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`); return value.trim(); }
function instant(value) { const date = new Date(value); if (typeof value !== 'string' || Number.isNaN(date.valueOf()) || date.toISOString() !== value) throw new TypeError('now must be an ISO-8601 UTC instant.'); }
function code(error) { const value = typeof error?.code === 'string' ? error.code : error?.message; return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value) ? value : 'RENDER_OR_VALIDATION_FAILED'; }

export class InvoiceIssuanceError extends Error {
  constructor(errorCode) { super(`Invoice issuance failed (${errorCode}).`); this.name = 'InvoiceIssuanceError'; this.code = errorCode; }
}

function audit(database, now, actor, action, invoiceId, result, details, afterHash = null, context = {}) {
  database.prepare(`INSERT INTO audit_events
    (timestamp,actor,action,entity_type,entity_id,after_hash,source_channel,source_chat,source_message_reference,result,details_json)
    VALUES (?,?,?,'invoice',?,?,?,?,?,?,?)`).run(now, actor, action, invoiceId, afterHash, context.sourceChannel ?? null,
      context.sourceChat ?? null, context.sourceMessageReference ?? null, result, canonicalJson(details));
}

function reserve(database, args) {
  const row = database.prepare(`SELECT pc.*,i.status AS invoice_status,i.invoice_number,i.subtotal_minor,i.discount_minor,i.tax_minor,i.total_minor,
    s.current_version,s.draft_hash AS current_draft_hash,s.snapshot_json
    FROM pending_confirmations pc JOIN invoices i ON i.id=pc.draft_id JOIN invoice_draft_state s ON s.invoice_id=i.id
    WHERE pc.token=? AND pc.draft_type='invoice'`).get(args.token);
  if (!row) throw new Error('CONFIRMATION_TOKEN_NOT_FOUND');
  if (row.status !== 'PENDING') throw new Error('CONFIRMATION_TOKEN_NOT_PENDING');
  if (new Date(row.expires_at).valueOf() <= new Date(args.now).valueOf()) {
    database.prepare("UPDATE pending_confirmations SET status='EXPIRED' WHERE id=?").run(row.id);
    database.prepare("UPDATE invoices SET status='DRAFT' WHERE id=? AND status='PENDING_CONFIRMATION'").run(row.draft_id);
    return { rejectedCode: 'CONFIRMATION_TOKEN_EXPIRED' };
  }
  if (row.requesting_user !== args.confirmingUser) throw new Error('CONFIRMING_USER_MISMATCH');
  if (row.source_channel !== args.sourceChannel || row.source_chat !== args.sourceChat) throw new Error('CONFIRMATION_CONTEXT_MISMATCH');
  if (row.draft_hash !== row.current_draft_hash) throw new Error('CONFIRMATION_DRAFT_HASH_MISMATCH');
  if (row.invoice_status !== 'PENDING_CONFIRMATION' || row.invoice_number !== null) throw new Error('INVOICE_NOT_PENDING_CONFIRMATION');
  const snapshot = JSON.parse(row.snapshot_json);
  if (snapshot.validationIssues.length) throw new Error('INCOMPLETE_INVOICE_DRAFT');
  if (snapshot.lineItems.length < 1 || snapshot.lineItems.length > 7) throw new Error('LINE_ITEM_LIMIT_EXCEEDED');
  if (snapshot.taxMode !== 'NONE' || snapshot.totals.taxMinor !== 0) throw new Error('NON_ZERO_TAX_NOT_RENDERABLE');
  for (const [field, ledger] of [['subtotalMinor',row.subtotal_minor],['discountMinor',row.discount_minor],['taxMinor',row.tax_minor],['totalMinor',row.total_minor]]) {
    if (snapshot.totals[field] !== ledger) throw new Error('DRAFT_LEDGER_TOTAL_MISMATCH');
  }
  const allocation = allocateDocumentNumberInTransaction(database, { documentType: 'invoice', sequenceDate: snapshot.issueDate, clientInitials: args.clientInitials, now: args.now });
  updateDocumentNumberStatusInTransaction(database, { allocationId: allocation.id, status: 'GENERATING', entityId: row.draft_id, now: args.now });
  database.prepare("UPDATE pending_confirmations SET status='CONFIRMED',confirmed_at=? WHERE id=?").run(args.now,row.id);
  database.prepare("UPDATE invoices SET invoice_number=?,status='GENERATING',confirmed_by=?,confirmed_at=? WHERE id=?").run(allocation.documentNumber,args.confirmingUser,args.now,row.draft_id);
  database.prepare(`INSERT INTO invoice_issuances
    (invoice_id,document_number_id,confirmation_id,draft_version,draft_hash,status,attempt_count,created_at,updated_at)
    VALUES (?,?,?,?,?,'GENERATING',1,?,?)`).run(row.draft_id,allocation.id,row.id,row.current_version,row.current_draft_hash,args.now,args.now);
  audit(database,args.now,args.confirmingUser,'invoice.issuance_started',row.draft_id,'PASS',{documentNumber:allocation.documentNumber,draftVersion:row.current_version,attemptNumber:1},row.current_draft_hash,
    {sourceChannel:args.sourceChannel,sourceChat:args.sourceChat,sourceMessageReference:row.source_message_reference});
  return { invoiceId:row.draft_id, documentNumberId:allocation.id, documentNumber:allocation.documentNumber, snapshot, actor:args.confirmingUser, attemptNumber:1 };
}

function fail(databasePath, reservation, error, now) {
  const errorCode = code(error); const database = openDatabase(databasePath);
  try { withImmediateTransaction(database, () => {
    const current = database.prepare('SELECT status FROM invoice_issuances WHERE invoice_id=?').get(reservation.invoiceId);
    if (!current || current.status !== 'GENERATING') return;
    updateDocumentNumberStatusInTransaction(database,{allocationId:reservation.documentNumberId,status:'ISSUE_FAILED',entityId:reservation.invoiceId,now});
    database.prepare("UPDATE invoices SET status='ISSUE_FAILED' WHERE id=?").run(reservation.invoiceId);
    database.prepare("UPDATE invoice_issuances SET status='ISSUE_FAILED',last_error_code=?,updated_at=? WHERE invoice_id=?").run(errorCode,now,reservation.invoiceId);
    database.prepare(`INSERT INTO invoice_issuance_attempts (invoice_id,attempt_number,result,error_code,actor,occurred_at) VALUES (?,1,'FAILED',?,?,?)`).run(reservation.invoiceId,errorCode,reservation.actor,now);
    audit(database,now,reservation.actor,'invoice.issuance_failed',reservation.invoiceId,'FAIL',{documentNumber:reservation.documentNumber,errorCode,attemptNumber:1});
  }); } finally { database.close(); }
  return errorCode;
}

function succeed(databasePath, reservation, files, now) {
  const database = openDatabase(databasePath);
  try { return withImmediateTransaction(database, () => {
    const current = database.prepare('SELECT status FROM invoice_issuances WHERE invoice_id=?').get(reservation.invoiceId);
    if (!current || current.status !== 'GENERATING') throw new Error('ISSUANCE_STATE_CHANGED');
    updateDocumentNumberStatusInTransaction(database,{allocationId:reservation.documentNumberId,status:'ISSUED',entityId:reservation.invoiceId,now});
    database.prepare(`UPDATE invoice_issuances SET status='ISSUED',docx_relative_path=?,pdf_relative_path=?,docx_sha256=?,pdf_sha256=?,issued_by=?,issued_at=?,updated_at=? WHERE invoice_id=?`)
      .run(files.docxRelativePath,files.pdfRelativePath,files.docxSha256,files.pdfSha256,reservation.actor,now,now,reservation.invoiceId);
    database.prepare("UPDATE invoices SET status='ISSUED',issued_at=?,document_hash=? WHERE id=?").run(now,files.pdfSha256,reservation.invoiceId);
    const linkedRecharges = database.prepare(`SELECT r.id FROM claim_recharges r
      JOIN claim_invoice_links l ON l.claim_recharge_id=r.id
      WHERE l.invoice_id=? AND r.status='APPROVED' ORDER BY r.id`).all(reservation.invoiceId);
    for (const recharge of linkedRecharges) {
      database.prepare("UPDATE claim_recharges SET status='INVOICED' WHERE id=?").run(recharge.id);
      database.prepare(`INSERT INTO claim_recharge_events
        (claim_recharge_id,from_status,to_status,actor,details_json,occurred_at)
        VALUES (?,'APPROVED','INVOICED',?,?,?)`).run(
        recharge.id, reservation.actor, canonicalJson({ invoiceId: reservation.invoiceId, documentNumber: reservation.documentNumber }), now
      );
    }
    database.prepare(`INSERT INTO invoice_issuance_attempts (invoice_id,attempt_number,result,docx_sha256,pdf_sha256,actor,occurred_at) VALUES (?,1,'SUCCEEDED',?,?,?,?)`)
      .run(reservation.invoiceId,files.docxSha256,files.pdfSha256,reservation.actor,now);
    audit(database,now,reservation.actor,'invoice.issued',reservation.invoiceId,'PASS',{documentNumber:reservation.documentNumber,docxSha256:files.docxSha256,pdfSha256:files.pdfSha256,attemptNumber:1},files.pdfSha256);
    return database.prepare(`SELECT ii.*,i.invoice_number,i.status AS invoice_status,i.payment_status,i.balance_due_minor FROM invoice_issuances ii JOIN invoices i ON i.id=ii.invoice_id WHERE ii.invoice_id=?`).get(reservation.invoiceId);
  }); } finally { database.close(); }
}

export async function issueConfirmedInvoice({ databasePath,token,confirmingUser,sourceChannel,sourceChat,clientInitials,
  root=repositoryRoot,outputRoot=path.join(repositoryRoot,'generated','invoices'),testMode=false,documentRenderer=renderInvoiceDocx,pdfConverter,pdfInspector,now=new Date().toISOString() }) {
  instant(now); const args={token:text(token,'token'),confirmingUser:text(confirmingUser,'confirmingUser'),sourceChannel:text(sourceChannel,'sourceChannel'),sourceChat:text(sourceChat,'sourceChat'),clientInitials:text(clientInitials,'clientInitials'),now};
  const database=openDatabase(databasePath); let reservation;
  try { reservation=withImmediateTransaction(database,()=>reserve(database,args)); if(reservation.rejectedCode) throw new InvoiceIssuanceError(reservation.rejectedCode); }
  catch(error){ if(error instanceof InvoiceIssuanceError) throw error; throw new InvoiceIssuanceError(code(error)); } finally { database.close(); }
  try {
    const files=await renderConvertAndFile({root,outputRoot,snapshot:reservation.snapshot,documentNumber:reservation.documentNumber,testMode,documentRenderer,pdfConverter,pdfInspector});
    try { return succeed(databasePath,reservation,files,now); } catch(error) { await rm(files.docxPath,{force:true}); await rm(files.pdfPath,{force:true}); throw error; }
  } catch(error) { throw new InvoiceIssuanceError(fail(databasePath,reservation,error,now)); }
}
