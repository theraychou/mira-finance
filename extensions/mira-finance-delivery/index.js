import { createHash } from 'node:crypto';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { defaultDatabasePath } from '../../scripts/lib/database.mjs';
import { loadCustomerDeliveryConfig } from '../../scripts/lib/customer-delivery-config.mjs';
import { confirmCustomerDelivery, prepareCustomerDelivery } from '../../scripts/lib/customer-delivery.mjs';
import { createGogGmailClient } from '../../scripts/lib/gog-gmail-client.mjs';
import { createOpenClawWhatsAppClient } from '../../scripts/lib/openclaw-whatsapp-client.mjs';
import { loadWhatsAppRoutingConfiguration } from '../../scripts/lib/whatsapp-routing.mjs';

function fingerprint(label, value) { return createHash('sha256').update(`${label}:${value}`).digest('hex').slice(0, 24); }

async function source(ctx) {
  const routing = await loadWhatsAppRoutingConfiguration();
  const channel = ctx.deliveryContext?.channel ?? ctx.messageChannel;
  const group = ctx.deliveryContext?.to;
  const sender = ctx.requesterSenderId;
  const authorised = routing.authorizedSenders[0];
  if (ctx.agentId !== 'mira-finance' || channel !== 'whatsapp' || group !== routing.group.id || sender !== authorised.e164) {
    throw Object.assign(new Error('DELIVERY_SOURCE_NOT_AUTHORIZED'), { code: 'DELIVERY_SOURCE_NOT_AUTHORIZED' });
  }
  return {
    actor: `whatsapp:${fingerprint('sender', sender)}`,
    sourceChannel: 'whatsapp',
    sourceChat: `group:${fingerprint('group', group)}`,
    sourceMessageReference: ctx.sessionId ? `session:${fingerprint('session', ctx.sessionId)}` : null
  };
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

function result(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; }
function safeFailure(error) {
  const value = typeof error?.code === 'string' ? error.code : error?.message;
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(value ?? '') ? value : 'CUSTOMER_DELIVERY_OPERATION_FAILED';
}

export default definePluginEntry({
  id: 'mira-finance-delivery',
  name: 'Mira Finance Customer Delivery',
  description: 'Confirmation-gated customer delivery of issued Mira finance PDFs.',
  register(api) {
    api.registerTool((ctx) => {
      const prepare = {
        name: 'mira_finance_prepare_delivery',
        description: 'Prepare a masked delivery preview for an issued quotation or invoice. Defaults to EMAIL; use WHATSAPP only when Ray explicitly requests it. Never sends.',
        parameters: {
          type: 'object', additionalProperties: false, required: ['documentType', 'documentNumber'],
          properties: {
            documentType: { type: 'string', enum: ['quotation', 'invoice'] },
            documentNumber: { type: 'string', minLength: 1, maxLength: 80 },
            channel: { type: 'string', enum: ['EMAIL', 'WHATSAPP'], default: 'EMAIL' },
            contactId: { type: 'integer', minimum: 1 },
            resendReason: { type: 'string', minLength: 1, maxLength: 500 }
          }
        },
        async execute(_id, params) {
          try {
            const [trusted, configuration] = await Promise.all([source(ctx), loadCustomerDeliveryConfig()]);
            return result(await prepareCustomerDelivery({ databasePath: defaultDatabasePath, configuration, ...trusted,
              documentType: params.documentType, documentNumber: params.documentNumber,
              channel: params.channel ?? configuration.defaultChannel, contactId: params.contactId ?? null, resendReason: params.resendReason ?? null }));
          } catch (error) { return result({ status: 'FAIL', code: safeFailure(error) }); }
        }
      };
      const confirm = {
        name: 'mira_finance_confirm_delivery',
        description: 'Consume an exact short-lived delivery token and send its unchanged hash-verified issued PDF. Use only after Ray explicitly confirms the displayed token.',
        parameters: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: { type: 'string', pattern: '^DL-[A-F0-9]{16}$' } } },
        async execute(_id, params) {
          try {
            const [trusted, configuration] = await Promise.all([source(ctx), loadCustomerDeliveryConfig()]);
            return result(await confirmCustomerDelivery({ databasePath: defaultDatabasePath, configuration, ...clients(configuration),
              token: params.token, confirmingUser: trusted.actor, sourceChannel: trusted.sourceChannel, sourceChat: trusted.sourceChat }));
          } catch (error) { return result({ status: 'FAIL', code: safeFailure(error) }); }
        }
      };
      return [prepare, confirm];
    }, { names: ['mira_finance_prepare_delivery', 'mira_finance_confirm_delivery'], optional: true });
  }
});
