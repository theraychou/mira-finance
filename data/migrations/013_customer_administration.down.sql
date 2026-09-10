DROP TRIGGER IF EXISTS customer_sheet_sync_attempts_no_delete;
DROP TRIGGER IF EXISTS customer_sheet_sync_attempts_no_update;
DROP TABLE IF EXISTS customer_sheet_sync_attempts;
DROP TABLE IF EXISTS customer_sheet_mirror_state;
DROP TRIGGER IF EXISTS customer_change_requests_no_delete;
DROP INDEX IF EXISTS customer_change_requests_status_idx;
DROP TABLE IF EXISTS customer_change_requests;
