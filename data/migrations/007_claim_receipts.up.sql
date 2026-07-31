CREATE TABLE claim_receipts (
  id INTEGER PRIMARY KEY,
  claim_id INTEGER NOT NULL UNIQUE REFERENCES claims(id),
  source_filename TEXT NOT NULL,
  source_mime_type TEXT NOT NULL CHECK (source_mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  source_size INTEGER NOT NULL CHECK (source_size > 0),
  source_sha256 TEXT NOT NULL UNIQUE CHECK (length(source_sha256) = 64),
  storage_relative_path TEXT NOT NULL UNIQUE,
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('PDF_TEXT', 'TESSERACT', 'ADVISORY', 'UNAVAILABLE')),
  extraction_status TEXT NOT NULL CHECK (extraction_status IN ('COMPLETE', 'PARTIAL', 'UNAVAILABLE', 'FAILED')),
  extracted_text_sha256 TEXT CHECK (extracted_text_sha256 IS NULL OR length(extracted_text_sha256) = 64),
  rotation_degrees INTEGER NOT NULL DEFAULT 0 CHECK (rotation_degrees IN (0, 90, 180, 270)),
  probable_duplicate_fingerprint TEXT CHECK (probable_duplicate_fingerprint IS NULL OR length(probable_duplicate_fingerprint) = 64),
  drive_file_id TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX claim_receipts_probable_duplicate_idx
  ON claim_receipts(probable_duplicate_fingerprint);

CREATE TABLE claim_draft_state (
  claim_id INTEGER PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  snapshot_json TEXT NOT NULL,
  validation_issues_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE claim_draft_versions (
  id INTEGER PRIMARY KEY,
  claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  snapshot_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (claim_id, version)
) STRICT;

CREATE TRIGGER claim_draft_versions_no_update BEFORE UPDATE ON claim_draft_versions
BEGIN SELECT RAISE(ABORT, 'claim draft versions are immutable'); END;
CREATE TRIGGER claim_draft_versions_no_delete BEFORE DELETE ON claim_draft_versions
BEGIN SELECT RAISE(ABORT, 'claim draft versions are immutable'); END;

CREATE TABLE claim_filings (
  claim_id INTEGER PRIMARY KEY REFERENCES claims(id),
  document_number_id INTEGER NOT NULL UNIQUE REFERENCES document_numbers(id),
  confirmation_id INTEGER NOT NULL UNIQUE REFERENCES pending_confirmations(id),
  draft_version INTEGER NOT NULL CHECK (draft_version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('FILING', 'FILING_FAILED', 'FILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  drive_file_id TEXT,
  verified_size INTEGER,
  verified_hash TEXT,
  filed_by TEXT,
  filed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'FILED' AND drive_file_id IS NOT NULL AND filed_by IS NOT NULL AND filed_at IS NOT NULL) OR status <> 'FILED')
) STRICT;

CREATE TABLE claim_filing_attempts (
  id INTEGER PRIMARY KEY,
  claim_id INTEGER NOT NULL REFERENCES claim_filings(claim_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  result TEXT NOT NULL CHECK (result IN ('SUCCEEDED', 'FAILED')),
  error_code TEXT,
  drive_file_id TEXT,
  verified_size INTEGER,
  verified_hash TEXT,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (claim_id, attempt_number)
) STRICT;

CREATE TRIGGER claim_filing_attempts_no_update BEFORE UPDATE ON claim_filing_attempts
BEGIN SELECT RAISE(ABORT, 'claim filing attempts are append-only'); END;
CREATE TRIGGER claim_filing_attempts_no_delete BEFORE DELETE ON claim_filing_attempts
BEGIN SELECT RAISE(ABORT, 'claim filing attempts are append-only'); END;

CREATE INDEX claim_draft_versions_claim_idx ON claim_draft_versions(claim_id, version);
CREATE INDEX claim_filings_status_idx ON claim_filings(status, updated_at);

