import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenClawF17AConfiguration } from '../../scripts/configure-openclaw-f17a.mjs';

const group = '120000000000000000@g.us';
const sender = '+601100000000';

function configuration() {
  return {
    agents: { list: [
      { id: 'main', tools: { alsoAllow: ['unrelated'] } },
      { id: 'mira-finance', workspace: '/root/.workspaces/mira-finance', tools: { profile: 'minimal', alsoAllow: ['read', 'mira_finance_health'], deny: ['message', 'exec'] } }
    ] },
    bindings: [
      { agentId: 'main', match: { channel: 'whatsapp', peer: { kind: 'group', id: '120000000000000099@g.us' } } },
      { agentId: 'mira-finance', match: { channel: 'whatsapp', peer: { kind: 'group', id: group } } }
    ],
    channels: { whatsapp: { unrelated: true, groups: {
      '120000000000000099@g.us': { requireMention: true },
      [group]: { requireMention: false, toolsBySender: {
        '*': { deny: ['read', 'mira_finance_health'] },
        [`e164:${sender}`]: { alsoAllow: ['read', 'mira_finance_health'] }
      }, systemPrompt: 'Dedicated finance group. Do not send customer communications or issue an official document during F10.' }
    } } },
    plugins: { allow: ['mira-finance-health'], load: { paths: ['/root/.workspaces/mira-finance/extensions/mira-finance-health'] }, entries: { 'mira-finance-health': { enabled: true } } },
    unrelated: { preserved: true }
  };
}

test('F17A OpenClaw patch is additive and preserves bindings, other agents, and unrelated configuration', () => {
  const before = configuration();
  const next = createOpenClawF17AConfiguration({ openClawConfiguration: before,
    routingConfiguration: { group: { id: group }, authorizedSenders: [{ e164: sender }] }, workspacePath: '/root/.workspaces/mira-finance' });
  assert.deepEqual(next.bindings, before.bindings);
  assert.deepEqual(next.agents.list[0], before.agents.list[0]);
  assert.deepEqual(next.unrelated, before.unrelated);
  assert.equal(next.channels.whatsapp.unrelated, true);
  assert.ok(next.agents.list[1].tools.alsoAllow.includes('mira_finance_prepare_delivery'));
  assert.ok(next.agents.list[1].tools.deny.includes('message'));
  assert.ok(next.channels.whatsapp.groups[group].toolsBySender['*'].deny.includes('mira_finance_confirm_delivery'));
  assert.ok(next.channels.whatsapp.groups[group].toolsBySender[`e164:${sender}`].alsoAllow.includes('mira_finance_confirm_delivery'));
  assert.ok(next.plugins.allow.includes('mira-finance-delivery'));
  assert.equal(next.plugins.entries['mira-finance-delivery'].enabled, true);
});

test('F17A OpenClaw patch refuses missing isolation boundaries', () => {
  const before = configuration();
  before.agents.list[1].tools.deny = [];
  assert.throws(() => createOpenClawF17AConfiguration({ openClawConfiguration: before,
    routingConfiguration: { group: { id: group }, authorizedSenders: [{ e164: sender }] }, workspacePath: '/root/.workspaces/mira-finance' }), /broad messaging/);
});
