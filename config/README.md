# Configuration

`foundation.json` is a non-secret Phase F17B project foundation record. It is not an OpenClaw agent configuration and does not enable any integration. `claim-categories.json` contains public-safe deterministic category mappings only.

Customer, entity, currency, bank, tax, and claim records are stored in private SQLite ledgers. Bank, tax, and claim mutations require the local administrator CLI. Sensitive registry values and receipt originals must never be committed. Drive and WhatsApp routing configuration remain in ignored private files. The F11 pilot remains in a separate ignored ledger.

F17A customer delivery configuration is stored in ignored `config/customer-delivery.json`. Customer destinations and consent records remain in the private ledger. OAuth credentials and tokens stay in the external Google CLI credential store. Do not enable delivery until the dedicated sender and controlled pilot are ready.

F17B inbound customer configuration is stored in ignored `config/customer-inbound.json`. It remains disabled until the dedicated Gmail read/send authorization and a verified-contact pilot are complete. Unknown, ambiguous, attachment-bearing, or state-changing requests are escalated to RC Finance; they are never answered from model inference.
