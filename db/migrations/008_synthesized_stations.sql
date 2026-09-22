-- Migration 008: stations synthesized from the measurement feed
--
-- Established by probing, after three attempts at the wrong approach:
--   * 506 locations publish fresh in-bbox readings via
--     /v3/parameters/{id}/latest but return HTTP 404 "Location not found"
--     from /v3/locations/{id}. They are gone from the locations API while
--     their measurements keep flowing.
--   * /v3/sensors/{id} DOES resolve for them, but carries no coordinates,
--     name, provider or isMonitor -- only parameter, units and coverage.
--   * The bulk measurement feed already carries coordinates for every reading.
--
-- So these stations can be reconstructed from data we fetch anyway, at ZERO
-- additional API cost. The ten minutes of individual lookups this replaces
-- would have returned 404 every time.
--
-- What is recoverable: coordinates, sensor id, parameter, readings.
-- What is NOT: name, provider, instrument_tier.
--
-- metadata_source records which path produced a station row, so a synthesized
-- record is never mistaken for one with full provenance. Their tier stays
-- 'unknown' rather than being guessed at -- they are probably low-cost given
-- the pattern, but probably is not a basis for a claim the agent will cite.

ALTER TABLE aq_stations
  ADD COLUMN IF NOT EXISTS metadata_source text NOT NULL DEFAULT 'locations_api'
  CHECK (metadata_source IN ('locations_api','bulk_feed_synthesized'));

CREATE INDEX IF NOT EXISTS ix_aq_stations_metasource ON aq_stations (metadata_source);

-- Widen the queue's terminal states: 'synthesized' means we gave up on the
-- locations API for that id and reconstructed it from measurements instead.
ALTER TABLE aq_discovery_queue DROP CONSTRAINT IF EXISTS aq_discovery_queue_status_check;
ALTER TABLE aq_discovery_queue ADD CONSTRAINT aq_discovery_queue_status_check
  CHECK (status IN ('pending','resolved','failed','no_pm_sensor','synthesized','no_location_record'));

-- Everything attempted so far 404'd; reset so the synthesis path can claim them.
UPDATE aq_discovery_queue
   SET status = 'pending', attempts = 0,
       last_error = 'locations API returns 404; recoverable only by synthesis'
 WHERE status IN ('failed','pending') AND attempts > 0;

-- Honest answer to "how complete is your station coverage, and how well do you
-- know these stations?" -- replaces the earlier view.
DROP VIEW IF EXISTS v_roster_coverage;
CREATE VIEW v_roster_coverage AS
SELECT
  (SELECT count(*) FROM aq_stations)                                             AS stations_known,
  (SELECT count(*) FROM aq_stations WHERE metadata_source = 'locations_api')     AS stations_full_metadata,
  (SELECT count(*) FROM aq_stations WHERE metadata_source = 'bulk_feed_synthesized') AS stations_synthesized,
  (SELECT count(*) FROM aq_stations WHERE selected)                              AS stations_selected,
  (SELECT count(*) FROM aq_stations WHERE selected AND metadata_source = 'bulk_feed_synthesized') AS selected_synthesized,
  (SELECT count(DISTINCT h3_r4) FROM aq_stations WHERE selected)                 AS cells_covered,
  (SELECT count(*) FROM aq_stations WHERE selected AND instrument_tier = 'reference') AS selected_reference,
  (SELECT count(*) FROM aq_stations WHERE selected AND instrument_tier = 'low_cost')  AS selected_low_cost,
  (SELECT count(*) FROM aq_stations WHERE selected AND instrument_tier = 'unknown')   AS selected_unknown_tier,
  (SELECT count(*) FROM aq_discovery_queue WHERE status = 'pending')             AS gap_pending,
  (SELECT count(*) FROM aq_discovery_queue WHERE status = 'synthesized')         AS gap_synthesized;
