import test from 'node:test';
import assert from 'node:assert/strict';
import { createGogSheetsClient, SheetsClientError } from '../../scripts/lib/gog-sheets-client.mjs';

test('gog Sheets client enables only Sheets and exact Drive placement commands', async () => {
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    if (args.includes('create')) return { stdout: JSON.stringify({ spreadsheetId: 'TEST_SHEET_123456' }) };
    if (args.includes('get')) return { stdout: JSON.stringify({ id: 'TEST_SHEET_123456', parents: args.filter((item) => item.startsWith('--parent=')) }) };
    return { stdout: JSON.stringify({ id: 'TEST_SHEET_123456' }) };
  };
  const client = createGogSheetsClient({ identity: 'test@example.invalid', client: 'mira-sheets', runner });
  assert.equal((await client.createSpreadsheet({ title: 'TEST / NOT VALID', sheetName: 'Customers' })).id, 'TEST_SHEET_123456');
  await client.updateValues({ spreadsheetId: 'TEST_SHEET_123456', range: 'Customers!A1:B2', values: [['TEST', 'NOT VALID']] });
  assert.equal(calls.every((args) => args.includes('--enable-commands=sheets,drive.get,drive.move')), true);
  assert.equal(calls.every((args) => args.includes('--no-input') && args.includes('--json')), true);
  assert.equal(calls.some((args) => args.includes('gmail') || args.includes('calendar')), false);
  const updateCall = calls.find((args) => args.includes('update'));
  assert.equal(updateCall.some((item) => item.includes('NOT VALID') || item.includes('[["TEST"')), false);
  assert.equal(updateCall.includes('--values-json'), true);
  assert.equal(updateCall.some((item) => item.startsWith('@') && item.endsWith('values.json')), true);
});

test('gog Sheets client returns redacted error codes', async () => {
  const client = createGogSheetsClient({ identity: 'test@example.invalid', client: 'mira-sheets',
    runner: async () => { const error = new Error('403 secret provider detail'); error.stderr = 'forbidden'; throw error; } });
  await assert.rejects(() => client.createSpreadsheet({ title: 'TEST / NOT VALID', sheetName: 'Customers' }),
    (error) => error instanceof SheetsClientError && error.code === 'SHEETS_AUTHORIZATION_FAILED' && !error.message.includes('secret'));
});
