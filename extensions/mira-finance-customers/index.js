import { createHash } from 'node:crypto';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { defaultDatabasePath, openDatabase } from '../../scripts/lib/database.mjs';
import { loadCustomerSheetMirrorConfiguration } from '../../scripts/lib/customer-sheet-mirror-config.mjs';
import { syncCustomerSheetMirror } from '../../scripts/lib/customer-sheet-mirror.mjs';
import { createGogSheetsClient } from '../../scripts/lib/gog-sheets-client.mjs';
import { loadDriveConfiguration } from '../../scripts/lib/drive-configuration.mjs';
import { createGogDriveClient } from '../../scripts/lib/gog-drive-client.mjs';
import { ensureCustomerDriveFolder } from '../../scripts/lib/customer-drive-folders.mjs';
import {
  confirmWhatsAppCustomerChange, listWhatsAppCustomers, prepareWhatsAppCustomerChange
} from '../../scripts/lib/whatsapp-customers.mjs';
import { loadWhatsAppRoutingConfiguration } from '../../scripts/lib/whatsapp-routing.mjs';

const fingerprint = (label, value) => createHash('sha256').update(`${label}:${value}`).digest('hex').slice(0, 24);
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const safeFailure = (error) => /^[A-Z][A-Z0-9_]{2,95}$/.test(error?.code ?? error?.message ?? '')
  ? (error.code ?? error.message) : 'CUSTOMER_OPERATION_FAILED';

function raySource(ctx, executionId) {
  return loadWhatsAppRoutingConfiguration().then((routing) => {
    const channel = ctx.deliveryContext?.channel ?? ctx.messageChannel;
    const group = ctx.deliveryContext?.to;
    const sender = ctx.requesterSenderId;
    if (ctx.agentId !== 'mira-finance' || channel !== 'whatsapp' || group !== routing.group.id || sender !== routing.authorizedSenders[0].e164) {
      throw Object.assign(new Error('CUSTOMER_SOURCE_NOT_AUTHORIZED'), { code: 'CUSTOMER_SOURCE_NOT_AUTHORIZED' });
    }
    const requestKey = [ctx.sessionId ?? 'no-session', executionId].join(':');
    return {
      requestingUser: `whatsapp:${fingerprint('sender', sender)}`,
      sourceChannel: 'whatsapp',
      sourceChat: `group:${fingerprint('group', group)}`,
      sourceMessageReference: `tool:${fingerprint('customer', requestKey)}`
    };
  });
}

async function mirrorAfterChange(actor) {
  try {
    const configuration = await loadCustomerSheetMirrorConfiguration();
    if (!configuration.enabled) return { status: 'NOT_CONFIGURED' };
    const client = createGogSheetsClient({ identity: configuration.identity, client: configuration.client });
    return await syncCustomerSheetMirror({ databasePath: defaultDatabasePath, configuration, client, actor });
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'NOT_CONFIGURED' };
    return { status: 'FAILED', errorCode: 'CUSTOMER_SHEET_SYNC_FAILED' };
  }
}

async function folderAfterChange(customerCode,actor){
  try{const database=openDatabase(defaultDatabasePath,{readOnly:true});let customerId;try{customerId=database.prepare('SELECT id FROM customers WHERE customer_code=?').get(customerCode)?.id;}finally{database.close();}
    const configuration=await loadDriveConfiguration();const client=createGogDriveClient(configuration);
    const folder=await ensureCustomerDriveFolder({databasePath:defaultDatabasePath,customerId,rootFolderId:configuration.rootFolderId,driveClient:client,actor});
    return {status:'READY',created:folder.created};
  }catch{return {status:'FAILED',errorCode:'CUSTOMER_DRIVE_FOLDER_FAILED'};}
}

const nullableString = (maximum) => ({ anyOf: [{ type: 'string', minLength: 1, maxLength: maximum }, { type: 'null' }] });

