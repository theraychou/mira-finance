# Phase F4 boundary

## Included

- Customer create, update, deactivate, exact lookup, alias lookup, and fuzzy-selection support
- Customer readiness checks for active status, legal name, billing address, purchase orders, and currency mismatch
- Business-entity registry
- MYR, SGD, and USD currency configuration linked to the approved template IDs
- Private bank-profile registry with redacted output
- Empty tax-rule registry with no production tax rule enabled
- Administrator-only mutation commands
- Append-only, hash-based registry audit events without sensitive values in audit details

## Explicitly not included

- Customer creation or registry changes through WhatsApp
- Automatic acceptance of fuzzy customer matches
- Production customer, entity, bank, or tax data seeding
- Quotation, invoice, or claim drafts
- Confirmation tokens or document issuance
- Google Drive integration
- OpenClaw agent registration or routing
- WhatsApp binding or messages

Sensitive registry data remains inside the ignored, mode-600 SQLite database.
