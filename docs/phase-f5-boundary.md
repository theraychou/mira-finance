# Phase F5 boundary

## Included

- Structured quotation-draft input schema
- Deterministic line-item calculation using rational decimal quantities and integer minor units
- Fixed and basis-point percentage discounts with documented half-up rounding
- Explicit non-taxable drafts and registry-backed exclusive tax calculations
- UTC calendar validity-date calculation
- Transactional draft persistence and immutable version snapshots
- Deterministic text previews clearly marked `QUOTATION DRAFT — NOT ISSUED`
- Random, expiring confirmation tokens bound to an immutable draft-version hash
- Automatic expiry and invalidation when a draft changes
- Incomplete-draft issue reporting and confirmation blocking

No production customer, business-entity, bank, or tax data is seeded by this phase. Tax tests use only temporary synthetic rules marked `TEST / NOT VALID`.

## Explicitly not included

- Official quotation-number allocation
- DOCX or PDF quotation rendering or issuance
- Google Drive upload
- WhatsApp parsing, routing, binding, or messages
- Confirmation execution or issued-state transition
- Invoice, claim, receipt, or supplier-invoice workflows
- OpenClaw agent registration or service changes

The existing document-generation, Google Drive, and WhatsApp feature flags remain disabled.

## Calculation policy

- Money is stored and calculated only in integer minor units.
- Quantities are parsed as decimal strings into integer numerator/scale pairs.
- Fractional minor-unit results are rounded half up.
- Discounts are applied before tax.
- F5 supports explicit `NONE` tax mode or an active, effective `EXCLUSIVE` registry rule.
- Inclusive tax remains unsupported because the current ledger total constraint models tax as additive.
