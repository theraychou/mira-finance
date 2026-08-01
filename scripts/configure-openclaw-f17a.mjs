#!/usr/bin/env node
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DELIVERY_TOOLS = ['mira_finance_prepare_delivery', 'mira_finance_confirm_delivery'];

function addUnique(values, additions) { return [...new Set([...(values ?? []), ...additions])]; }

export function createOpenClawF17AConfiguration({ openClawConfiguration, routingConfiguration, workspacePath }) {
  const current = structuredClone(openClawConfiguration);
  const next = structuredClone(openClawConfiguration);
  const groupId = routingConfiguration?.group?.id;
  const sender = routingConfiguration?.authorizedSenders?.[0]?.e164;
  if (typeof groupId !== 'string' || typeof sender !== 'string') throw new Error('F17A private WhatsApp routing configuration is invalid.');
  const agents = next.agents?.list ?? [];
  const matches = agents.filter((item) => item.id === 'mira-finance');
  if (matches.length !== 1) throw new Error('F17A requires exactly one existing Mira agent.');
  const agent = matches[0];
  if (!agent.tools?.deny?.includes('message')) throw new Error('Mira broad messaging must remain denied.');
  agent.tools.alsoAllow = addUnique(agent.tools.alsoAllow, DELIVERY_TOOLS);

  const bindings = next.bindings ?? [];
  const financeBindings = bindings.filter((item) => item.agentId === 'mira-finance' && item.match?.channel === 'whatsapp'
    && item.match?.peer?.kind === 'group' && item.match?.peer?.id === groupId);
  if (financeBindings.length !== 1) throw new Error('The existing RC Finance binding is missing or ambiguous.');
  const group = next.channels?.whatsapp?.groups?.[groupId];
  if (!group || typeof group !== 'object') throw new Error('The existing RC Finance group configuration is missing.');
  const defaultPolicy = group.toolsBySender?.['*'];
  const senderPolicy = group.toolsBySender?.[`e164:${sender}`];
  if (!defaultPolicy || !senderPolicy) throw new Error('The existing RC Finance sender policy is missing.');
  defaultPolicy.deny = addUnique(defaultPolicy.deny, DELIVERY_TOOLS);
  senderPolicy.alsoAllow = addUnique(senderPolicy.alsoAllow ?? senderPolicy.allow, DELIVERY_TOOLS);
  delete senderPolicy.allow;
  const guidance = [
    'Phase F17A customer delivery requires a masked preview and an exact short-lived confirmation token.',
    'Email is the default. Use WhatsApp only when Ray explicitly requests it.',
    'Never accept an ad-hoc destination or use the broad messaging tool.',
    'Inbound customer reply processing remains disabled until F17B.'
  ].join(' ');
  const withoutLegacy = String(group.systemPrompt ?? '').replace('Do not send customer communications or issue an official document during F10.', '').trim();
  group.systemPrompt = withoutLegacy.includes('Phase F17A customer delivery') ? withoutLegacy : `${withoutLegacy} ${guidance}`.trim();

  next.plugins ??= {};
  next.plugins.allow = addUnique(next.plugins.allow, ['mira-finance-delivery']);
  next.plugins.load ??= {};
  next.plugins.load.paths = addUnique(next.plugins.load.paths, [path.posix.join(workspacePath, 'extensions', 'mira-finance-delivery')]);
  next.plugins.entries ??= {};
  next.plugins.entries['mira-finance-delivery'] = { enabled: true };

  if (JSON.stringify(current.bindings) !== JSON.stringify(next.bindings)) throw new Error('F17A must not change existing bindings.');
  return next;
}

async function main() {
  const argument = (flag, fallback = null) => { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : fallback; };
  const configPath = path.resolve(argument('--config', '/root/.openclaw/openclaw.json'));
  const routingPath = path.resolve(argument('--routing', 'config/whatsapp-routing.json'));
  const workspacePath = argument('--workspace', '/root/.workspaces/mira-finance');
  const apply = process.argv.includes('--apply');
  const [configuration, routing] = await Promise.all([readFile(configPath, 'utf8').then(JSON.parse), readFile(routingPath, 'utf8').then(JSON.parse)]);
  const next = createOpenClawF17AConfiguration({ openClawConfiguration: configuration, routingConfiguration: routing, workspacePath });
  if (!apply) {
    console.log(JSON.stringify({ ready: true, changed: JSON.stringify(configuration) !== JSON.stringify(next), bindingsPreserved: true,
      deliveryTools: DELIVERY_TOOLS.length, deliveryPluginEnabled: true }));
    return;
  }
  const backupDirectory = path.join(path.dirname(configPath), 'backups');
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, '').replace('Z', 'Z');
  const backupPath = path.join(backupDirectory, `openclaw-f17a-pre-${stamp}.json`);
  await copyFile(configPath, backupPath);
  await chmod(backupPath, 0o600);
  const temporary = `${configPath}.f17a-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, configPath);
  await chmod(configPath, 0o600);
  console.log(JSON.stringify({ applied: true, backupCreated: true, bindingsPreserved: true, deliveryTools: DELIVERY_TOOLS.length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`FAIL F17A OpenClaw configuration (${error?.code ?? error?.message ?? 'CONFIGURATION_FAILED'})`); process.exitCode = 1; });
}
