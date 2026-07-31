import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../../scripts/validate-config.mjs';

test('F12 policy isolates Mira and keeps claim mutations outside WhatsApp tools', async () => {
  const policy = JSON.parse(await readFile(path.join(repositoryRoot, 'config/openclaw-agent-policy.json'), 'utf8'));
  assert.equal(policy.agentId, 'mira-finance');
  assert.equal(policy.displayName, 'Mira');
  assert.equal(policy.workspace, '/root/.workspaces/mira-finance');
  assert.deepEqual(policy.skills, ['mira-finance']);
  assert.deepEqual(policy.tools.alsoAllow, ['read', 'mira_finance_health']);
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
