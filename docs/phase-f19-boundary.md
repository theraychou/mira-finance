# Phase F19 boundary

## Included

- Ray-only customer listing in the existing dedicated `RC Finance` WhatsApp group
- Confirmation-gated creation, modification, and deactivation of customer registry records
- Exact customer-code targeting and duplicate-name checks before mutations
- Invoice-readiness validation for new customer records
- Immutable audit hashes for every confirmed customer change
- One-way Google Sheets mirror sourced only from the private SQLite ledger
- Explicit private configuration for the selected Google Drive folder and Google identity
- Automatic mirror refresh after confirmed customer changes, plus an administrator retry command
- Preservation of the existing Mira agent, finance binding, invoice workflow, delivery controls, and broad tool denials

## Fail-closed rules

- Only Ray in `RC Finance` can use the customer tools.
- Customer changes require an exact short-lived token bound to Ray, the group, the requested payload, and the current customer hash.
- Customer codes are never guessed or modified. Create requires a unique 2-20 character uppercase code.
- New customers require legal name, display name, billing address, enabled currency, payment terms, tax treatment, and an explicit purchase-order policy.
- Update and deactivation fail when the customer changed after the preview.
- Update and deactivation are blocked while an invoice or quotation for that customer is awaiting confirmation or generation.
- “Remove” means deactivate. Customer records and historical finance documents are never deleted.
- The Google Sheet never writes back to the ledger. Sheet edits are overwritten by the next successful synchronization.
- Mirror failures do not roll back an already confirmed ledger mutation; they are recorded with a redacted error code and remain retryable.
- No customer data, folder IDs, spreadsheet IDs, OAuth credentials, or tokens are committed to Git or written to ordinary logs.

## Not included

- Customer creation or modification by any sender other than Ray
- Customer administration from any WhatsApp chat other than `RC Finance`
- Hard deletion, merging, reactivation, or customer-code changes
- Google Sheet to SQLite imports or two-way synchronization
- Public sharing or management of Google Drive permissions
- Notion mirroring
- Changes to Jessie, other agents, their bindings, sessions, memory, skills, or workspaces
