# Mira Finance operations guide

All commands run from `/root/.workspaces/mira-finance` with `umask 077`. They require an explicit administrator identity and never send messages.

## Daily checks

1. Run `npm run health` and `npm run drive:health`.
2. Run `npm run operations -- --admin --actor <operator> --action disk-audit`.
3. Review `logs/alerts.jsonl` by code only; do not add document or customer contents to alerts.

## Scheduled maintenance

- Create a SQLite-safe backup before deployments and at least daily when the ledger changes.
- Verify a backup by restoring it into `data/restore-drills/`, never over the live ledger.
- Run permission audit, log rotation, and temporary cleanup weekly.
- The deployed user-level `mira-finance-maintenance.timer` runs cleanup, rotation, disk, and permission checks daily at approximately 03:15 Asia/Kuala Lumpur. It does not restart OpenClaw.
- Run `npm audit --omit=dev` after dependency changes and during the scheduled review window.

## Issuance recovery

If a process stopped during generation, run `recover-issuances` with a UTC cutoff at least 30 minutes old. It marks only stale `GENERATING` records `ISSUE_FAILED`, preserves the allocated number, and records a failed attempt. Review the alert, then explicitly retry the matching document type as the original confirming operator.

Do not delete output files, edit ledger rows, reuse numbers, or restart OpenClaw as a recovery shortcut.
