CREATE TABLE credit_notes (
  id INTEGER PRIMARY KEY,
  credit_note_number TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING_CONFIRMATION','GENERATING','ISSUE_FAILED','ISSUED','CANCELLED')),
  original_invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  business_entity_id INTEGER NOT NULL REFERENCES business_entities(id),
  currency TEXT NOT NULL CHECK (currency IN ('MYR','SGD','USD')),
  issue_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  total_minor INTEGER NOT NULL CHECK (total_minor > 0),
  created_by TEXT NOT NULL,
  confirmed_by TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  issued_at TEXT,
  cancelled_at TEXT,
  drive_docx_file_id TEXT,
  drive_pdf_file_id TEXT,
  document_hash TEXT,
  CHECK ((status IN ('DRAFT','PENDING_CONFIRMATION') AND credit_note_number IS NULL)
    OR status NOT IN ('DRAFT','PENDING_CONFIRMATION')),
  CHECK (status IN ('DRAFT','PENDING_CONFIRMATION') OR credit_note_number IS NOT NULL)
) STRICT;

CREATE TABLE credit_note_line_items (
  id INTEGER PRIMARY KEY,
  credit_note_id INTEGER NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  original_invoice_line_item_id INTEGER REFERENCES invoice_line_items(id),
  description TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  UNIQUE (credit_note_id, sequence)
) STRICT;

