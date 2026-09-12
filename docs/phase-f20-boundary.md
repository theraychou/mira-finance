# Phase F20 — Drive-only invoice storage

Phase F20 stores every confirmed outgoing invoice DOCX and PDF in Google Drive beneath the already approved `rc_finance` folder. Mira creates one stable folder per customer and records its Drive identifiers in the private SQLite ledger.

Final invoice files must not persist in Mira's server workspace. Rendering and customer delivery may use `/dev/shm` only, must verify the artifact hash, and must remove RAM staging in all outcomes. An invoice becomes `ISSUED` only after both Drive files are uploaded and verified.

The private SQLite ledger remains on Mira's server because it is authoritative for customers, numbering, confirmations, hashes, Drive references, and audit history. Quotations and earlier workflow boundaries are unchanged. Nothing authorises access to Jessie's workspace or unrelated Drive content.

- A customer has exactly one ledger-mapped folder directly beneath the approved Drive root.
- A later customer rename does not rename or move an existing folder.
- Deactivation never deletes its folder or invoices.
- An ambiguous same-name folder fails closed.
- Partial uploads remain for exact-name, hash-verified retry; local disk is never a production fallback.
