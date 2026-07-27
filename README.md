# OpenClaw Finance Agent (Mira)

This repository contains the isolated workspace for Mira, the future OpenClaw Finance Agent.

## Current phase

Phase F1 - Repository and Workspace Foundation.

The workspace foundation is present, but Mira is not registered as an OpenClaw agent and cannot process finance documents. WhatsApp, Google Drive, templates, the finance database, numbering, and document generation are intentionally unconfigured.

## Workspace

- Server path: `/root/.workspaces/mira-finance`
- Proposed OpenClaw agent ID: `mira-finance`
- Display name: `Mira`
- Repository: `theraychou/mira-finance`

This repository must remain separate from Jessie's `/root/clawd` workspace.

## Foundation commands

```text
npm run validate:config
npm run health
npm test
```

The health check exits successfully when the foundation is healthy, even when optional future integrations are absent. Missing Drive, WhatsApp, database, and template components are reported as `NOT_CONFIGURED`, not as failures.

## Security

Never commit credentials, OAuth material, bank details, customer information, finance databases, generated documents, or operational logs. This repository is currently public; only public-safe foundation code and documentation may be pushed.

See `AGENTS.md` for mandatory implementation boundaries.

