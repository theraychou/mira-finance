# Phase F12 boundary

## Included

- Receipt intake from the private workspace inbox for PDF, JPEG, PNG, and WebP files
- Magic-byte MIME validation, a 10 MiB limit, SHA-256 hashing, and immutable private original-file preservation
- Deterministic PDF text extraction and optional bounded Tesseract OCR when the binary is available
- Advisory receipt field extraction with Ray-confirmed final values
- MYR, SGD, and USD claims using integer minor units and no currency conversion
- Controlled expense categories and an optional client/project field
- Exact duplicate blocking and probable duplicate warnings
- Versioned claim drafts, expiring confirmations, collision-free claim numbering, Drive filing, append-only attempts, audit events, and a claim register
- A fail-closed administrator CLI for intake, revision, confirmation, filing, and register reads

## Explicitly not included

- Automatic trust in OCR or AI-extracted fields
- Automatic WhatsApp attachment mutation tools or customer communications
- Supplier invoice processing, payments, banking integration, tax calculation, reconciliation, credit notes, or F13+ reporting/export features
- Deletion of original receipts or completed audit events
- Changes to Jessie, another agent, existing bindings, sessions, OAuth identity, Gmail, Calendar, Notion, or coaching memory

