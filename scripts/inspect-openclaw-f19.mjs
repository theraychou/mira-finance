#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const [configPath = '/root/.openclaw/openclaw.json', routingPath = 'config/whatsapp-routing.json'] = process.argv.slice(2);
const [openClaw, routing] = await Promise.all([readFile(configPath, 'utf8').then(JSON.parse), readFile(routingPath, 'utf8').then(JSON.parse)]);
const tools = ['mira_finance_list_customers', 'mira_finance_prepare_customer_change', 'mira_finance_confirm_customer_change'];
const agent = (openClaw.agents?.list ?? []).find((item) => item.id === 'mira-finance');
const group = openClaw.channels?.whatsapp?.groups?.[routing.group.id];
const authorised = group?.toolsBySender?.[`e164:${routing.authorizedSenders[0].e164}`];
const wildcard = group?.toolsBySender?.['*'];
console.log(JSON.stringify({
  agentFound: Boolean(agent), broadMessageDenied: Boolean(agent?.tools?.deny?.includes('message')),
  broadExecDenied: Boolean(agent?.tools?.deny?.includes('exec')),
  customerToolsAllowedForAgent: tools.every((tool) => agent?.tools?.alsoAllow?.includes(tool)),
  customerToolsAllowedForRay: tools.every((tool) => authorised?.alsoAllow?.includes(tool)),
  customerToolsDeniedForOthers: tools.every((tool) => wildcard?.deny?.includes(tool)),
  pluginAllowed: openClaw.plugins?.allow?.includes('mira-finance-customers') === true,
  pluginEnabled: openClaw.plugins?.entries?.['mira-finance-customers']?.enabled === true,
  bindingCount: openClaw.bindings?.length ?? 0,
  financeBindingCount: (openClaw.bindings ?? []).filter((item) => item.agentId === 'mira-finance').length
}, null, 2));
