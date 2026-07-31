CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY,
  supplier_code TEXT NOT NULL UNIQUE,
  legal_name TEXT,
  display_name TEXT NOT NULL,
  registration_number TEXT,
  tax_registration_number TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  default_currency TEXT CHECK (default_currency IN ('MYR', 'SGD', 'USD')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX suppliers_code_normalized_uq ON suppliers(lower(supplier_code));
CREATE INDEX suppliers_display_name_idx ON suppliers(display_name, active);

CREATE TABLE supplier_aliases (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX supplier_aliases_supplier_idx ON supplier_aliases(supplier_id);

CREATE TABLE supplier_invoices (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'FILING', 'FILING_FAILED', 'FILED', 'CANCELLED')),
  classification TEXT NOT NULL CHECK (classification = 'SUPPLIER_INVOICE'),
  supplier_id INTEGER REFERENCES suppliers(id),
  supplier_invoice_number TEXT,
  issue_date TEXT,
  due_date TEXT,
  expense_category TEXT,
  project_allocation TEXT,
  currency TEXT CHECK (currency IN ('MYR', 'SGD', 'USD')),
  subtotal_minor INTEGER CHECK (subtotal_minor IS NULL OR subtotal_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor INTEGER CHECK (total_minor IS NULL OR total_minor >= 0),
  description TEXT,
  purchase_order_reference TEXT,
  source_channel TEXT,
  source_message_reference TEXT,
  created_by TEXT NOT NULL,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  filed_at TEXT,
  drive_source_file_id TEXT,
  CHECK (total_minor IS NULL OR subtotal_minor IS NULL OR total_minor = subtotal_minor + tax_minor)
) STRICT;

CREATE UNIQUE INDEX supplier_invoice_vendor_number_uq
  ON supplier_invoices(supplier_id, lower(supplier_invoice_number))
  WHERE supplier_id IS NOT NULL AND supplier_invoice_number IS NOT NULL;
CREATE INDEX supplier_invoices_register_idx ON supplier_invoices(issue_date, supplier_id, id);
CREATE INDEX supplier_invoices_due_idx ON supplier_invoices(due_date, status);

CREATE TABLE supplier_invoice_documents (
  id INTEGER PRIMARY KEY,
  supplier_invoice_id INTEGER NOT NULL UNIQUE REFERENCES supplier_invoices(id),
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

CREATE INDEX supplier_invoice_documents_probable_duplicate_idx
  ON supplier_invoice_documents(probable_duplicate_fingerprint);

CREATE TABLE supplier_invoice_draft_state (
  supplier_invoice_id INTEGER PRIMARY KEY REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  snapshot_json TEXT NOT NULL,
  validation_issues_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE supplier_invoice_draft_versions (
  id INTEGER PRIMARY KEY,
  supplier_invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  snapshot_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (supplier_invoice_id, version)
) STRICT;

CREATE TRIGGER supplier_invoice_draft_versions_no_update BEFORE UPDATE ON supplier_invoice_draft_versions
BEGIN SELECT RAISE(ABORT, 'supplier invoice draft versions are immutable'); END;
CREATE TRIGGER supplier_invoice_draft_versions_no_delete BEFORE DELETE ON supplier_invoice_draft_versions
BEGIN SELECT RAISE(ABORT, 'supplier invoice draft versions are immutable'); END;

CREATE TABLE supplier_invoice_approvals (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  supplier_invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id),
  draft_version INTEGER NOT NULL CHECK (draft_version > 0),
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
  requesting_user TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_chat TEXT NOT NULL,
  source_message_reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'CANCELLED', 'EXPIRED', 'INVALIDATED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT
) STRICT;

CREATE TABLE supplier_invoice_filings (
  supplier_invoice_id INTEGER PRIMARY KEY REFERENCES supplier_invoices(id),
  approval_id INTEGER NOT NULL UNIQUE REFERENCES supplier_invoice_approvals(id),
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

CREATE TABLE supplier_invoice_filing_attempts (
  id INTEGER PRIMARY KEY,
  supplier_invoice_id INTEGER NOT NULL REFERENCES supplier_invoice_filings(supplier_invoice_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  result TEXT NOT NULL CHECK (result IN ('SUCCEEDED', 'FAILED')),
  error_code TEXT,
  drive_file_id TEXT,
  verified_size INTEGER,
  verified_hash TEXT,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (supplier_invoice_id, attempt_number)
) STRICT;

CREATE TRIGGER supplier_invoice_filing_attempts_no_update BEFORE UPDATE ON supplier_invoice_filing_attempts
BEGIN SELECT RAISE(ABORT, 'supplier invoice filing attempts are append-only'); END;
CREATE TRIGGER supplier_invoice_filing_attempts_no_delete BEFORE DELETE ON supplier_invoice_filing_attempts
BEGIN SELECT RAISE(ABORT, 'supplier invoice filing attempts are append-only'); END;

CREATE INDEX supplier_invoice_draft_versions_invoice_idx
  ON supplier_invoice_draft_versions(supplier_invoice_id, version);
CREATE INDEX supplier_invoice_approvals_status_idx
  ON supplier_invoice_approvals(status, expires_at);
CREATE INDEX supplier_invoice_filings_status_idx
  ON supplier_invoice_filings(status, updated_at);
