CREATE TABLE claim_recharges (
  id INTEGER PRIMARY KEY,
  claim_id INTEGER NOT NULL UNIQUE REFERENCES claims(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  project_reference TEXT,
  description TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD', 'USD')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'INVOICED', 'EXCLUDED')),
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  excluded_at TEXT
) STRICT;

CREATE INDEX claim_recharges_customer_status_idx ON claim_recharges(customer_id, status, currency);

CREATE TABLE claim_recharge_events (
  id INTEGER PRIMARY KEY,
  claim_recharge_id INTEGER NOT NULL REFERENCES claim_recharges(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  details_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER claim_recharge_events_no_update BEFORE UPDATE ON claim_recharge_events
BEGIN SELECT RAISE(ABORT, 'claim recharge events are append-only'); END;
CREATE TRIGGER claim_recharge_events_no_delete BEFORE DELETE ON claim_recharge_events
BEGIN SELECT RAISE(ABORT, 'claim recharge events are append-only'); END;

CREATE TABLE claim_recharge_confirmations (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  invoice_draft_hash TEXT NOT NULL CHECK (length(invoice_draft_hash) = 64),
  recharge_ids_json TEXT NOT NULL,
  requesting_user TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_chat TEXT NOT NULL,
  source_message_reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'INVALIDATED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
) STRICT;

CREATE TABLE claim_invoice_links (
  id INTEGER PRIMARY KEY,
  claim_recharge_id INTEGER NOT NULL UNIQUE REFERENCES claim_recharges(id),
  claim_id INTEGER NOT NULL UNIQUE REFERENCES claims(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  invoice_line_item_id INTEGER NOT NULL UNIQUE REFERENCES invoice_line_items(id),
  currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD', 'USD')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  confirmation_id INTEGER NOT NULL REFERENCES claim_recharge_confirmations(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER claim_invoice_links_no_update BEFORE UPDATE ON claim_invoice_links
BEGIN SELECT RAISE(ABORT, 'claim invoice links are immutable'); END;
CREATE TRIGGER claim_invoice_links_no_delete BEFORE DELETE ON claim_invoice_links
BEGIN SELECT RAISE(ABORT, 'claim invoice links are immutable'); END;

CREATE TABLE claim_submission_packs (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  month TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('GENERATING', 'FAILED', 'READY', 'SUBMITTED')),
  classification TEXT NOT NULL CHECK (classification IN ('OPERATIONAL', 'TEST / NOT VALID')),
  relative_path TEXT,
  sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  size_bytes INTEGER,
  currency_totals_json TEXT NOT NULL,
  claim_count INTEGER NOT NULL CHECK (claim_count > 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ready_at TEXT,
  submitted_at TEXT,
  UNIQUE (customer_id, month)
) STRICT;

CREATE TABLE claim_submission_pack_items (
  id INTEGER PRIMARY KEY,
  pack_id INTEGER NOT NULL REFERENCES claim_submission_packs(id),
  claim_recharge_id INTEGER NOT NULL UNIQUE REFERENCES claim_recharges(id),
  claim_id INTEGER NOT NULL UNIQUE REFERENCES claims(id),
  receipt_sha256 TEXT NOT NULL CHECK (length(receipt_sha256) = 64),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD', 'USD')),
  created_at TEXT NOT NULL,
  UNIQUE (pack_id, claim_id)
) STRICT;

CREATE TRIGGER claim_submission_pack_items_no_update BEFORE UPDATE ON claim_submission_pack_items
BEGIN SELECT RAISE(ABORT, 'claim submission pack items are immutable'); END;
CREATE TRIGGER claim_submission_pack_items_no_delete BEFORE DELETE ON claim_submission_pack_items
BEGIN SELECT RAISE(ABORT, 'claim submission pack items are immutable'); END;

CREATE TABLE report_exports (
  id INTEGER PRIMARY KEY,
  report_type TEXT NOT NULL CHECK (report_type IN (
    'monthly-summary', 'annual-summary', 'quotation-register', 'invoice-register',
    'outstanding', 'overdue', 'claim-register', 'expense-by-category'
  )),
  format TEXT NOT NULL CHECK (format IN ('CSV', 'XLSX')),
  period_start TEXT,
  period_end_exclusive TEXT,
  currency TEXT CHECK (currency IN ('MYR', 'SGD', 'USD')),
  customer_id INTEGER REFERENCES customers(id),
  classification TEXT NOT NULL CHECK (classification IN ('OPERATIONAL', 'TEST / NOT VALID')),
  relative_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  currency_totals_json TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  generated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER report_exports_no_update BEFORE UPDATE ON report_exports
BEGIN SELECT RAISE(ABORT, 'report exports are immutable'); END;
CREATE TRIGGER report_exports_no_delete BEFORE DELETE ON report_exports
BEGIN SELECT RAISE(ABORT, 'report exports are immutable'); END;

CREATE INDEX report_exports_type_period_idx ON report_exports(report_type, period_start, period_end_exclusive);
