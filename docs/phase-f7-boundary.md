# Phase F7 boundary

## Included

- Standalone invoice drafts and full invoice conversion from an issued quotation
- Deterministic due-date calculation from integer payment-term days
- Purchase-order capture and required-PO validation
- One invoice per source quotation; partial invoice-from-quotation is explicitly rejected in F7
- Invoice confirmation bound to user, source channel, source chat, expiry, and immutable draft hash
- Transactional invoice numbering using `YYMMDD1001-{CLIENT_INITIALS}`
- Deterministic rendering from the protected currency-specific invoice template
- Local immutable DOCX/PDF filing under `generated/invoices/YYYY/MM/`
- Explicit payment-status drafts and one-use confirmation tokens
- Partial and full payment recording, balance calculation, overpayment blocking, paid-date recording, and append-only payment history

All generated acceptance-test documents display `TEST / NOT VALID`. Money remains integer minor units and tax remains disabled.

## Explicitly not included

- Automatic customer sending or any outbound communication
- Automatic payment reconciliation or bank-feed integration
- Partial invoice-from-quotation, progress billing, credit notes, refunds, or write-offs
- Google Drive upload or authentication
- WhatsApp binding, routing, parsing, or messages
- Claim, receipt, or supplier-invoice workflows
- OpenClaw agent registration, configuration changes, or service changes

## Known presentation limitation

The protected invoice templates do not provide a dedicated purchase-order placeholder. F7 records and validates the purchase-order number in the immutable draft snapshot and invoice ledger, but does not inject it into an unrelated template field. Adding a visible PO field requires a separately approved template revision.
