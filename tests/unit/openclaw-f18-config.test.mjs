import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenClawF18Configuration, F18_TOOLS } from '../../scripts/configure-openclaw-f18.mjs';

const group = '120000000000000000@g.us'; const sender = '+601100000000';
function fixture() {
  return {
    agents: { list: [{ id: 'jessie', tools: { alsoAllow: ['unrelated'] } }, { id: 'mira-finance', tools: { alsoAllow: ['read'], deny: ['message', 'exec'] } }] },
    bindings: [{ agentId: 'jessie', match: { channel: 'whatsapp' } }, { agentId: 'mira-finance', match: { channel: 'whatsapp', peer: { kind: 'group', id: group } } }],
    channels: { whatsapp: { groups: { [group]: { systemPrompt: 'Existing finance rules.', toolsBySender: {
      '*': { deny: ['message'] }, [`e164:${sender}`]: { alsoAllow: ['read'] }
    } } } } }, plugins: { allow: [], load: { paths: [] }, entries: {} }, unrelated: { preserved: true }
  };
}

test('F18 patch preserves every binding and exposes invoice tools only to Ray', () => {
  const before = fixture(); const next = createOpenClawF18Configuration({ openClawConfiguration: before,
    routingConfiguration: { group: { id: group }, authorizedSenders: [{ e164: sender }] }, workspacePath: '/root/.workspaces/mira-finance' });
  assert.deepEqual(next.bindings, before.bindings); assert.deepEqual(next.agents.list[0], before.agents.list[0]);
  assert.deepEqual(next.unrelated, before.unrelated);
  for (const tool of F18_TOOLS) {
    assert.ok(next.agents.list[1].tools.alsoAllow.includes(tool));
    assert.ok(next.channels.whatsapp.groups[group].toolsBySender['*'].deny.includes(tool));
    assert.ok(next.channels.whatsapp.groups[group].toolsBySender[`e164:${sender}`].alsoAllow.includes(tool));
  }
  assert.ok(next.agents.list[1].tools.deny.includes('message')); assert.ok(next.agents.list[1].tools.deny.includes('exec'));
  assert.ok(next.plugins.allow.includes('mira-finance-invoice'));
  assert.equal(next.plugins.entries['mira-finance-invoice'].enabled, true);
});

test('F18 patch refuses missing isolation or sender policy', () => {
  const missingExecDeny = fixture(); missingExecDeny.agents.list[1].tools.deny = ['message'];
  assert.throws(() => createOpenClawF18Configuration({ openClawConfiguration: missingExecDeny,
    routingConfiguration: { group: { id: group }, authorizedSenders: [{ e164: sender }] }, workspacePath: '/root/.workspaces/mira-finance' }), /isolation prerequisites/);
  const missingSender = fixture(); delete missingSender.channels.whatsapp.groups[group].toolsBySender[`e164:${sender}`];
  assert.throws(() => createOpenClawF18Configuration({ openClawConfiguration: missingSender,
    routingConfiguration: { group: { id: group }, authorizedSenders: [{ e164: sender }] }, workspacePath: '/root/.workspaces/mira-finance' }), /RC Finance policy/);
});
