CREATE TABLE quotation_issuances (
  quotation_id INTEGER PRIMARY KEY REFERENCES quotations(id),
  document_number_id INTEGER NOT NULL UNIQUE REFERENCES document_numbers(id),
  confirmation_id INTEGER NOT NULL UNIQUE REFERENCES pending_confirmations(id),
  draft_version INTEGER NOT NULL CHECK (draft_version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('GENERATING', 'ISSUE_FAILED', 'ISSUED', 'CANCELLED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  docx_relative_path TEXT,
  pdf_relative_path TEXT,
  docx_sha256 TEXT CHECK (docx_sha256 IS NULL OR length(docx_sha256) = 64),
  pdf_sha256 TEXT CHECK (pdf_sha256 IS NULL OR length(pdf_sha256) = 64),
  issued_by TEXT,
  issued_at TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'ISSUED' AND docx_relative_path IS NOT NULL AND pdf_relative_path IS NOT NULL
      AND docx_sha256 IS NOT NULL AND pdf_sha256 IS NOT NULL AND issued_by IS NOT NULL AND issued_at IS NOT NULL)
    OR status <> 'ISSUED'
  )
) STRICT;

CREATE TABLE quotation_issuance_attempts (
  id INTEGER PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotation_issuances(quotation_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  result TEXT NOT NULL CHECK (result IN ('SUCCEEDED', 'FAILED')),
  error_code TEXT,
  docx_sha256 TEXT CHECK (docx_sha256 IS NULL OR length(docx_sha256) = 64),
  pdf_sha256 TEXT CHECK (pdf_sha256 IS NULL OR length(pdf_sha256) = 64),
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (quotation_id, attempt_number)
) STRICT;

CREATE TRIGGER quotation_issuance_attempts_no_update
BEFORE UPDATE ON quotation_issuance_attempts
BEGIN
  SELECT RAISE(ABORT, 'quotation issuance attempts are append-only');
END;

CREATE TRIGGER quotation_issuance_attempts_no_delete
BEFORE DELETE ON quotation_issuance_attempts
BEGIN
  SELECT RAISE(ABORT, 'quotation issuance attempts are append-only');
END;

CREATE INDEX quotation_issuances_status_idx ON quotation_issuances(status, updated_at);
