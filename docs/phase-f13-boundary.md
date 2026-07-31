# Phase F13 boundary

## Included

- A supplier registry with exact code/alias lookup and administrator-controlled changes
- Explicit incoming supplier-invoice classification that cannot create or alter an outgoing invoice
- Private PDF, JPEG, PNG, and WebP intake with magic-byte validation, SHA-256 hashing, and immutable original preservation
- Deterministic PDF text extraction and optional bounded Tesseract OCR, with all extracted fields treated as advisory
- Ray-approved supplier, vendor invoice number, issue/due dates, category, project allocation, currency, and integer-minor-unit totals
- Exact duplicate blocking, probable duplicate warnings, versioned drafts, expiring approvals, Drive filing, append-only attempts, and a separate supplier-invoice register
- A fail-closed administrator CLI; supplier-invoice mutations are not exposed as OpenClaw or WhatsApp tools

## Explicitly not included

- Automatic payment, banking integration, payment instructions, tax calculation, reconciliation, or F14+ reports/exports
- Outgoing invoice creation or Mira document-number allocation for supplier invoices
- Automatic trust in OCR or extracted fields
- Changes to Jessie, other agents, existing routes, sessions, OAuth identity, Gmail, Calendar, Notion, or coaching memory
