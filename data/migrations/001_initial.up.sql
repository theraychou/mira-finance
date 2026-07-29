CREATE TABLE business_entities (
  id INTEGER PRIMARY KEY,
  legal_name TEXT NOT NULL,
  trading_name TEXT,
  registration_number TEXT,
  registered_address TEXT,
  billing_address TEXT,
  tax_registration_number TEXT,
  default_currency TEXT CHECK (default_currency IN ('MYR', 'SGD', 'USD')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  customer_code TEXT NOT NULL UNIQUE,
  legal_name TEXT,
  display_name TEXT NOT NULL,
  registration_number TEXT,
  tax_registration_number TEXT,
  billing_address TEXT,
  billing_contact_name TEXT,
  billing_email TEXT,
  billing_phone TEXT,
  default_currency TEXT CHECK (default_currency IN ('MYR', 'SGD', 'USD')),
  default_payment_terms_days INTEGER CHECK (default_payment_terms_days >= 0),
  tax_treatment TEXT,
  purchase_order_required INTEGER NOT NULL DEFAULT 0 CHECK (purchase_order_required IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE customer_aliases (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE quotations (
  id INTEGER PRIMARY KEY,
  quotation_number TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PENDING_CONFIRMATION', 'GENERATING', 'ISSUED', 'ISSUE_FAILED', 'CANCELLED')),
  customer_id INTEGER REFERENCES customers(id),
  business_entity_id INTEGER REFERENCES business_entities(id),
  currency TEXT CHECK (currency IN ('MYR', 'SGD', 'USD')),
  issue_date TEXT,
  valid_until TEXT,
  service_date TEXT,
  title TEXT,
  description TEXT,
  subtotal_minor INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor = subtotal_minor - discount_minor + tax_minor AND total_minor >= 0),
  tax_rule_id INTEGER,
  payment_terms TEXT,
  notes TEXT,
  source_channel TEXT,
  source_message_reference TEXT,
  created_by TEXT NOT NULL,
  confirmed_by TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  issued_at TEXT,
  cancelled_at TEXT,
  drive_docx_file_id TEXT,
  drive_pdf_file_id TEXT,
  document_hash TEXT,
  CHECK ((status IN ('DRAFT', 'PENDING_CONFIRMATION') AND quotation_number IS NULL) OR status NOT IN ('DRAFT', 'PENDING_CONFIRMATION')),
  CHECK (status IN ('DRAFT', 'PENDING_CONFIRMATION') OR quotation_number IS NOT NULL)
) STRICT;

CREATE TABLE quotation_line_items (
  id INTEGER PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  description TEXT NOT NULL,
  quantity_numerator INTEGER NOT NULL CHECK (quantity_numerator > 0),
  quantity_scale INTEGER NOT NULL DEFAULT 1 CHECK (quantity_scale > 0),
  unit TEXT,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_code TEXT,
  line_subtotal_minor INTEGER NOT NULL CHECK (line_subtotal_minor >= 0),
  line_tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (line_tax_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor = line_subtotal_minor - discount_minor + line_tax_minor AND line_total_minor >= 0),
  UNIQUE (quotation_id, sequence)
) STRICT;

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  invoice_number TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PENDING_CONFIRMATION', 'GENERATING', 'ISSUED', 'ISSUE_FAILED', 'CANCELLED')),
  quotation_id INTEGER REFERENCES quotations(id),
  customer_id INTEGER REFERENCES customers(id),
  business_entity_id INTEGER REFERENCES business_entities(id),
  currency TEXT CHECK (currency IN ('MYR', 'SGD', 'USD')),
  issue_date TEXT,
  due_date TEXT,
  service_date TEXT,
  purchase_order_number TEXT,
  subtotal_minor INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor = subtotal_minor - discount_minor + tax_minor AND total_minor >= 0),
  amount_paid_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_minor >= 0),
  balance_due_minor INTEGER NOT NULL DEFAULT 0 CHECK (balance_due_minor = total_minor - amount_paid_minor AND balance_due_minor >= 0),
  payment_status TEXT NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID', 'PARTIALLY_PAID', 'PAID')),
  payment_terms TEXT,
  notes TEXT,
  created_by TEXT NOT NULL,
  confirmed_by TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  issued_at TEXT,
  paid_at TEXT,
  cancelled_at TEXT,
  drive_docx_file_id TEXT,
  drive_pdf_file_id TEXT,
  document_hash TEXT,
  CHECK ((status IN ('DRAFT', 'PENDING_CONFIRMATION') AND invoice_number IS NULL) OR status NOT IN ('DRAFT', 'PENDING_CONFIRMATION')),
  CHECK (status IN ('DRAFT', 'PENDING_CONFIRMATION') OR invoice_number IS NOT NULL)
) STRICT;

