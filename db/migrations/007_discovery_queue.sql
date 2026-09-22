-- Migration 007: roster discovery queue
--
-- OpenAQ's endpoints disagree: 517 locations return fresh in-bbox PM readings
-- from /v3/parameters/{id}/latest but are absent from the /v3/locations?bbox
-- roster (their /locations record apparently omits the PM sensor the latest
-- feed reports). Without metadata we cannot use them.
--
-- Measured worth of closing that gap: those 517 occupy 326 H3 r4 cells, of
-- which 182 contain NO live station at all -- extending coverage from 253 to
-- ~435 cells, a 72% gain. This matters for the core feature specifically:
-- attribution needs a downwind sensor, and fires burn in exactly the rural
-- terrain the well-documented urban stations do not cover.
--
-- Why a queue rather than inline discovery: resolving a location costs one
-- request each, ~10 minutes for 517 under a 60/min limit. An earlier attempt
-- did that inline inside roster refresh and wedged the run. Splitting it means
-- the CHEAP side (noticing an unknown id) happens in `latest` mode, which
-- already holds the bulk feed, and the EXPENSIVE side (resolving it) happens
-- in `stations` mode under a wall-clock budget, with failures recorded so they
-- are not retried forever.

CREATE TABLE IF NOT EXISTS aq_discovery_queue (
  upstream_id     bigint PRIMARY KEY,
  lat             double precision,
  lon             double precision,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  attempts        integer     NOT NULL DEFAULT 0,
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','resolved','failed','no_pm_sensor')),
  last_error      text
);

CREATE INDEX IF NOT EXISTS ix_aq_queue_pending
  ON aq_discovery_queue (status, first_seen_at) WHERE status = 'pending';

-- Visibility into the endpoint disagreement itself, so the agent can answer
-- "how complete is your station coverage?" honestly rather than implying the
-- roster is exhaustive.
CREATE OR REPLACE VIEW v_roster_coverage AS
SELECT
  (SELECT count(*) FROM aq_stations)                                      AS stations_known,
  (SELECT count(*) FROM aq_stations WHERE selected)                       AS stations_selected,
  (SELECT count(DISTINCT h3_r4) FROM aq_stations WHERE selected)          AS cells_covered,
  (SELECT count(*) FROM aq_discovery_queue WHERE status = 'pending')      AS gap_pending,
  (SELECT count(*) FROM aq_discovery_queue WHERE status = 'resolved')     AS gap_resolved,
  (SELECT count(*) FROM aq_discovery_queue WHERE status = 'failed')       AS gap_failed,
  (SELECT count(*) FROM aq_discovery_queue WHERE status = 'no_pm_sensor') AS gap_no_pm;
