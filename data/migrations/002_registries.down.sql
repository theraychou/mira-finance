DROP INDEX IF EXISTS customer_aliases_customer_idx;
DROP INDEX IF EXISTS customers_display_name_idx;
DROP INDEX IF EXISTS customers_code_normalized_uq;
DROP INDEX IF EXISTS tax_rules_country_active_idx;
DROP INDEX IF EXISTS bank_profiles_entity_currency_idx;
DROP TABLE IF EXISTS tax_rules;
DROP TABLE IF EXISTS bank_profiles;
DROP TABLE IF EXISTS currencies;
