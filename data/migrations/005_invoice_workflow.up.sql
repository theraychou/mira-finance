CREATE TABLE invoice_draft_state (
  invoice_id INTEGER PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  snapshot_json TEXT NOT NULL,
  validation_issues_json TEXT NOT NULL DEFAULT '[]',
  discount_type TEXT NOT NULL CHECK (discount_type IN ('NONE', 'FIXED', 'PERCENTAGE')),
  discount_value INTEGER NOT NULL CHECK (discount_value >= 0),
  payment_terms_days INTEGER NOT NULL CHECK (payment_terms_days >= 0),
  tax_mode TEXT NOT NULL CHECK (tax_mode = 'NONE'),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE invoice_draft_versions (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  snapshot_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (invoice_id, version)
) STRICT;

CREATE TRIGGER invoice_draft_versions_no_update
BEFORE UPDATE ON invoice_draft_versions
BEGIN
  SELECT RAISE(ABORT, 'invoice draft versions are immutable');
END;

CREATE TRIGGER invoice_draft_versions_no_delete
BEFORE DELETE ON invoice_draft_versions
BEGIN
  SELECT RAISE(ABORT, 'invoice draft versions are immutable');
END;

CREATE TABLE invoice_issuances (
  invoice_id INTEGER PRIMARY KEY REFERENCES invoices(id),
  document_number_id INTEGER NOT NULL UNIQUE REFERENCES document_numbers(id),
  confirmation_id INTEGER NOT NULL UNIQUE REFERENCES pending_confirmations(id),
  draft_version INTEGER NOT NULL CHECK (draft_version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('GENERATING', 'ISSUE_FAILED', 'ISSUED')),
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

CREATE TABLE invoice_issuance_attempts (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoice_issuances(invoice_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  result TEXT NOT NULL CHECK (result IN ('SUCCEEDED', 'FAILED')),
  error_code TEXT,
  docx_sha256 TEXT CHECK (docx_sha256 IS NULL OR length(docx_sha256) = 64),
  pdf_sha256 TEXT CHECK (pdf_sha256 IS NULL OR length(pdf_sha256) = 64),
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (invoice_id, attempt_number)
) STRICT;

CREATE TRIGGER invoice_issuance_attempts_no_update BEFORE UPDATE ON invoice_issuance_attempts
BEGIN SELECT RAISE(ABORT, 'invoice issuance attempts are append-only'); END;
CREATE TRIGGER invoice_issuance_attempts_no_delete BEFORE DELETE ON invoice_issuance_attempts
BEGIN SELECT RAISE(ABORT, 'invoice issuance attempts are append-only'); END;

CREATE TABLE invoice_payment_drafts (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  payment_date TEXT NOT NULL,
  payment_reference TEXT,
  prior_amount_paid_minor INTEGER NOT NULL CHECK (prior_amount_paid_minor >= 0),
  prior_balance_due_minor INTEGER NOT NULL CHECK (prior_balance_due_minor >= 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  requesting_user TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_chat TEXT NOT NULL,
  source_message_reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'INVALIDATED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
) STRICT;

CREATE TABLE invoice_payment_events (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  payment_draft_id INTEGER NOT NULL UNIQUE REFERENCES invoice_payment_drafts(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  prior_amount_paid_minor INTEGER NOT NULL CHECK (prior_amount_paid_minor >= 0),
  new_amount_paid_minor INTEGER NOT NULL CHECK (new_amount_paid_minor >= prior_amount_paid_minor),
  prior_balance_due_minor INTEGER NOT NULL CHECK (prior_balance_due_minor >= 0),
  new_balance_due_minor INTEGER NOT NULL CHECK (new_balance_due_minor >= 0),
  prior_payment_status TEXT NOT NULL CHECK (prior_payment_status IN ('UNPAID', 'PARTIALLY_PAID')),
  new_payment_status TEXT NOT NULL CHECK (new_payment_status IN ('PARTIALLY_PAID', 'PAID')),
  payment_date TEXT NOT NULL,
  payment_reference TEXT,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER invoice_payment_events_no_update BEFORE UPDATE ON invoice_payment_events
BEGIN SELECT RAISE(ABORT, 'invoice payment events are append-only'); END;
CREATE TRIGGER invoice_payment_events_no_delete BEFORE DELETE ON invoice_payment_events
BEGIN SELECT RAISE(ABORT, 'invoice payment events are append-only'); END;

CREATE UNIQUE INDEX invoices_full_quotation_uq ON invoices(quotation_id) WHERE quotation_id IS NOT NULL;
CREATE INDEX invoice_draft_versions_invoice_idx ON invoice_draft_versions(invoice_id, version);
CREATE INDEX invoice_issuances_status_idx ON invoice_issuances(status, updated_at);
CREATE INDEX invoice_payment_drafts_status_idx ON invoice_payment_drafts(status, expires_at);
CREATE INDEX invoice_payment_events_invoice_idx ON invoice_payment_events(invoice_id, occurred_at);
