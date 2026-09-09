import { createHash } from 'node:crypto';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { defaultDatabasePath } from '../../scripts/lib/database.mjs';
import { confirmWhatsAppInvoice, prepareWhatsAppInvoice } from '../../scripts/lib/whatsapp-invoices.mjs';
import { loadWhatsAppRoutingConfiguration } from '../../scripts/lib/whatsapp-routing.mjs';

const fingerprint = (label, value) => createHash('sha256').update(`${label}:${value}`).digest('hex').slice(0, 24);
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const safeFailure = (error) => /^[A-Z][A-Z0-9_]{2,95}$/.test(error?.code ?? error?.message ?? '')
  ? (error.code ?? error.message) : 'INVOICE_OPERATION_FAILED';

async function raySource(ctx, executionId) {
  const routing = await loadWhatsAppRoutingConfiguration();
  const channel = ctx.deliveryContext?.channel ?? ctx.messageChannel;
  const group = ctx.deliveryContext?.to;
  const sender = ctx.requesterSenderId;
  if (ctx.agentId !== 'mira-finance' || channel !== 'whatsapp' || group !== routing.group.id || sender !== routing.authorizedSenders[0].e164) {
    throw Object.assign(new Error('INVOICE_SOURCE_NOT_AUTHORIZED'), { code: 'INVOICE_SOURCE_NOT_AUTHORIZED' });
  }
  const session = ctx.sessionId ?? 'no-session';
  return {
    requestingUser: `whatsapp:${fingerprint('sender', sender)}`,
    sourceChannel: 'whatsapp',
    sourceChat: `group:${fingerprint('group', group)}`,
    sourceMessageReference: `tool:${fingerprint('invoice', `${session}:${executionId}`)}`
  };
}

export default definePluginEntry({
  id: 'mira-finance-invoice',
  name: 'Mira Finance Invoice Workflow',
  description: 'Confirmation-gated standalone invoice drafting and issuance from RC Finance.',
  register(api) {
    api.registerTool((ctx) => {
      const prepare = {
        name: 'mira_finance_prepare_invoice',
        description: 'Prepare a standalone invoice preview and one-use confirmation token. Use only after Ray provides an exact customer, service date, payment terms, explicit no-tax treatment, and 1-7 line items. Unit prices are decimal strings in major currency units. Never issues or sends.',
        parameters: {
          type: 'object', additionalProperties: false,
          required: ['customer', 'issueDate', 'serviceDate', 'paymentTermsDays', 'taxMode', 'lineItems'],
          properties: {
            customer: { type: 'string', minLength: 1, maxLength: 200 },
            currency: { type: 'string', enum: ['MYR', 'SGD', 'USD'] },
            issueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            serviceDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            paymentTermsDays: { type: 'integer', minimum: 0, maximum: 3650 },
            purchaseOrderNumber: { type: 'string', minLength: 1, maxLength: 120 },
            notes: { type: 'string', minLength: 1, maxLength: 1000 },
            clientInitials: { type: 'string', pattern: '^[A-Z0-9]{1,8}$' },
            taxMode: { type: 'string', const: 'NONE' },
            lineItems: {
              type: 'array', minItems: 1, maxItems: 7,
              items: {
                type: 'object', additionalProperties: false,
                required: ['description', 'quantity', 'unitPrice'],
                properties: {
                  description: { type: 'string', minLength: 1, maxLength: 500 },
                  quantity: { type: 'string', pattern: '^(?:0|[1-9]\\d*)(?:\\.\\d{1,6})?$' },
                  unit: { type: 'string', minLength: 1, maxLength: 80 },
                  unitPrice: { type: 'string', pattern: '^(?:0|[1-9]\\d{0,2}(?:,?\\d{3})*)(?:\\.\\d{1,4})?$' }
                }
              }
            }
          }
        },
        async execute(id, params) {
          try {
            const trusted = await raySource(ctx, id);
            return result(prepareWhatsAppInvoice({ databasePath: defaultDatabasePath, input: params, ...trusted }));
          } catch (error) { return result({ status: 'FAIL', code: safeFailure(error) }); }
        }
      };
      const confirm = {
        name: 'mira_finance_confirm_invoice',
        description: 'Consume an exact invoice confirmation token and issue the bound immutable DOCX/PDF. Use only after Ray confirms the displayed token. Does not send the document to a customer.',
        parameters: {
          type: 'object', additionalProperties: false, required: ['token'],
          properties: { token: { type: 'string', pattern: '^ID-[A-Z2-9]{10}$' } }
        },
        async execute(id, params) {
          try {
            const trusted = await raySource(ctx, id);
            return result(await confirmWhatsAppInvoice({ databasePath: defaultDatabasePath, token: params.token,
              confirmingUser: trusted.requestingUser, sourceChannel: trusted.sourceChannel, sourceChat: trusted.sourceChat }));
          } catch (error) { return result({ status: 'FAIL', code: safeFailure(error) }); }
        }
      };
      return [prepare, confirm];
    }, { names: ['mira_finance_prepare_invoice', 'mira_finance_confirm_invoice'], optional: true });
  }
});
