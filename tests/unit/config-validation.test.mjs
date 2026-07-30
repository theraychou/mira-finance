import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryRoot, runValidation } from '../../scripts/validate-config.mjs';
import { validateValueAgainstSchema } from '../../scripts/lib/config-validation.mjs';

test('foundation configuration passes its schema', async () => {
  const result = await runValidation();
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('foundation schema rejects disabling the approved F10 WhatsApp feature', async () => {
  const invalid = {
    database: true,
    documentGeneration: true,
    googleDrive: true,
    whatsApp: false
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
    whatsApp: false,
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
