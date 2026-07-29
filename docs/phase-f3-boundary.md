# Phase F3 boundary

## Included

- SQLite ledger schema and reversible initial migration
- Business entity, customer, quotation, invoice, claim, confirmation, audit, and numbering tables
- Integer minor-unit money constraints and helpers
- Transactional daily numbering in `YYMMDD1001-{CLIENT_INITIALS}` format
- Separate sequences by document type and date
- Persistent number status history for failed and cancelled allocations
- Append-only audit-event enforcement
- SQLite-safe backup and integrity-check commands
- Concurrency, uniqueness, migration, integrity, and restore tests using synthetic data

## Explicitly not included

- Customer or configuration administration commands
- Quotation, invoice, or claim draft workflows
- Confirmation-token generation or confirmation processing
- Document rendering or official issuance
- Google Drive upload or authentication
- OpenClaw agent registration
- WhatsApp routing, commands, or messages
- Tax-rule or bank-profile administration

The runtime database and its backups are private, ignored files and must remain outside Git.
