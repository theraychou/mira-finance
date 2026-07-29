# OpenClaw Finance Agent (Mira)

This repository contains the isolated workspace for Mira, the future OpenClaw Finance Agent.

## Current phase

Phase F3 - Database and Numbering Engine.

The workspace foundation, six protected currency/document templates, SQLite ledger schema, and safe numbering engine are present. Mira is not registered as an OpenClaw agent and cannot issue finance documents. WhatsApp, Google Drive, customer commands, draft workflows, and production document generation remain intentionally unconfigured.

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
npm run db:migrate
npm run db:check
npm run db:backup
npm run health
npm test
```

The health check exits successfully when the F3 foundation is healthy. After migration, the database and templates report `CONFIGURED`; Drive and WhatsApp remain `NOT_CONFIGURED`.

The private runtime ledger is `data/finance.sqlite3`. It is excluded from Git. Document numbers are allocated transactionally in the approved `YYMMDD1001-{CLIENT_INITIALS}` format with separate daily sequences for quotation, invoice, claim, and credit-note records.

Normalized finance documents are A4 portrait. Amount columns and totals are right aligned, quantity is centered, and generated copies remove unused trailing item rows while retaining a seven-item maximum.

## Security

Never commit credentials, OAuth material, bank details, customer information, finance databases, templates, generated documents, or operational logs. This repository is currently public; only public-safe code, redacted mappings, and documentation may be pushed.

See `AGENTS.md` for mandatory implementation boundaries.
