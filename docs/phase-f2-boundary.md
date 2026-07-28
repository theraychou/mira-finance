# Phase F2 boundary

## Included

- Six-template inventory and immutable source hashes
- Separate quotation and invoice templates for MYR, SGD, and USD
- Currency-to-template and currency-to-bank-profile mappings
- Deterministic placeholder normalisation and validation
- Synthetic fixture rendering marked `TEST / NOT VALID`
- Multi-line item, long-address, overflow, zero-tax, and non-zero-tax rejection tests
- Visual comparison of source and test outputs
- A4 portrait enforcement, monetary/quantity alignment, and compact short-document pagination

## Explicitly not included

- Official document numbers or numbering allocation
- Database or migrations
- Customer registry or live customer data
- Tax rules or non-zero tax rendering
- Google Drive upload or authentication
- OpenClaw agent registration
- WhatsApp routing, commands, or messages
- Production issuance, ledger commits, or customer delivery

The supplied DOCX files and generated output remain outside the public Git repository.
