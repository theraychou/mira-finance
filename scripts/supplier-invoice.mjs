#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDatabasePath } from './lib/database.mjs';
import {
  addSupplierAlias, createSupplier, deactivateSupplier, listSuppliers, updateSupplier
} from './lib/supplier-registry.mjs';
import {
  approveAndFileSupplierInvoice, createSupplierInvoiceDraft, getSupplierInvoiceRegister,
  requestSupplierInvoiceApproval, reviseSupplierInvoiceDraft
} from './lib/supplier-invoice-workflow.mjs';
import { repositoryRoot } from './validate-config.mjs';

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function positiveId(value, name = 'ID') {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${name} must be a positive integer.`);
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
  if (raw.length > 64 * 1024) throw new Error('Supplier invoice input JSON is too large.');
  return JSON.parse(raw);
}

async function main() {
  if (!process.argv.includes('--admin')) throw new Error('DENIED --admin is required for supplier invoice operations.');
  const action = valueAfter('--action');
  const actor = valueAfter('--actor');
  const databasePath = valueAfter('--database') ? workspacePath(valueAfter('--database'), 'data') : defaultDatabasePath;
  if (action === 'register') {
    console.log(JSON.stringify({ supplierInvoices: getSupplierInvoiceRegister({ databasePath, includeDrafts: process.argv.includes('--include-drafts') }) }));
    return;
  }
  if (action === 'supplier-list') {
    console.log(JSON.stringify({ suppliers: listSuppliers({ databasePath, includeInactive: process.argv.includes('--include-inactive') }) }));
    return;
  }
  if (!actor) throw new Error('DENIED --actor is required.');
  const input = await inputJson();
  if (action === 'supplier-create') {
    console.log(JSON.stringify(createSupplier({ databasePath, supplier: input.supplier ?? {}, aliases: input.aliases ?? [], actor })));
    return;
  }
  if (action === 'supplier-update') {
    console.log(JSON.stringify(updateSupplier({ databasePath, supplierId: positiveId(input.supplier_id, 'Supplier ID'), changes: input.changes ?? {}, actor })));
    return;
  }
  if (action === 'supplier-alias') {
    console.log(JSON.stringify(addSupplierAlias({ databasePath, supplierId: positiveId(input.supplier_id, 'Supplier ID'), alias: input.alias, actor })));
    return;
  }
  if (action === 'supplier-deactivate') {
    console.log(JSON.stringify(deactivateSupplier({ databasePath, supplierId: positiveId(input.supplier_id, 'Supplier ID'), actor })));
    return;
  }
  if (action === 'intake') {
    const result = await createSupplierInvoiceDraft({
      databasePath,
      sourcePath: workspacePath(input.source_relative_path, path.join('data', 'supplier-invoices', 'inbox')),
      declaredMimeType: input.declared_mime_type ?? null,
      declaredClassification: input.classification,
      actor,
      sourceChannel: input.source_channel ?? 'administrator',
      sourceMessageReference: input.source_message_reference ?? null,
      advisoryText: input.advisory_text ?? null,
      advisoryFields: input.fields ?? {}
    });
    console.log(JSON.stringify(result.status === 'EXACT_DUPLICATE'
      ? result
      : { id: result.id, status: result.status, version: result.version, validationIssues: result.snapshot.validationIssues, probableDuplicate: Boolean(result.snapshot.probableDuplicate) }));
    return;
  }
  if (action === 'revise') {
    const result = await reviseSupplierInvoiceDraft({
      databasePath, supplierInvoiceId: positiveId(input.supplier_invoice_id, 'Supplier invoice ID'),
      fields: input.fields ?? {}, actor
    });
    console.log(JSON.stringify({ id: result.id, status: result.status, version: result.version, validationIssues: result.snapshot.validationIssues, probableDuplicate: Boolean(result.snapshot.probableDuplicate) }));
    return;
  }
  if (action === 'request-approval') {
    console.log(JSON.stringify(requestSupplierInvoiceApproval({
      databasePath, supplierInvoiceId: positiveId(input.supplier_invoice_id, 'Supplier invoice ID'),
      requestingUser: actor, authorisedUser: actor, sourceChannel: input.source_channel ?? 'administrator',
      sourceChat: input.source_chat_fingerprint ?? 'administrator', sourceMessageReference: input.source_message_reference ?? null
    })));
    return;
  }
  if (action === 'approve') {
    console.log(JSON.stringify(await approveAndFileSupplierInvoice({
      databasePath, token: input.token, approvingUser: actor, authorisedUser: actor
    })));
    return;
  }
  throw new Error('Unsupported --action.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL supplier invoice operation (${error?.code ?? error?.message ?? 'SUPPLIER_INVOICE_OPERATION_FAILED'})`);
    process.exitCode = 1;
  });
}
