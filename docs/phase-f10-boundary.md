# Phase F10 boundary

## Included

- One dedicated WhatsApp group binding from `RC Finance` to `mira-finance`
- Existing WhatsApp account and group configuration preserved, with one additive group entry
- Dedicated-group activation policy
- Exactly one authorised sender for draft and confirmation operations in F10
- Default-deny per-sender tool policy for all other group members
- Deterministic group, sender, activation, and permission validation
- Fingerprinted command-source metadata suitable for existing draft and audit fields
- Routing, wrong-group, wrong-sender, wrong-token, existing-binding, and no-issuance regression checks

## Explicitly not included

- Sending WhatsApp setup or test messages
- Customer communications or automatic document sending
- New parsing, attachment, claim, receipt, supplier-invoice, credit-note, reporting, or reconciliation workflows
- Any modification to Jessie Notes or another existing group binding
- Any official document issuance during routing validation
