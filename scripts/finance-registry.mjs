#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addCustomerAlias,
  createCustomer,
  deactivateCustomer,
  lookupCustomer,
  updateCustomer
} from './lib/customer-registry.mjs';
import {
  configureCurrency,
  createBankProfile,
  createBusinessEntity,
  createTaxRule,
  deactivateBankProfile,
  deactivateBusinessEntity,
  deactivateTaxRule,
  listRegistry,
  updateBankProfile,
  updateBusinessEntity,
  updateTaxRule
} from './lib/configuration-registry.mjs';
import { defaultDatabasePath } from './lib/database.mjs';
import { repositoryRoot } from './validate-config.mjs';

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireValue(flag) {
  const value = valueAfter(flag);
  if (!value) throw new Error(`${flag} is required.`);
  return value;
}

function integerValue(flag) {
  const value = Number(requireValue(flag));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer.`);
  return value;
}

async function readInput() {
  const input = path.resolve(requireValue('--input'));
  const [root, resolved] = await Promise.all([realpath(repositoryRoot), realpath(input)]);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Input file must be inside the Mira workspace.');
  return JSON.parse(await readFile(resolved, 'utf8'));
}

function assertAdministrator() {
  if (!process.argv.includes('--admin')) throw new Error('Mutation commands require explicit --admin mode.');
  return requireValue('--actor');
}

function summary(value) {
  console.log(JSON.stringify(value, null, 2));
}

export async function runRegistryCommand({ databasePath = defaultDatabasePath } = {}) {
  const [registry, action] = process.argv.slice(2).filter((item) => !item.startsWith('--'));
  if (!registry || !action) throw new Error('Registry and action are required.');

  if (registry === 'customer' && action === 'lookup') {
    return lookupCustomer({ databasePath, query: requireValue('--query') });
  }
  if (action === 'list') {
    const registryNames = {
      currency: 'currencies', currencies: 'currencies',
      entity: 'entities', entities: 'entities',
      bank: 'banks', banks: 'banks',
      tax: 'taxes', taxes: 'taxes'
    };
    return listRegistry({ databasePath, registry: registryNames[registry] ?? registry });
  }

  const actor = assertAdministrator();
  if (registry === 'customer' && action === 'create') {
    return createCustomer({ databasePath, customer: await readInput(), actor });
  }
  if (registry === 'customer' && action === 'update') {
    return updateCustomer({ databasePath, customerId: integerValue('--id'), changes: await readInput(), actor });
  }
  if (registry === 'customer' && action === 'deactivate') {
    return deactivateCustomer({ databasePath, customerId: integerValue('--id'), actor });
  }
  if (registry === 'customer' && action === 'alias') {
    return addCustomerAlias({
      databasePath,
      customerId: integerValue('--id'),
      alias: requireValue('--alias'),
      actor
    });
  }
  if (registry === 'entity' && action === 'create') {
    return createBusinessEntity({ databasePath, entity: await readInput(), actor });
  }
  if (registry === 'entity' && action === 'deactivate') {
    return deactivateBusinessEntity({ databasePath, entityId: integerValue('--id'), actor });
  }
  if (registry === 'entity' && action === 'update') {
    return updateBusinessEntity({ databasePath, entityId: integerValue('--id'), changes: await readInput(), actor });
  }
  if (registry === 'bank' && action === 'create') {
    return createBankProfile({ databasePath, profile: await readInput(), actor });
  }
  if (registry === 'bank' && action === 'deactivate') {
    return deactivateBankProfile({ databasePath, profileId: requireValue('--id'), actor });
  }
  if (registry === 'bank' && action === 'update') {
    return updateBankProfile({ databasePath, profileId: requireValue('--id'), changes: await readInput(), actor });
  }
  if (registry === 'tax' && action === 'create') {
    return createTaxRule({ databasePath, rule: await readInput(), actor });
  }
  if (registry === 'tax' && action === 'deactivate') {
    return deactivateTaxRule({ databasePath, ruleId: integerValue('--id'), actor });
  }
  if (registry === 'tax' && action === 'update') {
    return updateTaxRule({ databasePath, ruleId: integerValue('--id'), changes: await readInput(), actor });
  }
  if (registry === 'currency' && action === 'update') {
    return configureCurrency({ databasePath, code: requireValue('--currency'), changes: await readInput(), actor });
  }
  throw new Error('Unsupported registry command.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const databasePath = valueAfter('--database') ? path.resolve(valueAfter('--database')) : defaultDatabasePath;
    summary(await runRegistryCommand({ databasePath }));
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}
