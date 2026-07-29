CREATE TABLE currencies (
  code TEXT PRIMARY KEY CHECK (code IN ('MYR', 'SGD', 'USD')),
  minor_units INTEGER NOT NULL CHECK (minor_units BETWEEN 0 AND 4),
  symbol TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  quotation_template_id TEXT,
  invoice_template_id TEXT,
  default_bank_profile_id TEXT,
  default_tax_rule_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO currencies (
  code, minor_units, symbol, enabled, quotation_template_id,
  invoice_template_id, created_at, updated_at
) VALUES
  ('MYR', 2, 'RM', 1, 'quotation-myr', 'invoice-myr', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z'),
  ('SGD', 2, 'SGD', 1, 'quotation-sgd', 'invoice-sgd', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z'),
  ('USD', 2, 'USD', 1, 'quotation-usd', 'invoice-usd', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z');

CREATE TABLE bank_profiles (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  business_entity_id INTEGER NOT NULL REFERENCES business_entities(id),
  currency TEXT NOT NULL REFERENCES currencies(code),
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  bank_address TEXT,
  swift_code TEXT,
  routing_code TEXT,
  additional_instructions TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE tax_rules (
  id INTEGER PRIMARY KEY,
  country TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  rate_basis_points INTEGER NOT NULL CHECK (rate_basis_points >= 0),
  calculation_method TEXT NOT NULL CHECK (calculation_method IN ('EXCLUSIVE', 'INCLUSIVE', 'NONE')),
  display_label TEXT NOT NULL,
  registration_number TEXT,
  effective_from TEXT,
  effective_until TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until >= effective_from)
) STRICT;

CREATE INDEX bank_profiles_entity_currency_idx ON bank_profiles(business_entity_id, currency, active);
CREATE INDEX tax_rules_country_active_idx ON tax_rules(country, active);
CREATE UNIQUE INDEX customers_code_normalized_uq ON customers(lower(customer_code));
CREATE INDEX customers_display_name_idx ON customers(display_name, active);
CREATE INDEX customer_aliases_customer_idx ON customer_aliases(customer_id);
