import test from 'node:test';
import assert from 'node:assert/strict';
import { createGogGmailClient } from '../../scripts/lib/gog-gmail-client.mjs';
import { createOpenClawWhatsAppClient } from '../../scripts/lib/openclaw-whatsapp-client.mjs';

test('Gmail client uses only the Gmail command group and non-interactive attachment sending', async () => {
  let invocation;
  const client = createGogGmailClient({ account: 'finance@example.test', client: 'mira-gmail-send', from: 'finance@example.test',
    runner: async (command, args) => { invocation = { command, args }; return { stdout: JSON.stringify({ id: 'TEST-ID' }) }; } });
  await client.send({ to: 'client@example.test', subject: 'TEST / NOT VALID', body: 'TEST / NOT VALID', attachmentPath: 'C:/test.pdf' });
  assert.equal(invocation.command, 'gog');
  assert.ok(invocation.args.includes('--enable-commands=gmail'));
  assert.ok(invocation.args.includes('--no-input'));
  assert.ok(invocation.args.includes('--attach=C:/test.pdf'));
  assert.ok(!invocation.args.some((value) => value.includes('gmail.modify') || value.includes('drive')));
});

test('WhatsApp client sends one explicit target and one local attachment without shell composition', async () => {
  let invocation;
  const client = createOpenClawWhatsAppClient({ runner: async (command, args) => { invocation = { command, args }; return { stdout: JSON.stringify({ messageId: 'TEST-ID' }) }; } });
  await client.send({ to: '+15555550123', body: 'TEST / NOT VALID', attachmentPath: 'C:/test.pdf' });
  assert.equal(invocation.command, 'openclaw');
  assert.deepEqual(invocation.args.slice(0, 3), ['message', 'send', '--channel=whatsapp']);
  assert.ok(invocation.args.includes('--target=+15555550123'));
  assert.ok(invocation.args.includes('--media=C:/test.pdf'));
});
