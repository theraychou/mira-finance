import { createHash } from 'node:crypto';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { defaultDatabasePath } from '../../scripts/lib/database.mjs';
import { loadCustomerInboundConfig } from '../../scripts/lib/customer-inbound-config.mjs';
import { loadCustomerDeliveryConfig } from '../../scripts/lib/customer-delivery-config.mjs';
import {
  confirmEscalationReply, prepareEscalationReply, processInboundCustomerMessage, recordDeferredResponseBySession
} from '../../scripts/lib/customer-inbound.mjs';
import { createGogGmailClient } from '../../scripts/lib/gog-gmail-client.mjs';
import { createOpenClawWhatsAppClient } from '../../scripts/lib/openclaw-whatsapp-client.mjs';
import { loadWhatsAppRoutingConfiguration } from '../../scripts/lib/whatsapp-routing.mjs';

const fingerprint = (label, value) => createHash('sha256').update(`${label}:${value}`).digest('hex').slice(0, 24);
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const safeFailure = (error) => /^[A-Z][A-Z0-9_]{2,63}$/.test(error?.code ?? error?.message ?? '') ? (error.code ?? error.message) : 'CUSTOMER_REPLY_OPERATION_FAILED';

async function raySource(ctx) {
  const routing = await loadWhatsAppRoutingConfiguration();
  const channel = ctx.deliveryContext?.channel ?? ctx.messageChannel;
  const group = ctx.deliveryContext?.to;
  const sender = ctx.requesterSenderId;
  if (ctx.agentId !== 'mira-finance' || channel !== 'whatsapp' || group !== routing.group.id || sender !== routing.authorizedSenders[0].e164) {
    throw Object.assign(new Error('CUSTOMER_REPLY_SOURCE_NOT_AUTHORIZED'), { code: 'CUSTOMER_REPLY_SOURCE_NOT_AUTHORIZED' });
  }
  return { requestingUser: `whatsapp:${fingerprint('sender', sender)}`, sourceChannel: 'whatsapp', sourceChat: `group:${fingerprint('group', group)}` };
}

async function replyClients(inbound) {
  const delivery = await loadCustomerDeliveryConfig();
  return {
    signature: delivery.signature,
    emailClient: inbound.email.enabled ? createGogGmailClient({ ...inbound.email, replyTo: null }) : null,
    whatsAppClient: inbound.whatsApp.enabled ? createOpenClawWhatsAppClient({ account: inbound.whatsApp.account }) : null
  };
}

export default definePluginEntry({
  id: 'mira-finance-inbound',
  name: 'Mira Finance Customer Reply Processing',
  description: 'Deterministic inbound customer replies and RC Finance escalation.',
  register(api) {
    api.registerHook('before_dispatch', async (event, ctx) => {
      if (event.channel !== 'whatsapp' || event.isGroup || !event.senderId) return;
      try {
        const [configuration, delivery, routing] = await Promise.all([
          loadCustomerInboundConfig(), loadCustomerDeliveryConfig(), loadWhatsAppRoutingConfiguration()
        ]);
        const notifier = createOpenClawWhatsAppClient({ account: configuration.whatsApp.account });
        const receivedAt = new Date(typeof event.timestamp === 'number' ? event.timestamp : Date.now()).toISOString();
        const providerMessageId = `${ctx.sessionKey ?? ctx.conversationId ?? 'wa'}:${event.timestamp ?? receivedAt}:${createHash('sha256').update(event.content).digest('hex').slice(0, 16)}`;
        const handled = await processInboundCustomerMessage({ databasePath: defaultDatabasePath, configuration, channel: 'WHATSAPP',
          sender: event.senderId, providerMessageId, providerThreadId: ctx.conversationId ?? null, sessionKey: ctx.sessionKey ?? event.sessionKey ?? null,
          body: event.content, receivedAt, deferredSourceReply: true, signature: delivery.signature,
          escalationClient: { notify: ({ body }) => notifier.notify({ to: routing.group.id, body }) } });
        if (!handled.handled) return;
        return { handled: true, text: handled.responseText };
      } catch (error) {
        api.logger.warn(`Mira inbound WhatsApp handling failed (${safeFailure(error)}).`);
        return;
      }
    }, { name: 'mira-finance-inbound-before-dispatch', description: 'Claim verified customer WhatsApp replies before agent dispatch.' });

    api.registerHook('message_sent', async (event, ctx) => {
      if (ctx.channelId !== 'whatsapp' || !ctx.sessionKey || typeof event.content !== 'string') return;
      try {
        recordDeferredResponseBySession({ databasePath: defaultDatabasePath, channel: 'WHATSAPP', sessionKey: ctx.sessionKey,
          content: event.content, success: event.success, providerReference: event.messageId ?? null });
      } catch (error) { api.logger.warn(`Mira inbound delivery audit failed (${safeFailure(error)}).`); }
    }, { name: 'mira-finance-inbound-message-sent', description: 'Record source-reply delivery outcome without retaining provider identifiers.' });

    api.registerTool((ctx) => {
      const prepare = {
        name: 'mira_finance_prepare_customer_reply',
        description: 'Prepare Ray\'s exact answer to an open customer escalation. Never sends.',
        parameters: { type: 'object', additionalProperties: false, required: ['escalationToken', 'response'], properties: {
          escalationToken: { type: 'string', pattern: '^ES-[A-F0-9]{16}$' }, response: { type: 'string', minLength: 1, maxLength: 4000 }
        } },
        async execute(_id, params) {
          try {
            const [trusted, inbound, delivery] = await Promise.all([raySource(ctx), loadCustomerInboundConfig(), loadCustomerDeliveryConfig()]);
            if (!inbound.enabled) throw Object.assign(new Error('CUSTOMER_INBOUND_DISABLED'), { code: 'CUSTOMER_INBOUND_DISABLED' });
            return result(prepareEscalationReply({ databasePath: defaultDatabasePath, token: params.escalationToken, response: params.response,
              ...trusted, confirmationTtlMinutes: inbound.confirmationTtlMinutes, signature: delivery.signature }));
          } catch (error) { return result({ status: 'FAIL', code: safeFailure(error) }); }
        }
      };
      const confirm = {
        name: 'mira_finance_confirm_customer_reply',
        description: 'Send the exact unchanged response bound to a short-lived confirmation token.',
        parameters: { type: 'object', additionalProperties: false, required: ['confirmationToken'], properties: {
          confirmationToken: { type: 'string', pattern: '^RR-[A-F0-9]{16}$' }
        } },
        async execute(_id, params) {
          try {
            const [trusted, inbound] = await Promise.all([raySource(ctx), loadCustomerInboundConfig()]);
            if (!inbound.enabled) throw Object.assign(new Error('CUSTOMER_INBOUND_DISABLED'), { code: 'CUSTOMER_INBOUND_DISABLED' });
            const clients = await replyClients(inbound);
            return result(await confirmEscalationReply({ databasePath: defaultDatabasePath, confirmationToken: params.confirmationToken,
              confirmingUser: trusted.requestingUser, sourceChannel: trusted.sourceChannel, sourceChat: trusted.sourceChat,
              emailClient: clients.emailClient, whatsAppClient: clients.whatsAppClient }));
          } catch (error) { return result({ status: 'FAIL', code: safeFailure(error) }); }
        }
      };
      return [prepare, confirm];
    }, { names: ['mira_finance_prepare_customer_reply', 'mira_finance_confirm_customer_reply'], optional: true });
  }
});
