# Mira Finance recovery guide

## Restore drill

1. Select a private backup under `data/backups`.
2. Choose a new path under `data/restore-drills`; the target must not exist.
3. Run `npm run operations -- --admin --actor <operator> --action restore-drill --backup data/backups/<backup> --target data/restore-drills/<target>`.
4. Require database integrity, zero foreign-key violations, and logical equivalence across every table.
5. Remove the drill copy after recording the result. Never point a drill at `data/finance.sqlite3`.

## Production rollback

Stop finance mutations, preserve the failed ledger and generated files, and take a forensic backup. Restore the last verified backup to a new private file, verify it, then atomically replace the live ledger during an approved maintenance window. Re-run health, Drive, routing, pilot, and document-access checks before reopening finance operations.

## Interrupted issuance

Recovery retires no new number and deletes no final document. A stale `GENERATING` record becomes `ISSUE_FAILED`; a retry reuses its existing confirmed snapshot and number. If final files already exist, stop and investigate instead of overwriting them.
