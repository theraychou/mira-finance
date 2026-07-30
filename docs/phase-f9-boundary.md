# Phase F9 boundary

## Included

- Separate OpenClaw agent ID `mira-finance` with display name `Mira`
- Dedicated workspace `/root/.workspaces/mira-finance`
- Explicit per-agent skill allowlist containing only `mira-finance`
- Workspace-only file reads and a deny-by-default command policy
- One no-argument, read-only finance health plugin tool
- Disabled elevated, messaging, session, browser, gateway, node, and web tools
- Configuration, skill visibility, workspace isolation, health, and existing-agent regression checks

Docker is not installed on the host, so F9 uses OpenClaw's workspace-only filesystem guard and exposes no command-execution tool to Mira. The OpenClaw service continues to run under the existing OS account; this is application-level isolation, not a separate Unix user or container boundary.

## Explicitly not included

- WhatsApp group discovery, binding, allowlists, routing, parsing, or messages
- Customer communications or automatic document sending
- New document, ledger, Drive, claim, receipt, supplier-invoice, or reconciliation behaviour
- Changes to Jessie or any existing agent, skill, session, binding, workspace, or integration
- Docker, package installation, service restart, or a new OS account
