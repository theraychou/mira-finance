CREATE TABLE customer_change_requests (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'DEACTIVATE')),
  customer_id INTEGER REFERENCES customers(id),
  target_customer_code TEXT NOT NULL,
  before_hash TEXT CHECK (before_hash IS NULL OR length(before_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  payload_json TEXT NOT NULL,
  requesting_user TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_chat TEXT NOT NULL,
  source_message_reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'INVALIDATED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_by TEXT,
  confirmed_at TEXT,
  CHECK (operation = 'CREATE' OR customer_id IS NOT NULL)
) STRICT;

CREATE INDEX customer_change_requests_status_idx
  ON customer_change_requests(status, expires_at);

CREATE TRIGGER customer_change_requests_no_delete
BEFORE DELETE ON customer_change_requests
BEGIN SELECT RAISE(ABORT, 'customer change requests cannot be deleted'); END;

CREATE TABLE customer_sheet_mirror_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  spreadsheet_id TEXT,
  folder_id_hash TEXT CHECK (folder_id_hash IS NULL OR length(folder_id_hash) = 64),
  source_hash TEXT CHECK (source_hash IS NULL OR length(source_hash) = 64),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('NOT_CONFIGURED', 'PENDING', 'SYNCED', 'FAILED')),
  last_error_code TEXT,
  synced_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE customer_sheet_sync_attempts (
  id INTEGER PRIMARY KEY,
  result TEXT NOT NULL CHECK (result IN ('SUCCEEDED', 'FAILED', 'UNCHANGED')),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  spreadsheet_id_hash TEXT CHECK (spreadsheet_id_hash IS NULL OR length(spreadsheet_id_hash) = 64),
  error_code TEXT,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER customer_sheet_sync_attempts_no_update
BEFORE UPDATE ON customer_sheet_sync_attempts
BEGIN SELECT RAISE(ABORT, 'customer sheet sync attempts are append-only'); END;

CREATE TRIGGER customer_sheet_sync_attempts_no_delete
BEFORE DELETE ON customer_sheet_sync_attempts
BEGIN SELECT RAISE(ABORT, 'customer sheet sync attempts are append-only'); END;
