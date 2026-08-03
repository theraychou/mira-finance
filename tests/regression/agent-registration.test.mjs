import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../../scripts/validate-config.mjs';

test('F17B policy isolates Mira and exposes only narrow delivery and escalation tools', async () => {
  const policy = JSON.parse(await readFile(path.join(repositoryRoot, 'config/openclaw-agent-policy.json'), 'utf8'));
  assert.equal(policy.agentId, 'mira-finance');
  assert.equal(policy.displayName, 'Mira');
  assert.equal(policy.workspace, '/root/.workspaces/mira-finance');
  assert.deepEqual(policy.skills, ['mira-finance']);
  assert.deepEqual(policy.tools.alsoAllow, ['read', 'mira_finance_health', 'mira_finance_prepare_delivery', 'mira_finance_confirm_delivery', 'mira_finance_prepare_customer_reply', 'mira_finance_confirm_customer_reply']);
  assert.equal(policy.tools.fs.workspaceOnly, true);
  assert.equal(policy.tools.elevated.enabled, false);
  assert.equal(policy.tools.message.allowCrossContextSend, false);
  assert.equal(policy.sandbox.mode, 'off');
  assert.equal(policy.healthTool, 'mira_finance_health');
  assert.ok(policy.tools.deny.includes('exec'));
  for (const denied of ['message', 'sessions_list', 'sessions_history', 'sessions_send', 'sessions_spawn', 'web_search', 'web_fetch']) {
    assert.ok(policy.tools.deny.includes(denied));
  }
});

test('customer inbound plugin is deterministic and confirmation-gated', async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'extensions/mira-finance-inbound/openclaw.plugin.json'), 'utf8'));
  const source = await readFile(path.join(repositoryRoot, 'extensions/mira-finance-inbound/index.js'), 'utf8');
  assert.deepEqual(manifest.contracts.tools, ['mira_finance_prepare_customer_reply', 'mira_finance_confirm_customer_reply']);
  assert.match(source, /before_dispatch/); assert.match(source, /message_sent/); assert.match(source, /loadCustomerInboundConfig/);
  assert.match(source, /mira-finance-inbound-before-dispatch/); assert.match(source, /mira-finance-inbound-message-sent/);
  assert.equal((source.match(/CUSTOMER_INBOUND_DISABLED/g) ?? []).length, 4);
  assert.doesNotMatch(source, /\/root\/clawd|client_secret|refresh_token|private_key/i);
});

test('customer delivery plugin is confirmation-gated while broad messaging remains denied', async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'extensions/mira-finance-delivery/openclaw.plugin.json'), 'utf8'));
  const source = await readFile(path.join(repositoryRoot, 'extensions/mira-finance-delivery/index.js'), 'utf8');
  const executable = await readFile(path.join(repositoryRoot, 'scripts/customer-delivery.mjs'), 'utf8');
  assert.deepEqual(manifest.contracts.tools, ['mira_finance_prepare_delivery', 'mira_finance_confirm_delivery']);
  assert.equal(manifest.toolMetadata.mira_finance_prepare_delivery.optional, true);
  assert.equal(manifest.toolMetadata.mira_finance_confirm_delivery.optional, true);
  assert.match(source, /requesterSenderId/);
  assert.match(source, /requesterSenderId/);
  assert.match(source, /routing\.group\.id/);
  assert.match(source, /defaultChannel/);
  assert.match(executable, /--admin/);
  assert.doesNotMatch(`${source}\n${executable}`, /\/root\/clawd|client_secret|refresh_token|private_key/i);
});

test('production operations CLI is fail-closed and not exposed through WhatsApp', async () => {
  const executable = await readFile(path.join(repositoryRoot, 'scripts/operations.mjs'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'extensions/mira-finance-health/openclaw.plugin.json'), 'utf8'));
  assert.match(executable, /--admin/);
  assert.match(executable, /--actor/);
  assert.doesNotMatch(executable, /sendMessage|\/root\/clawd|client_secret|refresh_token|private_key/i);
  assert.deepEqual(manifest.contracts.tools, ['mira_finance_health']);
});

test('F16 maintenance timer is private, bounded, and cannot restart OpenClaw', async () => {
  const service = await readFile(path.join(repositoryRoot, 'ops/systemd/mira-finance-maintenance.service'), 'utf8');
  const timer = await readFile(path.join(repositoryRoot, 'ops/systemd/mira-finance-maintenance.timer'), 'utf8');
  assert.match(service, /UMask=0077/); assert.match(service, /NoNewPrivileges=true/); assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /cleanup-temp/); assert.match(service, /rotate-logs/); assert.match(service, /disk-audit/); assert.match(service, /permission-audit/);
  assert.doesNotMatch(`${service}\n${timer}`, /openclaw.*(restart|stop|start)|message|send/i);
  assert.match(timer, /Asia\/Kuala_Lumpur/); assert.match(timer, /Persistent=true/);
});

