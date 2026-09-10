# Phase F19 customer administration operations

Run deployment commands from `/root/.workspaces/mira-finance` with `umask 077`.

## Private mirror configuration

Copy `config/customer-sheet-mirror.example.json` to the ignored `config/customer-sheet-mirror.json`. Set the dedicated Google identity and client profile, and paste the exact destination Google Drive folder ID. Keep `enabled` false until Sheets authorization and the selected folder are verified.

The mirror creates one spreadsheet named `Mira Customer Register`, moves it into the configured folder, and stores only the resulting spreadsheet ID in the private ledger. The `Customers` tab is a one-way view. It is labeled read-only, and every successful synchronization replaces ledger-owned cells deterministically. Folder sharing controls who can view the sheet; F19 does not create or broaden Drive permissions.

Create or refresh the mirror with:

```bash
npm run customer-sheet -- --admin --actor operator --action sync
```

The command prints only status, row count, and a Google Sheets URL after success. It never prints customer rows, the folder ID, credentials, or provider errors.

## WhatsApp workflow

Ray may ask Mira in `RC Finance` to list active, inactive, or all customers. The list returns customer codes, names, currency, payment terms, PO policy, active state, and invoice-readiness status. It omits addresses, contact details, tax numbers, and notes.

For creation, Ray supplies a customer code, legal and display names, billing address, currency, integer payment terms, tax treatment, and whether a purchase order is required. Registration and billing-contact fields are optional. Mira displays the complete proposed record and a `CU-` token. The customer is created only when Ray confirms the exact token.

Modification and deactivation use the exact customer code and the same preview/confirmation flow. “Remove” is interpreted only as deactivation. Customer codes cannot be changed.

Resolve or cancel any invoice or quotation that is awaiting confirmation or generation before modifying or deactivating its customer. This prevents an already previewed document from issuing against changed legal details.

After a successful mutation, Mira attempts the Sheet refresh. The customer change remains valid if Google is temporarily unavailable; Mira reports the mirror as `FAILED` and an administrator reruns the sync command.

## Deployment verification

Run the F19 configuration script without `--apply` first. It must report preserved bindings. Apply only after migrations, tests, health checks, and private configuration validation pass. The apply path creates an owner-only backup before atomically replacing the OpenClaw configuration.

After reload, run `scripts/inspect-openclaw-f19.mjs`. It must report that all three customer tools are allowed for Mira and Ray, denied for every other sender, the plugin is enabled, the finance binding remains singular, and broad message and execution tools remain denied.

Do not create a test customer or test Google Sheet in the production ledger. Verify live customer listing first; perform the first real mutation only from user-supplied customer details and an exact confirmation.
