# OpenClaw Finance Agent (Mira)

This repository contains the isolated workspace for Mira, the future OpenClaw Finance Agent.

## Current phase

Phase F6 - Quotation Issuance.

The workspace foundation, protected templates, SQLite ledger, numbering engine, controlled finance registries, quotation drafts, and local quotation issuance are present. Confirmed quotations can be assigned an official number and rendered locally to immutable DOCX/PDF files. Mira is not registered as an OpenClaw agent. WhatsApp, Google Drive, customer sending, and non-quotation workflows remain intentionally unconfigured.

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
npm run registry -- currencies list
npm run health
npm test
```

The health check exits successfully when the F4 foundation is healthy. After migration, the database and templates report `CONFIGURED`; Drive and WhatsApp remain `NOT_CONFIGURED`.

The private runtime ledger is `data/finance.sqlite3`. It is excluded from Git. Document numbers are allocated transactionally in the approved `YYMMDD1001-{CLIENT_INITIALS}` format with separate daily sequences for quotation, invoice, claim, and credit-note records.

Registry mutations are local administrator operations. Commands that create or change customers, entities, banks, taxes, or currencies require `--admin --actor <administrator>` and a workspace-local JSON input file. Bank-profile output is always redacted.

Normalized finance documents are A4 portrait. Amount columns and totals are right aligned, quantity is centered, and generated copies remove unused trailing item rows while retaining a seven-item maximum.

## Security

Never commit credentials, OAuth material, bank details, customer information, finance databases, templates, generated documents, or operational logs. This repository is currently public; only public-safe code, redacted mappings, and documentation may be pushed.

See `AGENTS.md` for mandatory implementation boundaries.
