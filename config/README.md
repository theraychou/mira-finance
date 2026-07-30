# Configuration

`foundation.json` is a non-secret project foundation record. It is not an OpenClaw agent configuration and does not enable any integration.

Customer, entity, currency, bank, and tax registries are stored in private SQLite ledgers. Bank and tax changes require the local administrator CLI. Sensitive registry values must never be committed. Drive and WhatsApp routing configuration remain in ignored private files. The F11 pilot uses a separate ignored ledger and does not modify production registry data.
