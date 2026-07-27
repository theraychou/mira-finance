# Phase F1 boundary

## Included

- Isolated repository and workspace foundation
- Public-safe agent behaviour documents
- Base foundation configuration and JSON Schemas
- Empty log, data, generated-output, template, and test directories
- Deterministic configuration validation
- Health reporting for intentionally absent optional integrations
- Focused and regression tests

## Explicitly not included

- OpenClaw agent registration or session configuration
- WhatsApp group discovery, allowlisting, routing, or messages
- Google OAuth, Drive access, or folder operations
- SQLite database or migrations
- Customer, bank, currency, numbering, or tax records
- Quotation, invoice, claim, supplier invoice, or ledger logic
- DOCX/PDF templates or rendering
- OCR or attachment processing

Every excluded capability remains disabled in `config/foundation.json`.

