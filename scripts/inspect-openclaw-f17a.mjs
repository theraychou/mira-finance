#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const [configPath = '/root/.openclaw/openclaw.json', routingPath = 'config/whatsapp-routing.json'] = process.argv.slice(2);
const [openClaw, routing] = await Promise.all([
  readFile(configPath, 'utf8').then(JSON.parse),
  readFile(routingPath, 'utf8').then(JSON.parse)
]);
const agent = (openClaw.agents?.list ?? []).find((item) => item.id === 'mira-finance');
const group = openClaw.channels?.whatsapp?.groups?.[routing.group.id];
const senderPolicy = group?.toolsBySender?.[`e164:${routing.authorizedSenders[0].e164}`];
console.log(JSON.stringify({
  agentFound: Boolean(agent),
  agentToolProfile: agent?.tools?.profile ?? null,
  agentAllowedTools: agent?.tools?.alsoAllow ?? agent?.tools?.allow ?? [],
  agentDeniedBroadMessage: Boolean(agent?.tools?.deny?.includes('message')),
  bindingCount: openClaw.bindings?.length ?? 0,
  financeBindingCount: (openClaw.bindings ?? []).filter((item) => item.agentId === 'mira-finance' && item.match?.channel === 'whatsapp' && item.match?.peer?.id === routing.group.id).length,
  financeGroupFound: Boolean(group),
  financeGroupPolicyCount: Object.keys(group?.toolsBySender ?? {}).length,
  financeSenderAllowedTools: senderPolicy?.alsoAllow ?? senderPolicy?.allow ?? [],
  pluginAllowed: openClaw.plugins?.allow ?? [],
  pluginEntries: Object.keys(openClaw.plugins?.entries ?? {}).sort(),
  pluginLoadPathCount: openClaw.plugins?.load?.paths?.length ?? 0
}, null, 2));
