# Phase F17A boundary

## Included

- Active, verified customer delivery contacts stored only in the private SQLite ledger
- Recorded WhatsApp consent before a WhatsApp contact can be used
- Email as the deterministic default channel; WhatsApp only when Ray explicitly selects it
- Masked delivery previews and 15-minute context-bound confirmation tokens
- Delivery of the immutable, hash-verified issued PDF only
- Dedicated Gmail send and OpenClaw WhatsApp adapters invoked without a shell
- One-attempt delivery records, hashed provider references, redacted audit events, and explicit resend reasons
- Two optional agent tools limited to preparation and confirmation from Ray in RC Finance
- Administrator-only contact mutation and recovery-oriented local CLI

## Safety rules

- The broad OpenClaw `message` tool remains denied.
- Destinations are selected only from active verified customer contacts; tool arguments cannot contain an email address or phone number.
- Cancelled, failed, unissued, changed, missing, symlinked, outside-workspace, or hash-mismatched documents cannot be delivered.
- A token is bound to the document, contact, channel, artifact hash, requester, and RC Finance context.
- A successful delivery cannot be repeated without a new request and a recorded resend reason.
- A `SENDING` record is never retried automatically because provider success may be uncertain after a process interruption.
- Logs and tool results expose masked destinations and error codes only.

## Explicitly not included

- Reading, polling, classifying, or replying to customer email
- Processing inbound customer WhatsApp messages or adding client DM bindings
- RC Finance escalation for unknown customer questions
- Automatic delivery on issuance, reminders, bulk sends, CC/BCC, marketing, or broadcasts
- DOCX delivery, arbitrary attachments, arbitrary recipients, or customer-data mutation through chat
- Gmail read/modify scopes, Pub/Sub, mailbox labels, or OAuth authentication
- Changes to Jessie, other agents, their routes, Gmail, Calendar, Notion, coaching memory, or unrelated Drive content

Inbound reply handling is reserved for Phase F17B.
