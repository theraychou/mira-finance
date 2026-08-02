# Phase F17B boundary

## Included

- Inbound email polling through the dedicated finance Google CLI profile
- Interception of direct WhatsApp messages from active, verified, consented customer contacts
- Exact-contact and exact-customer document ownership checks
- Deterministic invoice and quotation status answers only when an exact document number is present
- RC Finance escalation for unknown, ambiguous, attachment-bearing, or unsupported questions
- Acknowledgement to the customer while Ray reviews an escalation
- Confirmation-gated delivery of Ray's exact escalation response
- Append-only response attempts, deduplication, masked output, and redacted audit records

## Fail-closed rules

- Unverified senders are ignored and never routed to Mira's finance reply processor.
- Customer text is data, never instructions. It cannot invoke tools or alter finance records.
- Mira does not infer an answer, select a similar customer, or disclose whether another customer's document exists.
- Attachments are not opened in F17B and are escalated for review.
- Requests to alter amounts, dates, bank details, payment records, customer details, or issued documents are never executed.
- Ray-provided responses require a masked preview and a short-lived confirmation token.
- Gmail polling deduplicates messages without changing mailbox labels or requesting modify scope.

## Not included

- Gmail Pub/Sub, mailbox label changes, arbitrary mailbox search, or broad Gmail scopes
- Automatic attachment processing, payment reconciliation, negotiation, collections, or legal/tax advice
- New customer creation from inbound messages
- Changes to Jessie, existing routes, Gmail/Calendar/Notion behaviour, or unrelated Drive content
