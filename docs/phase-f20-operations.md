# Phase F20 operations

```text
npm run db:migrate
npm run customer-folders -- --admin --actor operator
npm run invoices:drive-only:migrate -- --admin --actor operator
npm run db:check
npm run health
npm test
```

The migration verifies source hashes, uploads and verifies both files, commits their Drive references, and only then removes those exact local copies. It fails if any unaccounted invoice file remains.

On Linux, `/dev/shm` must be a tmpfs. New issuance and Drive-backed delivery fail closed when RAM staging is unavailable. Never substitute `/tmp` or a workspace directory.
