import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../../scripts/validate-config.mjs';

test('F9 policy isolates Mira and exposes only finance health capabilities', async () => {
  const policy = JSON.parse(await readFile(path.join(repositoryRoot, 'config/openclaw-agent-policy.json'), 'utf8'));
  assert.equal(policy.agentId, 'mira-finance');
  assert.equal(policy.displayName, 'Mira');
  assert.equal(policy.workspace, '/root/.workspaces/mira-finance');
  assert.deepEqual(policy.skills, ['mira-finance']);
  assert.deepEqual(policy.tools.allow, ['read', 'exec']);
  assert.equal(policy.tools.fs.workspaceOnly, true);
  assert.equal(policy.tools.exec.mode, 'allowlist');
  assert.equal(policy.tools.exec.security, 'allowlist');
  assert.equal(policy.tools.exec.ask, 'off');
  assert.equal(policy.tools.elevated.enabled, false);
  assert.equal(policy.tools.message.allowCrossContextSend, false);
  assert.equal(policy.sandbox.mode, 'off');
  assert.equal(policy.approvedExecutable, '/root/.workspaces/mira-finance/bin/mira-finance-health');
  for (const denied of ['message', 'sessions_list', 'sessions_history', 'sessions_send', 'sessions_spawn', 'web_search', 'web_fetch']) {
    assert.ok(policy.tools.deny.includes(denied));
  }
});

test('finance health executable rejects arguments and contains no secret material', async () => {
  const executable = await readFile(path.join(repositoryRoot, 'bin/mira-finance-health'), 'utf8');
  assert.match(executable, /process\.argv\.length !== 2/);
  assert.doesNotMatch(executable, /client_secret|refresh_token|private_key|folderId|@gmail\.com/i);
});
