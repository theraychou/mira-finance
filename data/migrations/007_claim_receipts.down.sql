DROP INDEX claim_filings_status_idx;
DROP INDEX claim_draft_versions_claim_idx;
DROP TRIGGER claim_filing_attempts_no_delete;
DROP TRIGGER claim_filing_attempts_no_update;
DROP TABLE claim_filing_attempts;
DROP TABLE claim_filings;
DROP TRIGGER claim_draft_versions_no_delete;
DROP TRIGGER claim_draft_versions_no_update;
DROP TABLE claim_draft_versions;
DROP TABLE claim_draft_state;
DROP INDEX claim_receipts_probable_duplicate_idx;
DROP TABLE claim_receipts;

