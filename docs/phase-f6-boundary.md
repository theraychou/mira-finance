# Phase F6 boundary

## Included

- Confirmation validation bound to the requesting user, source channel, source chat, token expiry, and immutable draft hash
- Transactional official quotation-number allocation using `YYMMDD1001-{CLIENT_INITIALS}`
- Deterministic rendering from the protected currency-specific quotation template
- Normalized-template SHA-256 verification before every render
- LibreOffice DOCX-to-PDF conversion with A4, text, number, total, and banner validation
- SHA-256 hashes for issued DOCX and PDF files
- Private local filing under `generated/quotations/YYYY/MM/`
- Exclusive no-overwrite publication for issued DOCX and PDF files
- Issuance success/failure ledger state and append-only attempt history
- Retry after renderer failure while retaining the allocated number
- Cancellation that retires the number and preserves issued artifacts

All generated acceptance-test documents display `TEST / NOT VALID`. Production issuance requires complete F5 registry-backed data and does not add a test banner.

## Explicitly not included

- Google Drive upload or authentication
- WhatsApp binding, routing, parsing, or messages
- Customer sending or other outbound communications
- Invoice, claim, receipt, or supplier-invoice workflows
- OpenClaw agent registration or service changes

## Rendering and calculation constraints

- Templates remain byte-for-byte protected and are never edited during issuance.
- Rendering operates on an in-memory copy of the selected normalized template.
- The snapshot bank-profile ID must match the currency/template mapping.
- F6 supports one to seven line items and zero tax because the approved templates have no tax field.
- Rendered totals must equal the immutable draft snapshot and ledger totals.
- Failed output is removed before the ledger enters `ISSUE_FAILED`.
- Successful issued files cannot be overwritten, including by retry.
