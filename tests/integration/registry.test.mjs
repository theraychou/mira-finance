import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addCustomerAlias,
  assessCustomerReadiness,
  createCustomer,
  deactivateCustomer,
  lookupCustomer,
  updateCustomer
} from '../../scripts/lib/customer-registry.mjs';
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
} from '../../scripts/lib/configuration-registry.mjs';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { migrateUp } from '../../scripts/lib/migrations.mjs';

async function temporaryRegistry() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-f4-'));
  const databasePath = path.join(directory, 'finance.sqlite3');
  await migrateUp({ databasePath, now: () => '2026-07-29T00:00:00.000Z' });
  return { directory, databasePath };
}

function runCli(argumentsList) {
  return new Promise((resolve, reject) => {
    const scriptPath = fileURLToPath(new URL('../../scripts/finance-registry.mjs', import.meta.url));
    const child = spawn(process.execPath, [scriptPath, ...argumentsList], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('customer lookup prioritises code and aliases while ambiguous/fuzzy names require selection', async () => {
  const { directory, databasePath } = await temporaryRegistry();
  try {
    const first = createCustomer({
      databasePath,
      actor: 'test-admin',
      now: '2026-07-29T01:00:00.000Z',
      customer: {
        customer_code: 'ALPHA',
        legal_name: 'Alpha Example Industries Sdn. Bhd.',
        display_name: 'Shared Trading Name',
        billing_address: '1 Synthetic Street',
        default_currency: 'MYR'
      }
    });
    addCustomerAlias({ databasePath, customerId: first.id, alias: 'Alpha Co', actor: 'test-admin' });
    createCustomer({
      databasePath,
      actor: 'test-admin',
      customer: {
        customer_code: 'BETA',
        legal_name: 'Beta Example Pte. Ltd.',
        display_name: 'Shared Trading Name',
        billing_address: '2 Synthetic Street',
        default_currency: 'SGD'
      }
    });

    assert.equal(lookupCustomer({ databasePath, query: 'alpha' }).matchType, 'customer_code');
    assert.equal(lookupCustomer({ databasePath, query: 'Alpha Co' }).matchType, 'alias');
    assert.equal(lookupCustomer({ databasePath, query: 'Shared Trading Name' }).status, 'ambiguous');
    const fuzzy = lookupCustomer({ databasePath, query: 'Alfa Example Industries' });
    assert.equal(fuzzy.status, 'selection_required');
    assert.equal(fuzzy.matchType, 'fuzzy');

    const updated = updateCustomer({
      databasePath,
      customerId: first.id,
      changes: { billing_contact_name: 'Synthetic Accounts Contact' },
      actor: 'test-admin'
    });
    assert.equal(updated.billing_contact_name, 'Synthetic Accounts Contact');

    deactivateCustomer({ databasePath, customerId: first.id, actor: 'test-admin' });
    assert.equal(lookupCustomer({ databasePath, query: 'Alpha Co' }).status, 'inactive');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('customer readiness reports missing address, purchase-order, inactive, and currency issues', async () => {
  const customer = {
    active: 1,
    legal_name: 'Synthetic Customer Sdn. Bhd.',
    billing_address: null,
    purchase_order_required: 1,
    default_currency: 'MYR'
  };
  assert.deepEqual(
    assessCustomerReadiness(customer, { currency: 'SGD' }),
    { ready: false, issues: ['missing_billing_address', 'purchase_order_required', 'currency_mismatch'] }
  );
  assert.deepEqual(
    assessCustomerReadiness({ ...customer, active: 0 }, { currency: 'MYR', purchaseOrderNumber: 'TEST-PO' }).issues,
    ['inactive_customer', 'missing_billing_address']
  );
});

test('currency, entity, bank, and tax registries enforce controlled relationships and redact accounts', async () => {
  const { directory, databasePath } = await temporaryRegistry();
  try {
    const currencies = listRegistry({ databasePath, registry: 'currencies' });
    assert.deepEqual(currencies.map((item) => item.code), ['MYR', 'SGD', 'USD']);
    assert.deepEqual(currencies.map((item) => item.quotation_template_id), ['quotation-myr', 'quotation-sgd', 'quotation-usd']);

    const entity = createBusinessEntity({
      databasePath,
      actor: 'test-admin',
      entity: { legal_name: 'Synthetic Issuer Sdn. Bhd.', default_currency: 'MYR' }
    });
    const updatedEntity = updateBusinessEntity({
      databasePath,
      entityId: entity.id,
      changes: { trading_name: 'Synthetic Trading' },
      actor: 'test-admin'
    });
    assert.equal(updatedEntity.trading_name, 'Synthetic Trading');
    const bank = createBankProfile({
      databasePath,
      actor: 'test-admin',
      profile: {
        id: 'synthetic-myr',
        display_name: 'Synthetic MYR Bank',
        business_entity_id: entity.id,
        currency: 'MYR',
        bank_name: 'Example Test Bank',
        account_name: 'Synthetic Issuer',
        account_number: 'TEST-0000-1234'
      }
    });
    assert.equal(bank.account_number, '****1234');
    const updatedBank = updateBankProfile({
      databasePath,
      profileId: bank.id,
      changes: { account_number: 'TEST-0000-5678' },
      actor: 'test-admin'
    });
    assert.equal(updatedBank.account_number, '****5678');
    assert.equal(listRegistry({ databasePath, registry: 'banks' })[0].account_number, '****5678');
    assert.throws(() => configureCurrency({
      databasePath,
      code: 'SGD',
      changes: { default_bank_profile_id: bank.id },
      actor: 'test-admin'
    }), /match the currency/);
    configureCurrency({
      databasePath,
      code: 'MYR',
      changes: { default_bank_profile_id: bank.id },
      actor: 'test-admin'
    });
    assert.throws(() => deactivateBankProfile({ databasePath, profileId: bank.id, actor: 'test-admin' }), /assigned to an enabled currency/);
    assert.throws(() => deactivateBusinessEntity({ databasePath, entityId: entity.id, actor: 'test-admin' }), /active bank profiles/);

    const tax = createTaxRule({
      databasePath,
      actor: 'test-admin',
      rule: {
        country: 'Testland',
        name: 'Synthetic zero tax',
        code: 'test-zero',
        rate_basis_points: 0,
        calculation_method: 'NONE',
        display_label: 'No tax'
      }
    });
    const updatedTax = updateTaxRule({
      databasePath,
      ruleId: tax.id,
      changes: { display_label: 'Synthetic no tax' },
      actor: 'test-admin'
    });
    assert.equal(updatedTax.display_label, 'Synthetic no tax');
    configureCurrency({ databasePath, code: 'USD', changes: { default_tax_rule_id: tax.id }, actor: 'test-admin' });
    assert.throws(() => deactivateTaxRule({ databasePath, ruleId: tax.id, actor: 'test-admin' }), /assigned to an enabled currency/);

    const database = openDatabase(databasePath, { readOnly: true });
    const auditDetails = database.prepare('SELECT details_json FROM audit_events').all().map((row) => row.details_json).join('\n');
    const rawBank = database.prepare('SELECT account_number FROM bank_profiles WHERE id = ?').get(bank.id);
    database.close();
    assert.equal(rawBank.account_number, 'TEST-0000-5678');
    assert.doesNotMatch(auditDetails, /TEST-0000-1234/);
    assert.doesNotMatch(auditDetails, /TEST-0000-5678/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bank and tax mutation commands reject calls without explicit administrator mode', async () => {
  const { directory, databasePath } = await temporaryRegistry();
  try {
    for (const registry of ['bank', 'tax']) {
      const result = await runCli([
        registry, 'create', '--database', databasePath, '--input', 'tests/fixtures/not-read.json'
      ]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /require explicit --admin mode/);
    }
    const outsideInput = path.join(directory, 'outside-workspace.json');
    await writeFile(outsideInput, '{}', { mode: 0o600 });
    const escaped = await runCli([
      'bank', 'create', '--database', databasePath, '--input', outsideInput,
      '--admin', '--actor', 'test-admin'
    ]);
    assert.notEqual(escaped.code, 0);
    assert.match(escaped.stderr, /must be inside the Mira workspace/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
