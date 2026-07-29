CREATE TABLE quotation_draft_state (
  quotation_id INTEGER PRIMARY KEY REFERENCES quotations(id) ON DELETE CASCADE,
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  snapshot_json TEXT NOT NULL,
  validation_issues_json TEXT NOT NULL DEFAULT '[]',
  discount_type TEXT NOT NULL CHECK (discount_type IN ('NONE', 'FIXED', 'PERCENTAGE')),
  discount_value INTEGER NOT NULL CHECK (discount_value >= 0),
  validity_days INTEGER NOT NULL CHECK (validity_days > 0),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('NONE', 'RULE')),
  tax_rule_snapshot_json TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE quotation_draft_versions (
  id INTEGER PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  snapshot_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (quotation_id, version)
) STRICT;

CREATE TRIGGER quotation_draft_versions_no_update
BEFORE UPDATE ON quotation_draft_versions
BEGIN
  SELECT RAISE(ABORT, 'quotation draft versions are immutable');
END;

CREATE TRIGGER quotation_draft_versions_no_delete
BEFORE DELETE ON quotation_draft_versions
BEGIN
  SELECT RAISE(ABORT, 'quotation draft versions are immutable');
END;

CREATE INDEX quotation_draft_versions_quotation_idx
  ON quotation_draft_versions(quotation_id, version);
