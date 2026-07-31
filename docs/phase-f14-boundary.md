# Phase F14 boundary

## Included

- Monthly and annual summaries with MYR, SGD, and USD kept separate
- Quotation, invoice, claim, outstanding, overdue, and expense-by-category reports
- Exact date, status, currency, and customer filtering with explicit cancellation and failed-issuance treatment
- Deterministic CSV and styled XLSX exports whose totals reconcile to the ledger
- Client/company recharge assignments for filed claims, explicit approval, confirmed attachment to an unissued invoice draft, and immutable claim-to-line links
- Monthly company claim-submission ZIP packs containing a summary and immutable supporting receipt copies; packs become `READY`, and a separate manual acknowledgement can record `SUBMITTED`
- Append-only audit records and private generated artifacts

## Explicitly not included

- Automatic customer delivery, WhatsApp mutation tools, email sending, payments, banking, reconciliation, credit notes, cancellations, replacements, or F15+ hardening
- Currency conversion or mixed-currency totals
- Live Google Sheets mirroring; it remains optional and disabled because no Sheets-specific authorization was approved
- Changes to Jessie, other agents, routing, sessions, OAuth identity, Gmail, Calendar, Notion, or coaching memory
