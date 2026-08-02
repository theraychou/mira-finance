import test from 'node:test';
import assert from 'node:assert/strict';
import { createGogGmailInboundClient } from '../../scripts/lib/gog-gmail-inbound-client.mjs';

test('Gmail inbound client performs one bounded read-only message search', async () => {
  let invocation;
  const client = createGogGmailInboundClient({ account: 'finance@example.test', client: 'mira-gmail-inbound',
    runner: async (command, args) => { invocation = { command, args }; return { stdout: JSON.stringify({ messages: [{
      id: 'TEST-MESSAGE', threadId: 'TEST-THREAD', from: 'billing@example.test', subject: 'TEST / NOT VALID',
      body: 'TEST / NOT VALID', internalDate: 1785628800000
    }] }) }; } });
  const result = await client.search({ query: 'in:inbox -from:me newer_than:30d', maximumResults: 20 });
  assert.equal(result.length, 1); assert.equal(invocation.command, 'gog');
  assert.ok(invocation.args.includes('--enable-commands=gmail')); assert.ok(invocation.args.includes('--no-input'));
  assert.ok(invocation.args.includes('--include-body')); assert.ok(invocation.args.includes('--max=20'));
  assert.ok(!invocation.args.some((value) => /modify|label|delete|drive/i.test(value)));
});
