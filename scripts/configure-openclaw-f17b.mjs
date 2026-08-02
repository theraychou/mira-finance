#!/usr/bin/env node
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const F17B_TOOLS = ['mira_finance_prepare_customer_reply', 'mira_finance_confirm_customer_reply'];
const addUnique = (values, additions) => [...new Set([...(values ?? []), ...additions])];

export function createOpenClawF17BConfiguration({ openClawConfiguration, routingConfiguration, workspacePath }) {
  const current = structuredClone(openClawConfiguration); const next = structuredClone(openClawConfiguration);
  const groupId = routingConfiguration?.group?.id; const sender = routingConfiguration?.authorizedSenders?.[0]?.e164;
  const agent = (next.agents?.list ?? []).find((item) => item.id === 'mira-finance');
  if (!groupId || !sender || !agent || !agent.tools?.deny?.includes('message')) throw new Error('F17B isolation prerequisites are missing.');
  agent.tools.alsoAllow = addUnique(agent.tools.alsoAllow, F17B_TOOLS);
  const group = next.channels?.whatsapp?.groups?.[groupId];
  const wildcard = group?.toolsBySender?.['*']; const authorised = group?.toolsBySender?.[`e164:${sender}`];
  if (!group || !wildcard || !authorised) throw new Error('F17B RC Finance policy is missing.');
  wildcard.deny = addUnique(wildcard.deny, F17B_TOOLS);
  authorised.alsoAllow = addUnique(authorised.alsoAllow ?? authorised.allow, F17B_TOOLS); delete authorised.allow;
  group.systemPrompt = String(group.systemPrompt ?? '').replace('Inbound customer reply processing remains disabled until F17B.', '').trim();
  const guidance = 'Phase F17B customer replies are deterministic and verified-contact-only. Unknown or ambiguous questions are escalated here. Ray-provided responses require an exact short-lived confirmation token.';
  if (!group.systemPrompt.includes('Phase F17B customer replies')) group.systemPrompt = `${group.systemPrompt} ${guidance}`.trim();
  next.plugins ??= {}; next.plugins.allow = addUnique(next.plugins.allow, ['mira-finance-inbound']);
  next.plugins.load ??= {}; next.plugins.load.paths = addUnique(next.plugins.load.paths, [path.posix.join(workspacePath, 'extensions', 'mira-finance-inbound')]);
  next.plugins.entries ??= {}; next.plugins.entries['mira-finance-inbound'] = { enabled: true };
  if (JSON.stringify(current.bindings) !== JSON.stringify(next.bindings)) throw new Error('F17B must preserve all bindings.');
  return next;
}

async function main() {
  const arg = (flag, fallback) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : fallback; };
  const configPath = path.resolve(arg('--config', '/root/.openclaw/openclaw.json'));
  const routingPath = path.resolve(arg('--routing', 'config/whatsapp-routing.json'));
  const workspacePath = arg('--workspace', '/root/.workspaces/mira-finance');
  const original = JSON.parse(await readFile(configPath, 'utf8')); const routing = JSON.parse(await readFile(routingPath, 'utf8'));
  const next = createOpenClawF17BConfiguration({ openClawConfiguration: original, routingConfiguration: routing, workspacePath });
  if (!process.argv.includes('--apply')) { console.log(JSON.stringify({ ready: true, changed: JSON.stringify(original) !== JSON.stringify(next), bindingsPreserved: true })); return; }
  const backupDir = path.join(path.dirname(configPath), 'backups'); await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, ''); const backup = path.join(backupDir, `openclaw-f17b-pre-${stamp}.json`);
  await copyFile(configPath, backup); await chmod(backup, 0o600);
  const temporary = `${configPath}.f17b-${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, configPath); await chmod(configPath, 0o600);
  console.log(JSON.stringify({ applied: true, backupCreated: true, bindingsPreserved: true }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`FAIL F17B OpenClaw configuration (${error.message})`); process.exitCode = 1; });
