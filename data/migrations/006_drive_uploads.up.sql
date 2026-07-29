CREATE TABLE drive_uploads (
  id INTEGER PRIMARY KEY,
  document_type TEXT NOT NULL CHECK (document_type IN ('quotation', 'invoice')),
  entity_id INTEGER NOT NULL CHECK (entity_id > 0),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('DOCX', 'PDF')),
  local_relative_path TEXT NOT NULL,
  local_sha256 TEXT NOT NULL CHECK (length(local_sha256) = 64),
  local_size INTEGER NOT NULL CHECK (local_size > 0),
  folder_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  drive_file_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'UPLOADING', 'RETRY_PENDING', 'COMPLETED', 'PERMANENT_FAILURE')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (document_type, entity_id, artifact_kind),
  CHECK ((status = 'COMPLETED' AND drive_file_id IS NOT NULL AND completed_at IS NOT NULL) OR status <> 'COMPLETED')
) STRICT;

CREATE UNIQUE INDEX drive_uploads_file_id_uq ON drive_uploads(drive_file_id) WHERE drive_file_id IS NOT NULL;
CREATE INDEX drive_uploads_retry_idx ON drive_uploads(status, next_attempt_at);

CREATE TABLE drive_upload_attempts (
  id INTEGER PRIMARY KEY,
  drive_upload_id INTEGER NOT NULL REFERENCES drive_uploads(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  result TEXT NOT NULL CHECK (result IN ('SUCCEEDED', 'FAILED')),
  error_code TEXT,
  drive_file_id TEXT,
  verified_size INTEGER,
  verified_hash TEXT,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (drive_upload_id, attempt_number)
) STRICT;

CREATE TRIGGER drive_upload_attempts_no_update BEFORE UPDATE ON drive_upload_attempts
BEGIN SELECT RAISE(ABORT, 'drive upload attempts are append-only'); END;
CREATE TRIGGER drive_upload_attempts_no_delete BEFORE DELETE ON drive_upload_attempts
BEGIN SELECT RAISE(ABORT, 'drive upload attempts are append-only'); END;

CREATE INDEX drive_upload_attempts_upload_idx ON drive_upload_attempts(drive_upload_id, attempt_number);
