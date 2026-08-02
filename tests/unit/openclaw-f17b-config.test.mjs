import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenClawF17BConfiguration, F17B_TOOLS } from '../../scripts/configure-openclaw-f17b.mjs';

const group = '120000000000000000@g.us'; const sender = '+601100000000';
function fixture() {
  return {
    agents: { list: [{ id: 'jessie', tools: { alsoAllow: ['unrelated'] } }, { id: 'mira-finance', tools: { alsoAllow: ['read'], deny: ['message'] } }] },
    bindings: [{ agentId: 'jessie', match: { channel: 'whatsapp' } }, { agentId: 'mira-finance', match: { channel: 'whatsapp', peer: { kind: 'group', id: group } } }],
    channels: { whatsapp: { groups: { [group]: { systemPrompt: 'Inbound customer reply processing remains disabled until F17B.', toolsBySender: {
      '*': { deny: ['message'] }, [`e164:${sender}`]: { alsoAllow: ['read'] }
    } } } } }, plugins: { allow: [], load: { paths: [] }, entries: {} }
  };
}

test('F17B patch preserves bindings and other agents while restricting reply tools to Ray', () => {
  const before = fixture(); const next = createOpenClawF17BConfiguration({ openClawConfiguration: before,
    routingConfiguration: { group: { id: group }, authorizedSenders: [{ e164: sender }] }, workspacePath: '/root/.workspaces/mira-finance' });
  assert.deepEqual(next.bindings, before.bindings); assert.deepEqual(next.agents.list[0], before.agents.list[0]);
  for (const tool of F17B_TOOLS) {
    assert.ok(next.agents.list[1].tools.alsoAllow.includes(tool));
    assert.ok(next.channels.whatsapp.groups[group].toolsBySender['*'].deny.includes(tool));
    assert.ok(next.channels.whatsapp.groups[group].toolsBySender[`e164:${sender}`].alsoAllow.includes(tool));
  }
  assert.ok(next.agents.list[1].tools.deny.includes('message')); assert.ok(next.plugins.allow.includes('mira-finance-inbound'));
});
