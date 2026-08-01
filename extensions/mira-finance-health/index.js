import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { runHealthCheck } from '../../scripts/health-check.mjs';
import { runDriveHealthCheck } from '../../scripts/drive-health-check.mjs';

export default definePluginEntry({
  id: 'mira-finance-health',
  name: 'Mira Finance Health',
  description: 'Exposes one redacted, read-only health check for Mira.',
  register(api) {
    api.registerTool({
      name: 'mira_finance_health',
      description: 'Run Mira Finance workspace, database, template, and approved Drive health checks.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      async execute() {
        const [workspace, drive] = await Promise.all([
          runHealthCheck(),
          runDriveHealthCheck()
        ]);
        const result = {
          healthy: workspace.healthy && drive.healthy,
          phase: workspace.phase,
          checks: {
            workspace: workspace.healthy ? 'PASS' : 'FAIL',
            database: workspace.checks.find((item) => item.name === 'optional:database')?.status ?? 'FAIL',
            templates: workspace.checks.find((item) => item.name === 'optional:document-templates')?.status ?? 'FAIL',
            googleDrive: drive.healthy ? 'PASS' : 'FAIL',
            alerts: workspace.checks.find((item) => item.name === 'operations:failure-alerts')?.status ?? 'FAIL',
            whatsApp: workspace.checks.find((item) => item.name === 'optional:whatsapp')?.status ?? 'FAIL',
            customerDelivery: workspace.checks.find((item) => item.name === 'optional:customer-delivery')?.status ?? 'NOT_CONFIGURED'
          }
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }]
        };
      }
    });
  }
});
