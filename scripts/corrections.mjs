#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDatabasePath } from './lib/database.mjs';
import {
  confirmDocumentCancellation, createCreditNoteDraft, createReplacementInvoiceDraft,
  createReplacementQuotationDraft, issueConfirmedCreditNote, requestCreditNoteConfirmation,
  requestDocumentCancellation
} from './lib/corrections.mjs';
import { fileCorrectionToDrive } from './lib/correction-drive.mjs';
import { repositoryRoot } from './validate-config.mjs';

function value(flag) { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : undefined; }
function workspacePath(relative, allowedRoot) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Only workspace-relative paths are accepted.');
  const root = path.resolve(repositoryRoot, allowedRoot);
  const candidate = path.resolve(repositoryRoot, relative);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('Path is outside the approved workspace area.');
  return candidate;
}
async function input() {
  const relative = value('--input');
  if (!relative) return {};
  const raw = await readFile(workspacePath(relative, path.join('data', 'pending')), 'utf8');
  if (raw.length > 128 * 1024) throw new Error('Correction input is too large.');
  return JSON.parse(raw);
}

async function main() {
  if (!process.argv.includes('--admin')) throw new Error('DENIED --admin is required for F15 corrections.');
  const action = value('--action');
  const actor = value('--actor');
  if (!actor) throw new Error('DENIED --actor is required.');
  const databasePath = value('--database') ? workspacePath(value('--database'), 'data') : defaultDatabasePath;
  const data = await input();
  const common = { databasePath, now: data.now };
  let result;
  if (action === 'credit-draft') {
    result = createCreditNoteDraft({ ...common, originalInvoiceId: data.original_invoice_id, issueDate: data.issue_date, reason: data.reason, lines: data.lines, actor });
  } else if (action === 'credit-request') {
    result = requestCreditNoteConfirmation({ ...common, creditNoteId: data.credit_note_id, requestingUser: actor, authorisedUser: actor, sourceChannel: data.source_channel ?? 'administrator', sourceChat: data.source_chat_fingerprint ?? 'administrator', sourceMessageReference: data.source_message_reference });
  } else if (action === 'credit-issue') {
    result = await issueConfirmedCreditNote({ ...common, token: data.token, confirmingUser: actor, sourceChannel: data.source_channel ?? 'administrator', sourceChat: data.source_chat_fingerprint ?? 'administrator', clientInitials: data.client_initials, testMode: process.argv.includes('--test-mode') });
  } else if (action === 'cancel-request') {
    result = requestDocumentCancellation({ ...common, documentType: data.document_type, entityId: data.entity_id, reason: data.reason, requestingUser: actor, authorisedUser: actor, sourceChannel: data.source_channel ?? 'administrator', sourceChat: data.source_chat_fingerprint ?? 'administrator', sourceMessageReference: data.source_message_reference });
  } else if (action === 'cancel-confirm') {
    result = confirmDocumentCancellation({ ...common, token: data.token, confirmingUser: actor, authorisedUser: actor, sourceChannel: data.source_channel ?? 'administrator', sourceChat: data.source_chat_fingerprint ?? 'administrator' });
  } else if (action === 'replacement-invoice') {
    result = createReplacementInvoiceDraft({ ...common, originalInvoiceId: data.original_invoice_id, issueDate: data.issue_date, paymentTermsDays: data.payment_terms_days, reason: data.reason, actor });
  } else if (action === 'replacement-quotation') {
    result = createReplacementQuotationDraft({ ...common, originalQuotationId: data.original_quotation_id, issueDate: data.issue_date, validityDays: data.validity_days, reason: data.reason, actor });
  } else if (action === 'drive-file') {
    result = await fileCorrectionToDrive({ ...common, correctionType: data.correction_type, entityId: data.entity_id, actor, testMode: process.argv.includes('--test-mode') });
  } else {
    throw new Error('Unsupported --action.');
  }
  console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL F15 correction (${error?.code ?? error?.message ?? 'CORRECTION_FAILED'})`);
    process.exitCode = 1;
  });
}
