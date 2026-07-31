#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  confirmAndFileClaim, createClaimConfirmationToken, createClaimDraftFromReceipt,
  getClaimRegister, reviseClaimDraft
} from './lib/claim-workflow.mjs';
import { defaultDatabasePath } from './lib/database.mjs';
import { repositoryRoot } from './validate-config.mjs';

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function positiveId(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError('Claim ID must be a positive integer.');
  return parsed;
}
function workspacePath(relative, allowedRoot) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Only workspace-relative paths are accepted.');
  const root = path.resolve(repositoryRoot, allowedRoot);
  const candidate = path.resolve(repositoryRoot, relative);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('Input path is outside the approved workspace area.');
  return candidate;
}
async function inputJson() {
  const relative = valueAfter('--input');
  if (!relative) return {};
  const file = workspacePath(relative, path.join('data', 'pending'));
  const raw = await readFile(file, 'utf8');
  if (raw.length > 64 * 1024) throw new Error('Claim input JSON is too large.');
  return JSON.parse(raw);
}

async function main() {
  if (!process.argv.includes('--admin')) throw new Error('DENIED --admin is required for claim operations.');
  const action = valueAfter('--action');
  const actor = valueAfter('--actor');
  const databasePath = valueAfter('--database') ? workspacePath(valueAfter('--database'), 'data') : defaultDatabasePath;
  if (action === 'register') {
    const rows = getClaimRegister({ databasePath, includeDrafts: process.argv.includes('--include-drafts') });
    console.log(JSON.stringify({ count: rows.length, claims: rows }));
    return;
  }
  if (!actor) throw new Error('DENIED --actor is required.');
  const input = await inputJson();
  if (action === 'intake') {
    const sourcePath = workspacePath(input.source_relative_path, path.join('data', 'claims', 'inbox'));
    const draft = await createClaimDraftFromReceipt({
      databasePath, sourcePath, declaredMimeType: input.declared_mime_type ?? null, actor,
      sourceChannel: input.source_channel ?? 'administrator', sourceMessageReference: input.source_message_reference ?? null,
      advisoryText: input.advisory_text ?? null, advisoryFields: input.fields ?? {}
    });
    console.log(JSON.stringify(draft.status === 'EXACT_DUPLICATE'
      ? draft
      : { id: draft.id, status: draft.status, version: draft.version, validationIssues: draft.snapshot.validationIssues, probableDuplicate: Boolean(draft.snapshot.probableDuplicate) }));
    return;
  }
  if (action === 'revise') {
    const draft = await reviseClaimDraft({ databasePath, claimId: positiveId(input.claim_id), fields: input.fields ?? {}, actor });
    console.log(JSON.stringify({ id: draft.id, status: draft.status, version: draft.version, validationIssues: draft.snapshot.validationIssues, probableDuplicate: Boolean(draft.snapshot.probableDuplicate) }));
    return;
  }
  if (action === 'request-confirmation') {
    const result = createClaimConfirmationToken({
      databasePath, claimId: positiveId(input.claim_id), requestingUser: actor, authorisedUser: actor,
      sourceChannel: input.source_channel ?? 'administrator', sourceChat: input.source_chat_fingerprint ?? 'administrator',
      sourceMessageReference: input.source_message_reference ?? null
    });
    console.log(JSON.stringify(result));
    return;
  }
  if (action === 'confirm') {
    const result = await confirmAndFileClaim({ databasePath, token: input.token, confirmingUser: actor, authorisedUser: actor });
    console.log(JSON.stringify(result));
    return;
  }
  throw new Error('Unsupported --action. Use intake, revise, request-confirmation, confirm, or register.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL claim operation (${error?.code ?? error?.message ?? 'CLAIM_OPERATION_FAILED'})`);
    process.exitCode = 1;
  });
}

