#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDatabasePath } from './lib/database.mjs';
import { loadCustomerDeliveryConfig } from './lib/customer-delivery-config.mjs';
import {
  confirmCustomerDelivery,
  createDeliveryContact,
  deactivateDeliveryContact,
  listDeliveryContacts,
  prepareCustomerDelivery
} from './lib/customer-delivery.mjs';
import { createGogGmailClient } from './lib/gog-gmail-client.mjs';
import { createOpenClawWhatsAppClient } from './lib/openclaw-whatsapp-client.mjs';
import { repositoryRoot } from './validate-config.mjs';

function valueAfter(flag) { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : undefined; }
function requireValue(flag) { const value = valueAfter(flag); if (!value) throw new Error(`${flag} is required.`); return value; }
function positive(flag) { const value = Number(requireValue(flag)); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer.`); return value; }
function administrator() { if (!process.argv.includes('--admin')) throw new Error('Delivery mutations require explicit --admin mode.'); return requireValue('--actor'); }

async function input() {
  const candidate = path.resolve(requireValue('--input'));
  const [root, resolved] = await Promise.all([realpath(repositoryRoot), realpath(candidate)]);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Input file must be inside the Mira workspace.');
  return JSON.parse(await readFile(resolved, 'utf8'));
}

function clients(configuration) {
  return {
    emailClient: configuration.email.enabled ? createGogGmailClient({
      account: configuration.email.account, client: configuration.email.client,
      from: configuration.email.from, replyTo: configuration.email.replyTo
    }) : null,
    whatsAppClient: configuration.whatsApp.enabled ? createOpenClawWhatsAppClient({ account: configuration.whatsApp.account }) : null
  };
}

export async function runCustomerDelivery({ databasePath = defaultDatabasePath } = {}) {
  const [resource, action] = process.argv.slice(2).filter((item) => !item.startsWith('--'));
  if (!resource || !action) throw new Error('Resource and action are required.');
  if (resource === 'contact' && action === 'list') return listDeliveryContacts({ databasePath, customerId: positive('--customer-id'), channel: valueAfter('--channel') });
  const actor = administrator();
  if (resource === 'contact' && action === 'create') return createDeliveryContact({ databasePath, contact: await input(), actor });
  if (resource === 'contact' && action === 'deactivate') return deactivateDeliveryContact({ databasePath, contactId: positive('--id'), actor });
  const configuration = await loadCustomerDeliveryConfig();
  if (resource === 'delivery' && action === 'prepare') return prepareCustomerDelivery({
    databasePath, configuration, documentType: requireValue('--document-type'), documentNumber: requireValue('--document-number'),
    channel: valueAfter('--channel') ?? configuration.defaultChannel, contactId: valueAfter('--contact-id') ? positive('--contact-id') : null,
    requestingUser: actor, sourceChannel: 'administrator', sourceChat: 'administrator', resendReason: valueAfter('--resend-reason')
  });
  if (resource === 'delivery' && action === 'confirm') return confirmCustomerDelivery({
    databasePath, configuration, ...clients(configuration), token: requireValue('--token'), confirmingUser: actor,
    sourceChannel: 'administrator', sourceChat: 'administrator'
  });
  throw new Error('Unsupported customer-delivery operation.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCustomerDelivery().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    const code = typeof error?.code === 'string' ? error.code : (/^[A-Z][A-Z0-9_]{2,63}$/.test(error?.message ?? '') ? error.message : 'CUSTOMER_DELIVERY_OPERATION_FAILED');
    console.error(`FAIL customer delivery operation (${code})`); process.exitCode = 1;
  });
}
