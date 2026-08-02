#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDatabasePath } from './lib/database.mjs';
import { loadCustomerInboundConfig } from './lib/customer-inbound-config.mjs';
import { loadCustomerDeliveryConfig } from './lib/customer-delivery-config.mjs';
import { processInboundCustomerMessage } from './lib/customer-inbound.mjs';
import { createGogGmailClient } from './lib/gog-gmail-client.mjs';
import { createGogGmailInboundClient } from './lib/gog-gmail-inbound-client.mjs';
import { createOpenClawWhatsAppClient } from './lib/openclaw-whatsapp-client.mjs';
import { loadWhatsAppRoutingConfiguration } from './lib/whatsapp-routing.mjs';

export async function pollInboundEmail({ databasePath = defaultDatabasePath } = {}) {
  const [configuration, delivery, routing] = await Promise.all([
    loadCustomerInboundConfig(), loadCustomerDeliveryConfig(), loadWhatsAppRoutingConfiguration()
  ]);
  if (!configuration.enabled || !configuration.email.enabled) return { status: 'DISABLED', processed: 0 };
  const reader = createGogGmailInboundClient(configuration.email);
  const responder = createGogGmailClient({ ...configuration.email, replyTo: null });
  const notifier = createOpenClawWhatsAppClient({ account: configuration.whatsApp.account });
  const incoming = await reader.search({ query: configuration.email.searchQuery, maximumResults: configuration.email.maximumResults });
  let processed = 0;
  for (const message of incoming) {
    const result = await processInboundCustomerMessage({ databasePath, configuration, channel: 'EMAIL', sender: message.from,
      providerMessageId: message.id, providerThreadId: message.threadId, subject: message.subject, body: message.body,
      receivedAt: message.receivedAt, hasAttachments: message.hasAttachments, responseClient: responder,
      escalationClient: { notify: ({ body }) => notifier.notify({ to: routing.group.id, body }) }, signature: delivery.signature });
    if (result.handled && !result.duplicate) processed += 1;
  }
  return { status: 'PASS', processed };
}
async function main() {
  if (process.argv.slice(2).length) throw new Error('CUSTOMER_INBOUND_ARGUMENTS_DENIED');
  const result = await pollInboundEmail();
  console.log(`PASS customer inbound email poll; status ${result.status}; processed ${result.processed}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`FAIL customer inbound email poll (${error?.code ?? error?.message ?? 'INBOUND_FAILED'})`); process.exitCode = 1; });
}
