# OpenClaw Finance Agent (Mira)

This repository contains the isolated workspace for Mira, the future OpenClaw Finance Agent.

## Current phase

Phase F14 - Reporting and Export.

Mira is registered as an isolated OpenClaw agent and the dedicated RC Finance group routes only to her. All earlier quotation, invoice, Drive, pilot, receipt, claim, and supplier-invoice workflows remain intact. F14 adds deterministic finance reports, CSV/XLSX exports, approved claim-to-client recharge assignments, explicit confirmation before a recharge becomes an invoice line, immutable invoice links, and monthly company claim-submission packs. Live Google Sheets mirroring, automatic delivery, payment actions, reconciliation, and F15 credit-note or cancellation work remain unavailable.

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
npm run drive:health
npm run drive:upload -- --type quotation --id 1 --actor operator
npm run drive:upload -- --retry-due --actor operator
npm run pilot:f11 -- --admin --test-mode --live-drive
npm run claims -- --admin --action intake --actor operator --input data/pending/claim-input.json
npm run claims -- --admin --action register --actor operator
npm run supplier-invoices -- --admin --action supplier-list
npm run supplier-invoices -- --admin --action intake --actor operator --input data/pending/supplier-invoice-input.json
npm run supplier-invoices -- --admin --action register
npm run reports -- --admin --action report --input data/pending/report-input.json
npm run reports -- --admin --action export --actor operator --input data/pending/report-input.json
npm run reports -- --admin --action recharge-register
npm run reports -- --admin --action claim-pack-register
npm run registry -- currencies list
npm run health
npm test
```

The foundation health check exits successfully when the F14 configuration is healthy. The separate Drive health check validates live access to the approved folder without printing its identity or folder ID. WhatsApp routing remains configured only for RC Finance, while Mira's chat tool surface remains read-only health access.

The private runtime ledger is `data/finance.sqlite3`. It is excluded from Git. The F11 pilot uses the separate ignored ledger `data/pilots/f11-pilot.sqlite3`. Document numbers are allocated transactionally in the approved `YYMMDD1001-{CLIENT_INITIALS}` format using one collision-free daily sequence across document types.

Registry mutations are local administrator operations. Commands that create or change customers, entities, banks, taxes, or currencies require `--admin --actor <administrator>` and a workspace-local JSON input file. Bank-profile output is always redacted.

Normalized finance documents are A4 portrait. Amount columns and totals are right aligned, quantity is centered, and generated copies remove unused trailing item rows while retaining a seven-item maximum.

Drive destinations are stored in the ignored, private `config/drive-folders.json`. The uploader invokes the installed Google CLI non-interactively with only the Drive command group enabled, never deletes remote files, and preserves local artifacts on every failure.

The F11 pilot is fail-closed: it requires `--admin --test-mode --live-drive`, refuses to overwrite an existing pilot ledger, uses only synthetic `TEST / NOT VALID` records, and keeps currency totals separate with no conversion.

F12 accepts only regular files inside `data/claims/inbox`, validates their bytes rather than trusting extensions, enforces a 10 MiB limit, preserves originals under content-addressed private paths, and blocks exact duplicates. Probable matches are warnings. PDF extraction uses `pdftotext`; image OCR uses Tesseract only when installed and otherwise leaves advisory fields incomplete for Ray to supply. A claim is numbered and filed to the approved Drive root only after explicit confirmation.

F13 applies the same untrusted-attachment controls to `data/supplier-invoices/inbox`. Every document must be explicitly classified as `SUPPLIER_INVOICE`; extracted supplier, invoice number, dates, category, allocation, currency, and totals remain advisory until Ray approves them. Supplier invoices use their vendor-provided numbers and a separate register—never Mira's outgoing invoice sequence. Filing uploads only the preserved source to the already approved Drive root and performs no payment action.

F14 reports include monthly and annual summaries, quotation and invoice registers, outstanding and overdue balances, claim registers, and expenses by category. All filters use explicit half-open date boundaries and keep MYR, SGD, and USD totals separate. CSV and XLSX exports are immutable ledger events; test exports are marked `TEST / NOT VALID`. The optional Google Sheets mirror remains disabled and no additional Google authorisation is requested.

A filed claim may be assigned to a specific active company and optional project, then approved by Ray. Adding it to an outgoing invoice requires a separate, context-bound confirmation and creates an immutable claim-to-invoice-line link. Monthly company claim packs contain a deterministic summary and hash-verified copies of supporting receipts. Generation marks a pack `READY`; only a separate manual acknowledgement records it as `SUBMITTED`. F14 does not send it.

## Security

Never commit credentials, OAuth material, bank details, customer information, finance databases, templates, generated documents, or operational logs. This repository is currently public; only public-safe code, redacted mappings, and documentation may be pushed.

See `AGENTS.md` for mandatory implementation boundaries.
