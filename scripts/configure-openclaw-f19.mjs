#!/usr/bin/env node
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const F19_TOOLS = ['mira_finance_list_customers', 'mira_finance_prepare_customer_change', 'mira_finance_confirm_customer_change'];
const addUnique = (values, additions) => [...new Set([...(values ?? []), ...additions])];

export function createOpenClawF19Configuration({ openClawConfiguration, routingConfiguration, workspacePath }) {
  const current = structuredClone(openClawConfiguration); const next = structuredClone(openClawConfiguration);
  const groupId = routingConfiguration?.group?.id; const sender = routingConfiguration?.authorizedSenders?.[0]?.e164;
  const agent = (next.agents?.list ?? []).find((item) => item.id === 'mira-finance');
  if (!groupId || !sender || !agent || !agent.tools?.deny?.includes('message') || !agent.tools?.deny?.includes('exec')) {
    throw new Error('F19 isolation prerequisites are missing.');
  }
  const group = next.channels?.whatsapp?.groups?.[groupId];
  const wildcard = group?.toolsBySender?.['*']; const authorised = group?.toolsBySender?.[`e164:${sender}`];
  if (!group || !wildcard || !authorised) throw new Error('F19 RC Finance policy is missing.');
  agent.tools.alsoAllow = addUnique(agent.tools.alsoAllow, F19_TOOLS);
  wildcard.deny = addUnique(wildcard.deny, F19_TOOLS);
  authorised.alsoAllow = addUnique(authorised.alsoAllow ?? authorised.allow, F19_TOOLS); delete authorised.allow;
  const guidance = 'Phase F19 customer administration is permitted only for Ray in RC Finance. Listing is read-only. Creation, modification, and deactivation require an exact preview and one-use CU token. Remove means deactivate; never delete customers. Never guess legal, address, currency, tax, payment-term, or PO-policy fields. The private ledger is authoritative and the Google Sheet is a one-way mirror.';
  if (!String(group.systemPrompt ?? '').includes('Phase F19 customer administration')) group.systemPrompt = `${group.systemPrompt ?? ''} ${guidance}`.trim();
  next.plugins ??= {}; next.plugins.allow = addUnique(next.plugins.allow, ['mira-finance-customers']);
  next.plugins.load ??= {}; next.plugins.load.paths = addUnique(next.plugins.load.paths, [path.posix.join(workspacePath, 'extensions', 'mira-finance-customers')]);
  next.plugins.entries ??= {}; next.plugins.entries['mira-finance-customers'] = { enabled: true };
  if (JSON.stringify(current.bindings) !== JSON.stringify(next.bindings)) throw new Error('F19 must preserve all bindings.');
  return next;
}

async function main() {
  const arg = (flag, fallback) => { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : fallback; };
  const configPath = path.resolve(arg('--config', '/root/.openclaw/openclaw.json'));
  const routingPath = path.resolve(arg('--routing', 'config/whatsapp-routing.json'));
  const workspacePath = arg('--workspace', '/root/.workspaces/mira-finance');
  const original = JSON.parse(await readFile(configPath, 'utf8')); const routing = JSON.parse(await readFile(routingPath, 'utf8'));
  const next = createOpenClawF19Configuration({ openClawConfiguration: original, routingConfiguration: routing, workspacePath });
  if (!process.argv.includes('--apply')) { console.log(JSON.stringify({ ready: true, changed: JSON.stringify(original) !== JSON.stringify(next), bindingsPreserved: true })); return; }
  const backupDir = path.join(path.dirname(configPath), 'backups'); await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, ''); const backup = path.join(backupDir, `openclaw-f19-pre-${stamp}.json`);
  await copyFile(configPath, backup); await chmod(backup, 0o600);
  const temporary = `${configPath}.f19-${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, configPath); await chmod(configPath, 0o600);
  console.log(JSON.stringify({ applied: true, backupCreated: true, bindingsPreserved: true }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`FAIL F19 OpenClaw configuration (${error.message})`); process.exitCode = 1; });
