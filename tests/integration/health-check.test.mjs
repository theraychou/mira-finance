import test from 'node:test';
import assert from 'node:assert/strict';
import { runHealthCheck } from '../../scripts/health-check.mjs';

test('health check passes with F7 local workflows and external integrations absent', async () => {
  const report = await runHealthCheck({ env: {} });
  assert.equal(report.healthy, true);
  assert.equal(report.phase, 'F7');
  const optional = report.checks.filter((item) => item.name.startsWith('optional:'));
  assert.equal(optional.length, 4);
  assert.equal(optional.find((item) => item.name === 'optional:document-templates').status, 'CONFIGURED');
  assert.notEqual(optional.find((item) => item.name === 'optional:database').status, 'FAIL');
  assert.ok(optional
    .filter((item) => !['optional:document-templates', 'optional:database'].includes(item.name))
    .every((item) => item.status === 'NOT_CONFIGURED'));
});

test('health check does not print or require credential values', async () => {
  const report = await runHealthCheck({
    env: {
      MIRA_GOOGLE_IDENTITY: 'test.operator@example.invalid',
      MIRA_DRIVE_ROOT_FOLDER_ID: 'TEST_FOLDER_ID',
      MIRA_WHATSAPP_GROUP_ID: '120000000000000000@g.us'
    }
  });
  const serialised = JSON.stringify(report);
  assert.doesNotMatch(serialised, /test\.operator|TEST_FOLDER_ID|120000000000000000/);
});
