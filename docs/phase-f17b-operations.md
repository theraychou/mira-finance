# Phase F17B inbound reply operations

Keep `config/customer-inbound.json` private and disabled until the dedicated mailbox authorization and verified-contact pilot are ready.

The Gmail profile needs only message read access and send access. The polling query is fixed in private configuration, results are bounded, and processed provider IDs are deduplicated in SQLite. No Gmail labels are changed.

Direct WhatsApp replies are handled only when the sender exactly matches an active verified WhatsApp delivery contact with recorded consent. Existing bindings remain unchanged. Known exact-document status questions receive deterministic ledger answers. All other questions receive a neutral acknowledgement and an RC Finance escalation token.

Ray answers an escalation in RC Finance using the prepare tool. Mira displays the masked destination, exact response, and confirmation token. Only the confirm tool sends that unchanged response.
