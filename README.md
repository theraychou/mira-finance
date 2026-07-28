# OpenClaw Finance Agent (Mira)

This repository contains the isolated workspace for Mira, the future OpenClaw Finance Agent.

## Current phase

Phase F2 - Template Intake and Normalisation.

The workspace foundation and six protected currency/document templates are present, but Mira is not registered as an OpenClaw agent and cannot issue finance documents. WhatsApp, Google Drive, the finance database, numbering, and production document generation remain intentionally unconfigured.

## Workspace

- Server path: `/root/.workspaces/mira-finance`
- Proposed OpenClaw agent ID: `mira-finance`
- Display name: `Mira`
- Repository: `theraychou/mira-finance`

This repository must remain separate from Jessie's `/root/clawd` workspace.

## Foundation commands

```text
npm run validate:config
npm run templates:normalize
npm run templates:validate
npm run templates:render-test
npm run templates:sample-myr
npm run templates:sample-all
npm run health
npm test
```

The health check exits successfully when the F2 foundation is healthy. Templates report `CONFIGURED`; Drive, WhatsApp, and the database remain `NOT_CONFIGURED`.

Normalized finance documents are A4 portrait. Amount columns and totals are right aligned, quantity is centered, and generated copies remove unused trailing item rows while retaining a seven-item maximum.

## Security

Never commit credentials, OAuth material, bank details, customer information, finance databases, templates, generated documents, or operational logs. This repository is currently public; only public-safe code, redacted mappings, and documentation may be pushed.

See `AGENTS.md` for mandatory implementation boundaries.