test('F17B email timer isolates Mira from the shared Google token store', async () => {
  const service = await readFile(path.join(repositoryRoot, 'ops/systemd/mira-finance-inbound-email.service'), 'utf8');
  const timer = await readFile(path.join(repositoryRoot, 'ops/systemd/mira-finance-inbound-email.timer'), 'utf8');
  assert.match(service, /Environment=XDG_CONFIG_HOME=\/root\/\.config\/mira-finance-gog/);
  assert.match(service, /EnvironmentFile=\/root\/\.config\/mira-finance-gog-secrets\/keyring\.env/);
  assert.match(service, /InaccessiblePaths=\/root\/\.config\/gogcli/);
  assert.match(service, /ReadWritePaths=\/root\/\.workspaces\/mira-finance \/root\/\.config\/mira-finance-gog/);
  assert.match(service, /UMask=0077/);
  assert.match(timer, /OnUnitActiveSec=5min/);
});

test('correction CLI is fail-closed and is not exposed as a WhatsApp tool', async () => {
  const executable = await readFile(path.join(repositoryRoot, 'scripts/corrections.mjs'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'extensions/mira-finance-health/openclaw.plugin.json'), 'utf8'));
  assert.match(executable, /--admin/);
  assert.match(executable, /data.*pending/);
  assert.doesNotMatch(executable, /sendMessage|\/root\/clawd|client_secret|refresh_token|private_key/i);
  assert.deepEqual(manifest.contracts.tools, ['mira_finance_health']);
});

test('finance health executable rejects arguments and contains no secret material', async () => {
  const executable = await readFile(path.join(repositoryRoot, 'bin/mira-finance-health'), 'utf8');
  assert.match(executable, /process\.argv\.length !== 2/);
  assert.doesNotMatch(executable, /client_secret|refresh_token|private_key|folderId|@gmail\.com/i);
});

test('finance health plugin declares one no-argument tool', async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'extensions/mira-finance-health/openclaw.plugin.json'), 'utf8'));
  const source = await readFile(path.join(repositoryRoot, 'extensions/mira-finance-health/index.js'), 'utf8');
  assert.deepEqual(manifest.contracts.tools, ['mira_finance_health']);
  assert.match(source, /additionalProperties: false/);
  assert.match(source, /name === 'optional:whatsapp'/);
  assert.match(source, /operations:failure-alerts/);
  assert.match(source, /optional:customer-inbound/);
  assert.doesNotMatch(source, /whatsApp:\s*'NOT_CONFIGURED'/);
  assert.doesNotMatch(source, /child_process|execFile|spawn|client_secret|refresh_token|private_key/i);
});

test('claim administrator CLI is fail-closed and not declared as an OpenClaw tool', async () => {
  const executable = await readFile(path.join(repositoryRoot, 'scripts/claim-receipt.mjs'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'extensions/mira-finance-health/openclaw.plugin.json'), 'utf8'));
  assert.match(executable, /--admin/);
  assert.match(executable, /data.*claims.*inbox/);
  assert.match(executable, /data.*pending/);
  assert.doesNotMatch(executable, /\/root\/clawd|client_secret|refresh_token|private_key/i);
  assert.deepEqual(manifest.contracts.tools, ['mira_finance_health']);
});

test('supplier invoice administrator CLI is fail-closed and not declared as an OpenClaw tool', async () => {
  const executable = await readFile(path.join(repositoryRoot, 'scripts/supplier-invoice.mjs'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'extensions/mira-finance-health/openclaw.plugin.json'), 'utf8'));
  assert.match(executable, /--admin/);
  assert.match(executable, /data.*supplier-invoices.*inbox/);
  assert.match(executable, /data.*pending/);
  assert.doesNotMatch(executable, /\/root\/clawd|client_secret|refresh_token|private_key/i);
  assert.deepEqual(manifest.contracts.tools, ['mira_finance_health']);
});

test('report and claim-recharge CLI is fail-closed and not declared as an OpenClaw tool', async () => {
  const executable = await readFile(path.join(repositoryRoot, 'scripts/finance-reports.mjs'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'extensions/mira-finance-health/openclaw.plugin.json'), 'utf8'));
  assert.match(executable, /--admin/);
  assert.match(executable, /data.*pending/);
  assert.doesNotMatch(executable, /google.*sheets|spreadsheets|sendMessage|\/root\/clawd|client_secret|refresh_token|private_key/i);
  assert.deepEqual(manifest.contracts.tools, ['mira_finance_health']);
});
