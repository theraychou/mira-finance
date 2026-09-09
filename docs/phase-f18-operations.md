# Phase F18 WhatsApp invoice operations

Run deployment commands from `/root/.workspaces/mira-finance` with `umask 077`. Phase F18 adds no database migration, private configuration, OAuth scope, agent binding, or broad tool permission.

## Preparation

Ray supplies an exact customer identifier, issue and service dates, integer payment-term days, explicit no-tax treatment, and one to seven line items. Unit prices are passed as decimal strings in major currency units. Mira calls `mira_finance_prepare_invoice` and displays the returned customer code, dates, numbering initials, line amounts, total, expiry, and token.

The tool creates a draft and pending confirmation only when every registry and template dependency is ready. No invoice number or document file exists at this point.

## Confirmation

Ray confirms the exact displayed `ID-` token. Mira then calls `mira_finance_confirm_invoice`. The existing F7 issuance workflow allocates one official number transactionally, renders and validates the DOCX/PDF, files them immutably, and consumes the token.

The result states the issued invoice number, amount, due date, and whether the PDF is ready. It does not send the document to the customer. If Ray requests delivery, use the separate F17A delivery preview and confirmation tools.

## Deployment verification

Run the F18 configuration script without `--apply` first. It must report that bindings are preserved. Apply only after the workspace tests and health check pass. The apply path creates an owner-only backup of the OpenClaw configuration before an atomic replacement.

After OpenClaw reloads the plugin, run `scripts/inspect-openclaw-f18.mjs`. It must report that both invoice tools are allowed for Mira and Ray, denied for every other sender, the plugin is enabled, broad messaging and execution remain denied, and the finance binding count remains one.

Do not issue a live test invoice. The controlled acceptance check should stop after preparing and inspecting a non-official draft unless Ray separately authorises a specific live issuance.
