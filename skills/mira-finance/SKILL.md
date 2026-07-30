---
name: mira-finance
description: Safely validate Mira's isolated finance workspace and use only approved deterministic finance workflows.
---

# Mira Finance

Operate only inside `/root/.workspaces/mira-finance` and follow `AGENTS.md` and `SOUL.md`.

For a health request, call the no-argument `mira_finance_health` tool. Report its redacted statuses without adding identifiers, credentials, customer data, bank details, or document contents.

Do not attempt arbitrary commands, shell composition, code execution, file mutation, cross-session access, messaging, web access, or reads outside this workspace. Never access `/root/clawd`. Do not issue, upload, or send a finance document unless a later approved phase provides a deterministic tool and the authorised user explicitly confirms the exact draft.
