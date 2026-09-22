-- Migration 005: OpenAQ suspect-data flag
--
-- OpenAQ exposes its own quality flag (flagInfo.hasFlags) on
-- /v3/sensors/{id}/hours but NOT on the bulk /v3/parameters/{id}/latest
-- endpoint the live path depends on. The asymmetry is recorded honestly:
-- NULL means "this reading came from the bulk endpoint, which does not report
-- flags", which is different from false ("reported, and not flagged").
--
-- Deliberately NOT part of the dedupe key. value_hash covers the VALUE only,
-- so a reading seen live (flag unknown) and later backfilled (flag known)
-- stays one row instead of two. The cost is that flag-state changes are not
-- tracked as revisions; the alternative was duplicating measurements, which
-- would corrupt every aggregate.
ALTER TABLE aq_measurements ADD COLUMN IF NOT EXISTS has_flags boolean;

-- Suspect readings are rare, so a partial index keeps "show me flagged data"
-- cheap without carrying cost on the common path.
CREATE INDEX IF NOT EXISTS ix_aq_meas_flagged
  ON aq_measurements (event_time DESC) WHERE has_flags;
