CREATE TABLE customer_drive_folders (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
  folder_id TEXT NOT NULL UNIQUE,
  folder_name TEXT NOT NULL,
  root_folder_id_hash TEXT NOT NULL CHECK (length(root_folder_id_hash) = 64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

ALTER TABLE invoice_issuances ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'LOCAL'
  CHECK (storage_backend IN ('LOCAL', 'DRIVE_ONLY'));
ALTER TABLE invoice_issuances ADD COLUMN drive_folder_id TEXT;
ALTER TABLE invoice_issuances ADD COLUMN docx_file_name TEXT;
ALTER TABLE invoice_issuances ADD COLUMN pdf_file_name TEXT;

ALTER TABLE customer_delivery_requests ADD COLUMN artifact_storage_backend TEXT NOT NULL DEFAULT 'LOCAL'
  CHECK (artifact_storage_backend IN ('LOCAL', 'DRIVE_ONLY'));
ALTER TABLE customer_delivery_requests ADD COLUMN artifact_drive_file_id TEXT;

CREATE TABLE invoice_drive_storage_attempts (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoice_issuances(invoice_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  result TEXT NOT NULL CHECK (result IN ('SUCCEEDED', 'FAILED')),
  folder_id_hash TEXT CHECK (folder_id_hash IS NULL OR length(folder_id_hash) = 64),
  docx_file_id_hash TEXT CHECK (docx_file_id_hash IS NULL OR length(docx_file_id_hash) = 64),
  pdf_file_id_hash TEXT CHECK (pdf_file_id_hash IS NULL OR length(pdf_file_id_hash) = 64),
  error_code TEXT,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (invoice_id, attempt_number)
) STRICT;

CREATE TRIGGER invoice_drive_storage_attempts_no_update BEFORE UPDATE ON invoice_drive_storage_attempts
BEGIN SELECT RAISE(ABORT, 'invoice Drive storage attempts are append-only'); END;
CREATE TRIGGER invoice_drive_storage_attempts_no_delete BEFORE DELETE ON invoice_drive_storage_attempts
BEGIN SELECT RAISE(ABORT, 'invoice Drive storage attempts are append-only'); END;
