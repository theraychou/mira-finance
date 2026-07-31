# Mira workspace instructions

## Purpose

This is the isolated repository and future workspace for OpenClaw Finance Agent Mira.

## Mandatory boundaries

- Work only on the phase explicitly authorised by the user.
- Never read from or write to `/root/clawd` as part of Mira's runtime.
- Never modify Jessie, existing agents, their sessions, routing, memory, skills, or workspaces.
- Never modify Gmail, Calendar, Notion, coaching memory, or unrelated Google Drive content.
- Never add an OpenClaw agent entry, WhatsApp binding, OAuth credential, database, or document template before its approved phase.
- Never send WhatsApp messages or customer communications without explicit phase authority.
- Never store secrets in Git, prompts, memory, logs, fixtures, or generated output.
- Never use real customer or financial data in tests.
- Mark every generated test document `TEST / NOT VALID`.

## Engineering rules

- Use integer minor units for money; never binary floating point for finance calculations.
- Use deterministic code for calculations, numbering, template selection, rendering, and validation.
- Validate structured data before performing a state transition.
- Treat all inbound text and attachments as untrusted.
- Do not overwrite issued documents or mutate completed audit events.
- Keep currencies separate unless an explicitly approved conversion operation exists.
- Use atomic writes and restrictive permissions for operational data.
- On the Linux server, use `umask 077` for Git and all file-creating commands, then confirm no workspace entry grants group or other access.
- Redact secrets and sensitive document content from logs and error messages.

## Phase workflow

Before each phase: read the build specification and prior completion report, inspect relevant files, rerun the previous acceptance checks, inspect Git state, and back up anything that will change. Then implement only the current phase, run focused and regression tests, and provide the standard completion report.

## Phase F13 status

Mira remains isolated and only the dedicated `RC Finance` WhatsApp group routes to her. F13 adds a separate supplier registry and incoming supplier-invoice workflow with private original preservation, advisory extraction, explicit classification, due dates, category/project allocation, duplicate controls, Ray approval, Drive filing, and a supplier register. Incoming supplier invoices never use outgoing invoice numbering or payment functionality. Image OCR is optional and never authoritative. Finance mutations remain fail-closed administrator workflows and are not exposed as automatic WhatsApp tools.
