# Configuration

`foundation.json` is a non-secret Phase F12 project foundation record. It is not an OpenClaw agent configuration and does not enable any integration. `claim-categories.json` contains public-safe deterministic category mappings only.

Customer, entity, currency, bank, tax, and claim records are stored in private SQLite ledgers. Bank, tax, and claim mutations require the local administrator CLI. Sensitive registry values and receipt originals must never be committed. Drive and WhatsApp routing configuration remain in ignored private files. The F11 pilot remains in a separate ignored ledger.
