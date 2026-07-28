import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { flattenFixture, loadTemplateContract, readJson } from '../../scripts/lib/template-contract.mjs';
import { repositoryRoot } from '../../scripts/validate-config.mjs';

test('template and bank mappings cover each supported currency exactly once', async () => {
  const contract = await loadTemplateContract(repositoryRoot);
  assert.equal(contract.inventory.templates.length, 6);
  assert.equal(contract.bankMapping.profiles.length, 3);
  assert.deepEqual(Object.keys(contract.templateMapping.currencies).sort(), ['MYR', 'SGD', 'USD']);
  for (const currency of ['MYR', 'SGD', 'USD']) {
    const templates = contract.inventory.templates.filter((item) => item.currency === currency);
    assert.deepEqual(templates.map((item) => item.documentType).sort(), ['invoice', 'quotation']);
  }
});

test('public mappings do not contain account-number fields', async () => {
  const text = await readFile(new URL('../../config/bank-profile-template-mapping.json', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /account[_ -]?number/i);
  assert.doesNotMatch(text, /\b\d{8,}\b/);
});

test('non-zero tax is deterministically rejected', async () => {
  const [fixture, contract] = await Promise.all([
    readJson(repositoryRoot, 'tests/fixtures/template-render.json'),
    loadTemplateContract(repositoryRoot)
  ]);
  fixture.taxMinor = 1;
  assert.throws(() => flattenFixture(fixture, contract.inventory.templates[0]), /Non-zero tax is disabled/);
});