CREATE TABLE credit_note_draft_state (
  credit_note_id INTEGER PRIMARY KEY REFERENCES credit_notes(id) ON DELETE CASCADE,
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  snapshot_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE credit_note_draft_versions (
  id INTEGER PRIMARY KEY,
  credit_note_id INTEGER NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  snapshot_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (credit_note_id, version)
) STRICT;
CREATE TRIGGER credit_note_draft_versions_no_update BEFORE UPDATE ON credit_note_draft_versions
BEGIN SELECT RAISE(ABORT, 'credit note draft versions are immutable'); END;
CREATE TRIGGER credit_note_draft_versions_no_delete BEFORE DELETE ON credit_note_draft_versions
BEGIN SELECT RAISE(ABORT, 'credit note draft versions are immutable'); END;

CREATE TABLE correction_confirmations (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  correction_type TEXT NOT NULL CHECK (correction_type IN ('CREDIT_NOTE_ISSUANCE','INVOICE_CANCELLATION','QUOTATION_CANCELLATION')),
  entity_id INTEGER NOT NULL CHECK (entity_id > 0),
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
  requesting_user TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_chat TEXT NOT NULL,
  source_message_reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','CONFIRMED','CANCELLED','EXPIRED','INVALIDATED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
) STRICT;
CREATE UNIQUE INDEX correction_confirmations_one_pending
ON correction_confirmations(correction_type,entity_id)
WHERE status='PENDING';

CREATE TABLE credit_note_issuances (
  credit_note_id INTEGER PRIMARY KEY REFERENCES credit_notes(id),
  document_number_id INTEGER NOT NULL UNIQUE REFERENCES document_numbers(id),
  confirmation_id INTEGER NOT NULL UNIQUE REFERENCES correction_confirmations(id),
  draft_version INTEGER NOT NULL CHECK (draft_version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('GENERATING','ISSUE_FAILED','ISSUED','CANCELLED')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  last_error_code TEXT,
  docx_relative_path TEXT,
  pdf_relative_path TEXT,
  docx_sha256 TEXT CHECK (docx_sha256 IS NULL OR length(docx_sha256) = 64),
  pdf_sha256 TEXT CHECK (pdf_sha256 IS NULL OR length(pdf_sha256) = 64),
  issued_by TEXT,
  issued_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE credit_note_issuance_attempts (
  id INTEGER PRIMARY KEY,
  credit_note_id INTEGER NOT NULL REFERENCES credit_note_issuances(credit_note_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  result TEXT NOT NULL CHECK (result IN ('SUCCEEDED','FAILED')),
  error_code TEXT,
  docx_sha256 TEXT CHECK (docx_sha256 IS NULL OR length(docx_sha256) = 64),
  pdf_sha256 TEXT CHECK (pdf_sha256 IS NULL OR length(pdf_sha256) = 64),
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (credit_note_id, attempt_number)
) STRICT;
CREATE TRIGGER credit_note_issuance_attempts_no_update BEFORE UPDATE ON credit_note_issuance_attempts
BEGIN SELECT RAISE(ABORT, 'credit note issuance attempts are append-only'); END;
CREATE TRIGGER credit_note_issuance_attempts_no_delete BEFORE DELETE ON credit_note_issuance_attempts
BEGIN SELECT RAISE(ABORT, 'credit note issuance attempts are append-only'); END;

CREATE TABLE document_cancellations (
  id INTEGER PRIMARY KEY,
  document_type TEXT NOT NULL CHECK (document_type IN ('invoice','quotation')),
  entity_id INTEGER NOT NULL CHECK (entity_id > 0),
  document_number TEXT NOT NULL,
  confirmation_id INTEGER NOT NULL UNIQUE REFERENCES correction_confirmations(id),
  reason TEXT NOT NULL,
  cancelled_by TEXT NOT NULL,
  cancelled_at TEXT NOT NULL,
  UNIQUE (document_type, entity_id)
) STRICT;
CREATE TRIGGER document_cancellations_no_update BEFORE UPDATE ON document_cancellations
BEGIN SELECT RAISE(ABORT, 'document cancellations are immutable'); END;
CREATE TRIGGER document_cancellations_no_delete BEFORE DELETE ON document_cancellations
BEGIN SELECT RAISE(ABORT, 'document cancellations are immutable'); END;

CREATE TABLE replacement_document_links (
  id INTEGER PRIMARY KEY,
  document_type TEXT NOT NULL CHECK (document_type IN ('invoice','quotation')),
  original_entity_id INTEGER NOT NULL CHECK (original_entity_id > 0),
  original_document_number TEXT NOT NULL,
  replacement_entity_id INTEGER NOT NULL CHECK (replacement_entity_id > 0),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (document_type, original_entity_id),
  UNIQUE (document_type, replacement_entity_id),
  CHECK (original_entity_id <> replacement_entity_id)
) STRICT;
CREATE TRIGGER replacement_document_links_no_update BEFORE UPDATE ON replacement_document_links
BEGIN SELECT RAISE(ABORT, 'replacement document links are immutable'); END;
CREATE TRIGGER replacement_document_links_no_delete BEFORE DELETE ON replacement_document_links
BEGIN SELECT RAISE(ABORT, 'replacement document links are immutable'); END;

CREATE TABLE document_status_history (
  id INTEGER PRIMARY KEY,
  document_type TEXT NOT NULL CHECK (document_type IN ('invoice','quotation','credit_note')),
  entity_id INTEGER NOT NULL CHECK (entity_id > 0),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER document_status_history_no_update BEFORE UPDATE ON document_status_history
BEGIN SELECT RAISE(ABORT, 'document status history is append-only'); END;
CREATE TRIGGER document_status_history_no_delete BEFORE DELETE ON document_status_history
BEGIN SELECT RAISE(ABORT, 'document status history is append-only'); END;

CREATE TABLE correction_drive_filings (
  id INTEGER PRIMARY KEY,
  correction_type TEXT NOT NULL CHECK (correction_type IN ('credit_note','cancellation','replacement')),
  entity_id INTEGER NOT NULL CHECK (entity_id > 0),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('DOCX','PDF','JSON')),
  local_relative_path TEXT NOT NULL,
  local_sha256 TEXT NOT NULL CHECK (length(local_sha256) = 64),
  local_size INTEGER NOT NULL CHECK (local_size > 0),
  drive_file_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETED','FAILED')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (correction_type, entity_id, artifact_kind)
) STRICT;
CREATE TRIGGER correction_drive_filings_no_update BEFORE UPDATE ON correction_drive_filings
WHEN OLD.status = 'COMPLETED'
BEGIN SELECT RAISE(ABORT, 'completed correction Drive filings are immutable'); END;
CREATE TRIGGER correction_drive_filings_no_delete BEFORE DELETE ON correction_drive_filings
BEGIN SELECT RAISE(ABORT, 'correction Drive filings are append-only'); END;

CREATE UNIQUE INDEX credit_notes_one_active_draft_per_invoice
ON credit_notes(original_invoice_id)
WHERE status IN ('DRAFT','PENDING_CONFIRMATION','GENERATING','ISSUE_FAILED');
CREATE INDEX credit_notes_original_status_idx ON credit_notes(original_invoice_id,status);
CREATE INDEX correction_confirmations_status_idx ON correction_confirmations(status,expires_at);
CREATE INDEX document_status_history_entity_idx ON document_status_history(document_type,entity_id,occurred_at);
