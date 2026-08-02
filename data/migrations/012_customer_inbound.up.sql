CREATE TABLE customer_inbound_messages (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'WHATSAPP')),
  provider_message_hash TEXT NOT NULL CHECK (length(provider_message_hash) = 64),
  provider_message_id TEXT NOT NULL,
  provider_thread_hash TEXT CHECK (provider_thread_hash IS NULL OR length(provider_thread_hash) = 64),
  provider_thread_id TEXT,
  session_key_hash TEXT CHECK (session_key_hash IS NULL OR length(session_key_hash) = 64),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  contact_id INTEGER NOT NULL REFERENCES customer_delivery_contacts(id),
  sender TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  received_at TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('INVOICE_STATUS', 'QUOTATION_STATUS', 'UNKNOWN', 'ATTACHMENT_REVIEW')),
  document_type TEXT CHECK (document_type IN ('invoice', 'quotation')),
  document_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('RECEIVED', 'AUTO_REPLIED', 'ESCALATED', 'FAILED')),
  response_text TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel, provider_message_hash)
) STRICT;

CREATE INDEX customer_inbound_messages_contact_idx ON customer_inbound_messages(contact_id, received_at);
CREATE INDEX customer_inbound_messages_status_idx ON customer_inbound_messages(status, received_at);
CREATE INDEX customer_inbound_messages_session_idx ON customer_inbound_messages(channel, session_key_hash, status);

CREATE TABLE customer_reply_escalations (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  inbound_message_id INTEGER NOT NULL UNIQUE REFERENCES customer_inbound_messages(id),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'PENDING_CONFIRMATION', 'SENDING', 'RESOLVED', 'FAILED', 'CANCELLED', 'EXPIRED')),
  proposed_response TEXT,
  proposal_hash TEXT CHECK (proposal_hash IS NULL OR length(proposal_hash) = 64),
  requesting_user TEXT,
  source_channel TEXT,
  source_chat TEXT,
  confirmation_token TEXT UNIQUE,
  confirmation_expires_at TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX customer_reply_escalations_status_idx ON customer_reply_escalations(status, created_at);

CREATE TABLE customer_inbound_response_attempts (
  id INTEGER PRIMARY KEY,
  inbound_message_id INTEGER NOT NULL REFERENCES customer_inbound_messages(id),
  escalation_id INTEGER REFERENCES customer_reply_escalations(id),
  response_kind TEXT NOT NULL CHECK (response_kind IN ('AUTOMATIC', 'ACKNOWLEDGEMENT', 'RAY_APPROVED')),
  result TEXT NOT NULL CHECK (result IN ('SENT', 'FAILED')),
  response_sha256 TEXT NOT NULL CHECK (length(response_sha256) = 64),
  provider_reference_hash TEXT CHECK (provider_reference_hash IS NULL OR length(provider_reference_hash) = 64),
  error_code TEXT,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER customer_inbound_response_attempts_no_update
BEFORE UPDATE ON customer_inbound_response_attempts
BEGIN SELECT RAISE(ABORT, 'customer inbound response attempts are append-only'); END;

CREATE TRIGGER customer_inbound_response_attempts_no_delete
BEFORE DELETE ON customer_inbound_response_attempts
BEGIN SELECT RAISE(ABORT, 'customer inbound response attempts are append-only'); END;
