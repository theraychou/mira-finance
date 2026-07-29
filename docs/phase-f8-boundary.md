# Phase F8 boundary

## Included

- Private configuration containing the approved Google identity, dedicated CLI client profile, Finance root folder ID, and per-document destination IDs
- Strict rejection of destinations outside the approved Finance root
- Non-interactive Google CLI adapter restricted to the Drive command group
- Live approved-folder metadata health check with redacted output
- Explicit upload of both DOCX and PDF for issued quotations and invoices
- Local SHA-256 verification before upload and remote size verification after upload
- Remote MD5 verification when Drive metadata supplies a checksum
- Persistent Drive file IDs on quotation/invoice records and the upload ledger
- Exact-name duplicate detection and idempotent repeat calls
- Durable retry scheduling with deterministic exponential backoff for transient errors
- Append-only upload-attempt and audit history
- Local-file preservation for every Drive failure

The uploader never deletes, moves, renames, shares, or changes permissions on Drive files. Upload is an explicit operation and does not send documents to customers.

## Explicitly not included

- OpenClaw agent registration or skill/tool policy
- WhatsApp binding, routing, parsing, or messages
- Customer sending or other outbound communication
- Automatic payment reconciliation
- Claims, receipts, supplier invoices, credit notes, or later finance workflows
- Any change to Jessie, Gmail, Calendar, Notion, coaching memory, existing agents, or existing channel bindings

## Authentication boundary

OAuth credentials and tokens remain outside the repository. Mira uses a dedicated `mira-drive` Google CLI profile so existing Gmail and Calendar token buckets are not overwritten. Google does not provide a folder-only OAuth scope for an existing arbitrary folder; destination enforcement therefore occurs in deterministic application code and the CLI is restricted to Drive commands for this workflow.
