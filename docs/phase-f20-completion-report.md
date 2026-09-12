# Phase F20 completion report

Completed 2026-09-12.

## Outcome

- Confirmed invoice DOCX/PDF artifacts are stored only in stable per-customer folders beneath the approved `rc_finance` Google Drive root.
- Production rendering and Drive-backed delivery use `/dev/shm`, verify hashes, and remove RAM staging in all outcomes.
- The private SQLite ledger remains authoritative and records storage backend, file names, Drive references, hashes, and append-only attempts.
- All three current customers have mapped Drive folders.
- The live operational ledger has no locally stored issued invoices.
- Six legacy `TEST / NOT VALID` pilot invoice files were re-verified against their existing Drive uploads and removed from the server. No non-test invoice was involved.
- The server invoice output tree contains zero non-hidden files.
- Jessie, other agents, their routing, sessions, workspaces, and unrelated Drive content were not modified.

## Verification

- Local test suite: 139 passed, 2 expected Windows LibreOffice skips, 0 failed.
- Production test suite: 141 passed, 0 failed, 0 skipped.
- Production database integrity passed at schema version 14.
- Production health check passed; one prior redacted alert remains marked `ATTENTION` and does not make health fail.
- `/dev/shm` was verified as `tmpfs`.
- OpenClaw plugin doctor reported no plugin issues.
- Workspace permissions remain private and the workspace contains no symlinks.

## Recovery

Pre-deployment private backups were created for the operational ledger, the pilot ledger, and Git state. Invoice files were deliberately not copied into a new server backup. The Drive copies are the recovery source for removed invoice artifacts.
