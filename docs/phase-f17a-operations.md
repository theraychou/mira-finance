# Phase F17A outbound delivery operations

Run from `/root/.workspaces/mira-finance` with `umask 077`. Private configuration and OAuth tokens are never committed.

## Private configuration

Copy `config/customer-delivery.example.json` to the ignored `config/customer-delivery.json`, then set the dedicated finance sender, Google CLI client profile, enabled channels, and approved signature. Keep `enabled` false until the mailbox OAuth and controlled pilot are ready.

## Contact administration

Create and deactivate contacts only through the administrator CLI. Input JSON must be workspace-local. Email contacts require a verified address. WhatsApp contacts additionally require consent time and source. Command output is masked.

```text
npm run delivery -- contact create --admin --actor operator --input data/pending/delivery-contact.json
npm run delivery -- contact list --customer-id 1
npm run delivery -- contact deactivate --id 1 --admin --actor operator
```

## Manual delivery fallback

The local CLI uses the same ledger and confirmation rules as the agent tools:

```text
npm run delivery -- delivery prepare --document-type invoice --document-number TEST-NOT-VALID --admin --actor operator
npm run delivery -- delivery confirm --token DL-TEST-NOT-VALID --admin --actor operator
```

Email remains the default. Add `--channel WHATSAPP` only for an explicitly requested, consented WhatsApp delivery. Never pass a destination on the command line.

## Interrupted or failed attempts

- `FAILED`: inspect the redacted error code. Prepare a new request only after resolving the cause; add a resend reason if a prior send is recorded.
- `SENDING`: do not retry automatically. Check the provider/account manually because the provider may have accepted the message before the ledger update was interrupted.
- `SENT`: immutable attempt record. A resend requires a new confirmation and reason.
