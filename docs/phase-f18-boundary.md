# Phase F18 boundary

## Included

- Two optional OpenClaw tools for standalone invoice preparation and confirmed issuance
- Availability only to Ray in the existing dedicated `RC Finance` WhatsApp group
- Exact active-customer resolution by customer code, approved alias, or unique exact name
- Deterministic selection of the configured currency template, default bank profile, and linked active business entity
- Decimal major-unit price parsing into integer minor units without binary floating-point finance calculations
- One to seven invoice lines, deterministic due-date and total calculation, and no-tax invoices only
- Numbering initials bound into the immutable draft and one-use confirmation token
- Immutable local DOCX/PDF issuance only after Ray confirms the exact token
- Additive OpenClaw configuration with an owner-only backup and unchanged bindings

## Fail-closed rules

- Unknown, inactive, fuzzy, or ambiguous customers do not create a draft.
- A currency mismatch, missing template, missing default bank profile, inactive business entity, missing billing address, or required purchase order blocks preparation.
- Missing or unsafe numbering initials block preparation. A customer code is used only when it already matches the approved 1-8 uppercase alphanumeric format.
- Tax modes other than `NONE`, discounts, more than seven lines, invalid quantities, and malformed prices are rejected.
- A draft receives no official number. Confirmation is bound to the authorised requester, RC Finance context, draft hash, and expiry.
- Issuance never uses the broad `message` or `exec` tool and does not automatically send the document to a customer.

## Not included

- Invoice creation from quotation through WhatsApp
- Draft revision, cancellation, payment recording, credit notes, refunds, or write-offs through WhatsApp
- Tax calculation or tax-treatment inference
- Automatic Drive upload or automatic customer delivery
- New-customer, bank, tax, template, numbering, or OpenClaw configuration changes through chat
- Changes to Jessie, other agents, their routes, sessions, memory, skills, or workspaces
