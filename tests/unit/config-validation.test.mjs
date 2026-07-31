import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryRoot, runValidation } from '../../scripts/validate-config.mjs';
import { validateValueAgainstSchema } from '../../scripts/lib/config-validation.mjs';

test('foundation configuration passes its schema', async () => {
  const result = await runValidation();
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('foundation schema rejects disabling the approved F13 WhatsApp feature', async () => {
  const invalid = {
    database: true,
    documentGeneration: true,
    googleDrive: true,
    whatsApp: false,
    claims: true,
    supplierInvoices: true
  };
  const result = await validateValueAgainstSchema(
    repositoryRoot,
    'schemas/config/feature-flags.schema.json',
    invalid
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /required constant/);
});

test('foundation schema rejects unrecognised feature flags', async () => {
  const invalid = {
    database: true,
    documentGeneration: true,
    googleDrive: true,
    whatsApp: true,
    claims: true,
    supplierInvoices: true,
    automaticEmailing: false
  };
  const result = await validateValueAgainstSchema(
    repositoryRoot,
    'schemas/config/feature-flags.schema.json',
    invalid
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /additional property/);
});

test('claim schema accepts integer minor units and rejects floating totals', async () => {
  const valid = {
    transaction_date: '2026-07-31',
    merchant: 'TEST MERCHANT - NOT VALID',
    description: 'TEST claim - NOT VALID',
    category: 'other',
    client_or_project: null,
    currency: 'MYR',
    subtotal_minor: 1000,
    tax_minor: 0,
    total_minor: 1000,
    payment_method: null,
    business_purpose: 'TEST purpose - NOT VALID',
    client_initials: 'TP'
  };
  assert.equal((await validateValueAgainstSchema(repositoryRoot, 'schemas/claim-draft.schema.json', valid)).ok, true);
  assert.equal((await validateValueAgainstSchema(repositoryRoot, 'schemas/claim-draft.schema.json', { ...valid, total_minor: 10.5 })).ok, false);
});

test('supplier invoice schema accepts integer minor units and rejects floating totals', async () => {
  const valid = {
    classification: 'SUPPLIER_INVOICE',
    supplier_id: 1,
    supplier_invoice_number: 'TEST-SI-1001',
    issue_date: '2026-07-31',
    due_date: '2026-08-30',
    expense_category: 'other',
    project_allocation: 'TEST / NOT VALID',
    currency: 'MYR',
    subtotal_minor: 1000,
    tax_minor: 0,
    total_minor: 1000,
    description: 'TEST / NOT VALID',
    purchase_order_reference: null,
    probable_duplicate_reviewed: false
  };
  assert.equal((await validateValueAgainstSchema(repositoryRoot, 'schemas/supplier-invoice-draft.schema.json', valid)).ok, true);
  assert.equal((await validateValueAgainstSchema(repositoryRoot, 'schemas/supplier-invoice-draft.schema.json', { ...valid, total_minor: 10.5 })).ok, false);
});
