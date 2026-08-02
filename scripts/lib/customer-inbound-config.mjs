import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateValueAgainstSchema } from './config-validation.mjs';
import { repositoryRoot } from '../validate-config.mjs';

export async function loadCustomerInboundConfig({ root = repositoryRoot, configPath = path.join(root, 'config', 'customer-inbound.json') } = {}) {
  let value;
  try { value = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { throw Object.assign(new Error('CUSTOMER_INBOUND_NOT_CONFIGURED'), { code: 'CUSTOMER_INBOUND_NOT_CONFIGURED', cause: error }); }
  const validation = await validateValueAgainstSchema(root, 'schemas/customer-inbound-config.schema.json', value);
  if (!validation.ok || value.$schema !== '../schemas/customer-inbound-config.schema.json'
      || (value.enabled && !value.email.enabled && !value.whatsApp.enabled)) {
    throw Object.assign(new Error('CUSTOMER_INBOUND_CONFIGURATION_INVALID'), { code: 'CUSTOMER_INBOUND_CONFIGURATION_INVALID' });
  }
  return value;
}
