import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAuthorizedWhatsAppCommandSource,
  authorizeWhatsAppCommandSource,
  createOpenClawF10Patch,
  createWhatsAppRoutingConfiguration,
  loadWhatsAppRoutingConfiguration
} from '../../scripts/lib/whatsapp-routing.mjs';
import { verifyOpenClawF10 } from '../../scripts/verify-openclaw-f10.mjs';

const GROUP_ID = '120000000000000000@g.us';
const RAY = '+601100000000';
const configuration = {
  group: { id: GROUP_ID, requireMention: false },
  authorizedSenders: [{ e164: RAY, permissions: ['draft', 'confirm'] }]
};
const metadata = {
  channel: 'whatsapp', groupId: GROUP_ID, senderId: RAY,
  messageId: 'TEST-MESSAGE-NOT-VALID', receivedAt: '2026-07-30T00:00:00.000Z', mentionedMira: false
};

test('F10 loads a synthetic routing configuration without exposing identifiers', async () => {
  const loaded = await loadWhatsAppRoutingConfiguration({ env: {
    MIRA_WHATSAPP_GROUP_ID: GROUP_ID,
    MIRA_WHATSAPP_AUTHORIZED_SENDER: RAY
  } });
  assert.equal(loaded.group.displayName, 'RC Finance');
  assert.equal(loaded.authorizedSenders.length, 1);
});

test('Ray is authorised in RC Finance and command metadata is fingerprinted', () => {
  const result = assertAuthorizedWhatsAppCommandSource({ configuration, metadata, permission: 'confirm' });
  assert.equal(result.authorized, true);
  assert.equal(result.reason, 'AUTHORIZED');
  const serialised = JSON.stringify(result);
  assert.doesNotMatch(serialised, /120000000000000000|601100000000/);
  assert.match(result.actor, /^whatsapp:[a-f0-9]{24}$/);
});

test('unlisted groups, unauthorised senders, and missing activation are denied', () => {
  assert.equal(authorizeWhatsAppCommandSource({ configuration, metadata: { ...metadata, groupId: '120000000000000001@g.us' } }).reason, 'GROUP_NOT_ALLOWED');
  assert.equal(authorizeWhatsAppCommandSource({ configuration, metadata: { ...metadata, senderId: '+601100000001' } }).reason, 'SENDER_NOT_AUTHORIZED');
  const mentionConfiguration = { ...configuration, group: { ...configuration.group, requireMention: true } };
  assert.equal(authorizeWhatsAppCommandSource({ configuration: mentionConfiguration, metadata }).reason, 'ACTIVATION_REQUIRED');
});

test('F10 patch adds one exact binding without changing existing bindings', () => {
  const routingConfiguration = createWhatsAppRoutingConfiguration({ groupId: GROUP_ID, authorizedSender: RAY });
  const originalBinding = { agentId: 'main', match: { channel: 'whatsapp', peer: { kind: 'group', id: '120000000000000099@g.us' } } };
  const openClawConfiguration = {
    bindings: [originalBinding],
    channels: { whatsapp: { groups: { '120000000000000099@g.us': { requireMention: true } } } }
  };
  const patch = createOpenClawF10Patch({ openClawConfiguration, routingConfiguration });
  assert.deepEqual(patch.bindings[0], originalBinding);
  assert.equal(patch.bindings.length, 2);
  assert.deepEqual(patch.bindings[1], {
    agentId: 'mira-finance', match: { channel: 'whatsapp', peer: { kind: 'group', id: GROUP_ID } }
  });
  assert.equal(patch.channels.whatsapp.groups[GROUP_ID].requireMention, false);
  assert.deepEqual(patch.channels.whatsapp.groups[GROUP_ID].toolsBySender['*'].deny, [
    'read', 'mira_finance_health', 'group:messaging', 'group:sessions'
  ]);
});

test('F10 patch refuses to overwrite an existing group or conflicting binding', () => {
  const routingConfiguration = createWhatsAppRoutingConfiguration({ groupId: GROUP_ID, authorizedSender: RAY });
  assert.throws(() => createOpenClawF10Patch({
    routingConfiguration,
    openClawConfiguration: {
      bindings: [{ agentId: 'main', match: { channel: 'whatsapp', peer: { kind: 'group', id: GROUP_ID } } }]
    }
  }), /another agent/);
  assert.throws(() => createOpenClawF10Patch({
    routingConfiguration,
    openClawConfiguration: { bindings: [], channels: { whatsapp: { groups: { [GROUP_ID]: {} } } } }
  }), /refusing to overwrite/);
});

test('F10 verification proves prior routes and unrelated configuration are preserved', () => {
  const routing = createWhatsAppRoutingConfiguration({ groupId: GROUP_ID, authorizedSender: RAY });
  const before = {
    meta: { lastTouchedAt: 'before' },
    agents: { list: [{ id: 'main' }, { id: 'mira-finance' }] },
    bindings: [{ agentId: 'main', match: { channel: 'whatsapp', peer: { kind: 'group', id: '120000000000000099@g.us' } } }],
    channels: { whatsapp: { groupPolicy: 'allowlist', groups: { '120000000000000099@g.us': { requireMention: true } } } }
  };
  const patch = createOpenClawF10Patch({ openClawConfiguration: before, routingConfiguration: routing });
  const current = structuredClone(before);
  current.meta.lastTouchedAt = 'after';
  current.bindings = patch.bindings;
  current.channels.whatsapp.groups = { ...before.channels.whatsapp.groups, ...patch.channels.whatsapp.groups };
  assert.deepEqual(verifyOpenClawF10({ before, current, routing }), {
    priorBindings: 1, currentBindings: 2, priorGroups: 1, currentGroups: 2
  });
  current.channels.whatsapp.groupPolicy = 'open';
  assert.throws(() => verifyOpenClawF10({ before, current, routing }), /Unrelated OpenClaw configuration changed/);
});
