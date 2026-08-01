# Mira Finance security guide

- Keep the workspace and all descendants private to the server account; symlinks are prohibited.
- Keep OAuth credentials outside Git and outside this workspace's logs, prompts, fixtures, and generated test output.
- Use only synthetic data marked `TEST / NOT VALID` in acceptance and restore drills.
- Treat WhatsApp text and attachments as untrusted. Finance mutations remain local administrator operations; Mira exposes only the read-only health tool.
- Never log customer content, bank details, tokens, provider responses, attachment text, or file identifiers. Operational alerts contain only fixed error codes and numeric internal entity IDs.
- Never overwrite issued artifacts or completed audit events. Never reuse a document number.
- Drive failures must leave local issuance state and files intact. Payment and bank actions remain outside Mira.
- Review dependency audit results before release. Do not install or update packages without a separately approved change.
