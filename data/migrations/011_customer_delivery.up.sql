CREATE TABLE customer_delivery_contacts (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'WHATSAPP')),
  destination TEXT NOT NULL,
  normalized_destination TEXT NOT NULL,
  contact_name TEXT,
  verified_at TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  consent_at TEXT,
  consent_source TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (channel <> 'WHATSAPP' OR (consent_at IS NOT NULL AND consent_source IS NOT NULL)),
  UNIQUE (customer_id, channel, normalized_destination)
) STRICT;

CREATE INDEX customer_delivery_contacts_customer_channel_idx
  ON customer_delivery_contacts(customer_id, channel, active);

CREATE TABLE customer_delivery_requests (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  document_type TEXT NOT NULL CHECK (document_type IN ('quotation', 'invoice')),
  document_id INTEGER NOT NULL,
  document_number TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  contact_id INTEGER NOT NULL REFERENCES customer_delivery_contacts(id),
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'WHATSAPP')),
  artifact_relative_path TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  requesting_user TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_chat TEXT NOT NULL,
  source_message_reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'SENDING', 'SENT', 'FAILED', 'EXPIRED', 'CANCELLED')),
  expires_at TEXT NOT NULL,
  confirmed_by TEXT,
  confirmed_at TEXT,
  sent_at TEXT,
  last_error_code TEXT,
  resend_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'PENDING' AND confirmed_by IS NULL AND confirmed_at IS NULL) OR status <> 'PENDING'),
  CHECK ((status IN ('CONFIRMED', 'SENDING', 'SENT', 'FAILED') AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL) OR status NOT IN ('CONFIRMED', 'SENDING', 'SENT', 'FAILED'))
) STRICT;

CREATE INDEX customer_delivery_requests_document_idx
  ON customer_delivery_requests(document_type, document_id, status);
CREATE INDEX customer_delivery_requests_contact_idx
  ON customer_delivery_requests(contact_id, status);

CREATE TABLE customer_delivery_attempts (
  id INTEGER PRIMARY KEY,
  delivery_request_id INTEGER NOT NULL REFERENCES customer_delivery_requests(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  result TEXT NOT NULL CHECK (result IN ('SENT', 'FAILED')),
  provider_reference_hash TEXT CHECK (provider_reference_hash IS NULL OR length(provider_reference_hash) = 64),
  error_code TEXT,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (delivery_request_id, attempt_number)
) STRICT;

CREATE TRIGGER customer_delivery_attempts_no_update
BEFORE UPDATE ON customer_delivery_attempts
BEGIN SELECT RAISE(ABORT, 'customer delivery attempts are append-only'); END;

CREATE TRIGGER customer_delivery_attempts_no_delete
BEFORE DELETE ON customer_delivery_attempts
BEGIN SELECT RAISE(ABORT, 'customer delivery attempts are append-only'); END;
