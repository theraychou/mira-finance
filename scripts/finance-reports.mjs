#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDatabasePath } from './lib/database.mjs';
import { buildFinanceReport } from './lib/finance-reports.mjs';
import { exportFinanceReport } from './lib/report-exports.mjs';
import {
  approveClaimRecharge, assignClaimRecharge, confirmRechargeInvoiceInclusion,
  excludeClaimRecharge, getClaimRechargeRegister, requestRechargeInvoiceConfirmation
} from './lib/claim-recharges.mjs';
import {
  generateClaimSubmissionPack, getClaimSubmissionPackRegister, markClaimSubmissionPackSubmitted
} from './lib/claim-submission-packs.mjs';
import { repositoryRoot } from './validate-config.mjs';

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
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
  if (raw.length > 128 * 1024) throw new Error('Finance report input JSON is too large.');
  return JSON.parse(raw);
}

async function main() {
  if (!process.argv.includes('--admin')) throw new Error('DENIED --admin is required for F14 operations.');
  const action = valueAfter('--action');
  const actor = valueAfter('--actor');
  const databasePath = valueAfter('--database') ? workspacePath(valueAfter('--database'), 'data') : defaultDatabasePath;
  const input = await inputJson();
  if (action === 'report') {
    console.log(JSON.stringify(buildFinanceReport({ databasePath, reportType: input.report_type, filters: input.filters ?? {}, generatedAt: input.generated_at })));
    return;
  }
  if (action === 'export') {
    if (!actor) throw new Error('DENIED --actor is required.');
    const result = await exportFinanceReport({
      databasePath, reportType: input.report_type, filters: input.filters ?? {}, format: input.format,
      actor, generatedAt: input.generated_at, testMode: process.argv.includes('--test-mode')
    });
    console.log(JSON.stringify({ reportType: result.report.reportType, format: result.format, classification: result.classification, hash: result.hash, relativePath: result.relativePath, rowCount: result.report.rows.length }));
    return;
  }
  if (action === 'recharge-register') {
    console.log(JSON.stringify({ recharges: getClaimRechargeRegister({ databasePath, customerId: input.customer_id, status: input.status }) }));
    return;
  }
  if (action === 'claim-pack-register') {
    console.log(JSON.stringify({ packs: getClaimSubmissionPackRegister({ databasePath, customerId: input.customer_id }) }));
    return;
  }
  if (!actor) throw new Error('DENIED --actor is required.');
  if (action === 'recharge-assign') {
    console.log(JSON.stringify(assignClaimRecharge({
      databasePath, claimId: input.claim_id, customerId: input.customer_id, projectReference: input.project_reference,
      description: input.description, amountMinor: input.amount_minor, actor
    })));
    return;
  }
  if (action === 'recharge-approve') {
    console.log(JSON.stringify(approveClaimRecharge({
      databasePath, rechargeId: input.recharge_id, approvingUser: actor, authorisedUser: actor
    })));
    return;
  }
  if (action === 'recharge-exclude') {
    console.log(JSON.stringify(excludeClaimRecharge({
      databasePath, rechargeId: input.recharge_id, actor, reason: input.reason
    })));
    return;
  }
  if (action === 'recharge-request-inclusion') {
    console.log(JSON.stringify(requestRechargeInvoiceConfirmation({
      databasePath, invoiceId: input.invoice_id, rechargeIds: input.recharge_ids,
      requestingUser: actor, authorisedUser: actor, sourceChannel: input.source_channel ?? 'administrator',
      sourceChat: input.source_chat_fingerprint ?? 'administrator', sourceMessageReference: input.source_message_reference
    })));
    return;
  }
  if (action === 'recharge-confirm-inclusion') {
    console.log(JSON.stringify(confirmRechargeInvoiceInclusion({
      databasePath, token: input.token, confirmingUser: actor, authorisedUser: actor,
      sourceChannel: input.source_channel ?? 'administrator', sourceChat: input.source_chat_fingerprint ?? 'administrator'
    })));
    return;
  }
  if (action === 'claim-pack-generate') {
    console.log(JSON.stringify(await generateClaimSubmissionPack({
      databasePath, customerId: input.customer_id, month: input.month, actor,
      testMode: process.argv.includes('--test-mode')
    })));
    return;
  }
  if (action === 'claim-pack-mark-submitted') {
    console.log(JSON.stringify(markClaimSubmissionPackSubmitted({
      databasePath, packId: input.pack_id, submittingUser: actor, authorisedUser: actor,
      submissionReference: input.submission_reference
    })));
    return;
  }
  throw new Error('Unsupported --action.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL F14 operation (${error?.code ?? error?.message ?? 'F14_OPERATION_FAILED'})`);
    process.exitCode = 1;
  });
}