export default definePluginEntry({
  id: 'mira-finance-customers',
  name: 'Mira Finance Customer Administration',
  description: 'Ray-only customer listing and confirmation-gated registry changes in RC Finance.',
  register(api) {
    api.registerTool((ctx) => {
      const list = {
        name: 'mira_finance_list_customers',
        description: 'List or search customer summaries from the private registry. Use only for Ray in RC Finance. Does not expose addresses, contact details, tax numbers, or notes.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'ALL'], default: 'ACTIVE' },
            query: { type: 'string', minLength: 1, maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 }
          }
        },
        execute(id, params) {
          return raySource(ctx, id).then(() => result(listWhatsAppCustomers({ databasePath: defaultDatabasePath,
            status: params.status ?? 'ACTIVE', query: params.query ?? null, limit: params.limit ?? 50 })))
            .catch((error) => result({ status: 'FAIL', code: safeFailure(error) }));
        }
      };
      const prepare = {
        name: 'mira_finance_prepare_customer_change',
        description: 'Prepare a customer creation, modification, or deactivation preview and one-use confirmation token. “Remove” always means DEACTIVATE. Never changes the registry by itself.',
        parameters: {
          type: 'object', additionalProperties: false, required: ['operation', 'customerCode'],
          properties: {
            operation: { type: 'string', enum: ['CREATE', 'UPDATE', 'DEACTIVATE'] },
            customerCode: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9-]{1,19}$' },
            fields: {
              type: 'object', additionalProperties: false,
              properties: {
                legalName: { type: 'string', minLength: 1, maxLength: 300 }, displayName: { type: 'string', minLength: 1, maxLength: 300 }, registrationNumber: nullableString(200),
                taxRegistrationNumber: nullableString(200), billingAddress: { type: 'string', minLength: 1, maxLength: 2000 },
                billingContactName: nullableString(300), billingEmail: nullableString(320), billingPhone: nullableString(80),
                defaultCurrency: { type: 'string', enum: ['MYR', 'SGD', 'USD'] },
                defaultPaymentTermsDays: { type: 'integer', minimum: 0, maximum: 3650 },
                taxTreatment: { type: 'string', minLength: 1, maxLength: 500 }, purchaseOrderRequired: { type: 'boolean' },
                notes: nullableString(2000)
              }
            }
          }
        },
        execute(id, params) {
          return raySource(ctx, id).then((trusted) => result(prepareWhatsAppCustomerChange({
            databasePath: defaultDatabasePath, input: params, ...trusted
          }))).catch((error) => result({ status: 'FAIL', code: safeFailure(error) }));
        }
      };
      const confirm = {
        name: 'mira_finance_confirm_customer_change',
        description: 'Consume an exact customer-change token, apply the bound registry mutation, and refresh the one-way Google Sheets mirror. Use only after Ray confirms the displayed token.',
        parameters: { type: 'object', additionalProperties: false, required: ['token'], properties: {
          token: { type: 'string', pattern: '^CU-[A-Z2-9]{10}$' }
        } },
        execute(id, params) {
          return raySource(ctx, id).then(async (trusted) => {
            const changed = confirmWhatsAppCustomerChange({ databasePath: defaultDatabasePath, token: params.token,
              confirmingUser: trusted.requestingUser, sourceChannel: trusted.sourceChannel, sourceChat: trusted.sourceChat });
            if (changed.rejectedCode) throw Object.assign(new Error(changed.rejectedCode), { code: changed.rejectedCode });
            return result({ ...changed, driveFolder: await folderAfterChange(changed.customer.customerCode,trusted.requestingUser), mirror: await mirrorAfterChange(trusted.requestingUser) });
          }).catch((error) => result({ status: 'FAIL', code: safeFailure(error) }));
        }
      };
      return [list, prepare, confirm];
    }, { names: ['mira_finance_list_customers', 'mira_finance_prepare_customer_change', 'mira_finance_confirm_customer_change'], optional: true });
  }
});
