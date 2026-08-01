import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateValueAgainstSchema } from './config-validation.mjs';
import { repositoryRoot } from '../validate-config.mjs';

export const defaultCustomerDeliveryConfigPath = path.join(repositoryRoot, 'config', 'customer-delivery.json');

export async function loadCustomerDeliveryConfig({
  root = repositoryRoot,
  configPath = path.join(root, 'config', 'customer-delivery.json')
} = {}) {
  let configuration;
  try {
    configuration = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    const failure = new Error('CUSTOMER_DELIVERY_NOT_CONFIGURED');
    failure.code = 'CUSTOMER_DELIVERY_NOT_CONFIGURED';
    failure.cause = error;
    throw failure;
  }
  const validation = await validateValueAgainstSchema(root, 'schemas/customer-delivery-config.schema.json', configuration);
  if (!validation.ok) {
    const failure = new Error('CUSTOMER_DELIVERY_CONFIGURATION_INVALID');
    failure.code = 'CUSTOMER_DELIVERY_CONFIGURATION_INVALID';
    throw failure;
  }
  if (configuration.$schema !== '../schemas/customer-delivery-config.schema.json') {
    const failure = new Error('CUSTOMER_DELIVERY_CONFIGURATION_INVALID');
    failure.code = 'CUSTOMER_DELIVERY_CONFIGURATION_INVALID';
    throw failure;
  }
  const email = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  if (!email.test(configuration.email.account) || !email.test(configuration.email.from)
      || (configuration.email.replyTo != null && !email.test(configuration.email.replyTo))
      || !Array.isArray(configuration.signature) || configuration.signature.length < 1 || configuration.signature.length > 8
      || configuration.signature.some((line) => typeof line !== 'string' || !line.trim() || line.length > 120)
      || (configuration.enabled && !configuration.email.enabled && !configuration.whatsApp.enabled)) {
    const failure = new Error('CUSTOMER_DELIVERY_CONFIGURATION_INVALID');
    failure.code = 'CUSTOMER_DELIVERY_CONFIGURATION_INVALID';
    throw failure;
  }
  return configuration;
}
