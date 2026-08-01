# Phase F16 boundary

## Included

- Verified SQLite-safe backups and full restore drills in an isolated test location
- Database integrity, private-permission, dependency, disk-reserve, and configuration audits
- Recovering stale `GENERATING` quotation, invoice, and credit-note issuances without reusing numbers
- Retrying failed quotation, invoice, and credit-note rendering with the original confirmed snapshot and number
- Bounded JSONL log rotation, scoped temporary-file cleanup, and redacted operational failure alerts
- Operations, recovery, and security guides plus F16 acceptance tests

## Explicitly not included

- Automatic customer email or WhatsApp delivery
- Payment processing, banking, reconciliation, reminders, payroll, tax filing, or currency conversion
- Automatic credit-note issuance or additional approval levels
- Changes to Jessie, other agents, routing, OAuth, Gmail, Calendar, Notion, or coaching memory