CREATE TABLE invoice_line_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  description TEXT NOT NULL,
  quantity_numerator INTEGER NOT NULL CHECK (quantity_numerator > 0),
  quantity_scale INTEGER NOT NULL DEFAULT 1 CHECK (quantity_scale > 0),
  unit TEXT,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_code TEXT,
  line_subtotal_minor INTEGER NOT NULL CHECK (line_subtotal_minor >= 0),
  line_tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (line_tax_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor = line_subtotal_minor - discount_minor + line_tax_minor AND line_total_minor >= 0),
  UNIQUE (invoice_id, sequence)
) STRICT;

CREATE TABLE claims (
  id INTEGER PRIMARY KEY,
  claim_number TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PENDING_CONFIRMATION', 'FILED', 'FILING_FAILED', 'CANCELLED')),
  transaction_date TEXT,
  merchant TEXT,
  description TEXT,
  category TEXT,
  client_or_project TEXT,
  currency TEXT CHECK (currency IN ('MYR', 'SGD', 'USD')),
  subtotal_minor INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor = subtotal_minor + tax_minor AND total_minor >= 0),
  payment_method TEXT,
  business_purpose TEXT,
  source_filename TEXT,
  source_mime_type TEXT,
  source_hash TEXT,
  drive_source_file_id TEXT,
  drive_record_file_id TEXT,
  created_by TEXT NOT NULL,
  confirmed_by TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  filed_at TEXT,
  CHECK ((status IN ('DRAFT', 'PENDING_CONFIRMATION') AND claim_number IS NULL) OR status NOT IN ('DRAFT', 'PENDING_CONFIRMATION')),
  CHECK (status IN ('DRAFT', 'PENDING_CONFIRMATION') OR claim_number IS NOT NULL)
) STRICT;

CREATE TABLE pending_confirmations (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  draft_type TEXT NOT NULL CHECK (draft_type IN ('quotation', 'invoice', 'claim')),
  draft_id INTEGER NOT NULL,
  draft_hash TEXT NOT NULL,
  requesting_user TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_chat TEXT NOT NULL,
  source_message_reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'INVALIDATED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  cancelled_at TEXT
) STRICT;

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  before_hash TEXT,
  after_hash TEXT,
  source_channel TEXT,
  source_chat TEXT,
  source_message_reference TEXT,
  result TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TABLE number_sequences (
  document_type TEXT NOT NULL CHECK (document_type IN ('quotation', 'invoice', 'claim', 'credit_note')),
  sequence_date TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1001 CHECK (next_value >= 1001),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_type, sequence_date)
) STRICT;

CREATE TABLE document_numbers (
  id INTEGER PRIMARY KEY,
  document_type TEXT NOT NULL CHECK (document_type IN ('quotation', 'invoice', 'claim', 'credit_note')),
  sequence_date TEXT NOT NULL,
  sequence_value INTEGER NOT NULL CHECK (sequence_value >= 1001),
  client_initials TEXT NOT NULL,
  document_number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ALLOCATED', 'GENERATING', 'ISSUED', 'ISSUE_FAILED', 'CANCELLED')),
  entity_id INTEGER,
  allocated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (document_type, sequence_date, sequence_value),
  UNIQUE (document_type, document_number)
) STRICT;

CREATE INDEX quotations_customer_status_idx ON quotations(customer_id, status);
CREATE INDEX invoices_customer_status_idx ON invoices(customer_id, status);
CREATE INDEX claims_transaction_date_idx ON claims(transaction_date);
CREATE INDEX pending_confirmations_status_expiry_idx ON pending_confirmations(status, expires_at);
CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id, timestamp);
