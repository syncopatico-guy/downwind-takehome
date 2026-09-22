-- Migration 004: OpenAQ station dimension, sensor registry, and station selection
--
-- Context established by probing the API:
--   * 2,566 distinct locations sit inside our bbox, ~1,589 reporting within 3h;
--     the rest are long dead (one sampled station last reported in 2016).
--   * `isMonitor` cleanly separates regulatory monitors (779/1000 sampled,
--     provider AirNow) from low-cost community sensors (221/1000: Clarity,
--     'west oakland', 'richmond beaco2n'). This IS the conflict lever.
--   * Rate limit is 60 requests / 60 seconds, so measurements are read from the
--     bulk /v3/parameters/{id}/latest endpoint, not per sensor.
--
-- Why a station cap exists at all: each retained station costs THREE hourly
-- rows -- one measurement, plus a weather_hourly and a model_aq_hourly row,
-- because wind and CAMS are sampled at its coordinates. Keeping all ~2,000 live
-- sensors would cost ~233 MB for seven days alone, against a 500 MB ceiling.
--
-- ALL discovered stations are stored regardless (a dimension table is cheap),
-- and `selected` marks those whose measurements we ingest. The selection runs
-- as an auditable SQL pass, so the cap can change without re-discovery.

ALTER TABLE aq_stations ADD COLUMN IF NOT EXISTS is_monitor       boolean;
ALTER TABLE aq_stations ADD COLUMN IF NOT EXISTS is_mobile        boolean;
ALTER TABLE aq_stations ADD COLUMN IF NOT EXISTS instruments      text[];
ALTER TABLE aq_stations ADD COLUMN IF NOT EXISTS locality         text;
ALTER TABLE aq_stations ADD COLUMN IF NOT EXISTS owner_name       text;
-- Coverage window as reported by OpenAQ. datetime_last is how a dead sensor is
-- distinguished from a live one that simply has not reported this hour.
ALTER TABLE aq_stations ADD COLUMN IF NOT EXISTS datetime_first   timestamptz;
ALTER TABLE aq_stations ADD COLUMN IF NOT EXISTS datetime_last    timestamptz;
ALTER TABLE aq_stations ADD COLUMN IF NOT EXISTS selected         boolean NOT NULL DEFAULT false;
-- 'reference' | 'paired_low_cost' | 'spatial_fill' -- recorded so the sampling
-- is defensible and reproducible rather than an opaque truncation.
ALTER TABLE aq_stations ADD COLUMN IF NOT EXISTS selection_reason text;
ALTER TABLE aq_stations ADD COLUMN IF NOT EXISTS selected_at      timestamptz;

CREATE INDEX IF NOT EXISTS ix_aq_stations_selected
  ON aq_stations (selected) WHERE selected;
CREATE INDEX IF NOT EXISTS ix_aq_stations_last
  ON aq_stations (datetime_last DESC);

-- One row per (station, parameter). Needed because historical backfill reads
-- /v3/sensors/{id}/hours, which is addressed by SENSOR id, not station id --
-- and one such request returns a whole date range (verified: 168/168 hourly
-- values for a 7-day window).
CREATE TABLE IF NOT EXISTS aq_sensors (
  sensor_id   bigint PRIMARY KEY,
  station_id  text        NOT NULL REFERENCES aq_stations(station_id),
  parameter   text        NOT NULL,
  units       text,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (station_id, parameter, sensor_id)
);

CREATE INDEX IF NOT EXISTS ix_aq_sensors_station ON aq_sensors (station_id);
CREATE INDEX IF NOT EXISTS ix_aq_sensors_param   ON aq_sensors (parameter);

-- Which sensor produced a reading: part of the evidence chain the agent cites.
ALTER TABLE aq_measurements ADD COLUMN IF NOT EXISTS sensor_id bigint;
CREATE INDEX IF NOT EXISTS ix_aq_meas_sensor ON aq_measurements (sensor_id, event_time DESC);

-- ---------------------------------------------------------------------------
-- Station selection, as an auditable function
-- ---------------------------------------------------------------------------
--
-- Priority order, which encodes what the product actually needs from stations:
--   1. reference        every live regulatory monitor -- the authoritative
--                       readings the agent will cite
--   2. paired_low_cost  every live low-cost sensor within `pair_km` of a
--                       selected reference monitor, so reference-vs-low-cost
--                       disagreement is demonstrable as a PAIR rather than
--                       inferred across distance
--   3. spatial_fill     in H3 r5 cells still holding no selected station, the
--                       most recently reporting one -- so a fire is not left
--                       without any downwind sensor
--
CREATE OR REPLACE FUNCTION select_aq_stations(
  max_stations integer DEFAULT 800,
  live_within  interval DEFAULT '24 hours',
  pair_km      double precision DEFAULT 10
) RETURNS TABLE(reason text, n bigint) AS $$
BEGIN
  UPDATE aq_stations SET selected = false, selection_reason = NULL, selected_at = NULL;

  -- Only stations that are live, fixed, and measure something we care about.
  CREATE TEMP TABLE _eligible ON COMMIT DROP AS
  SELECT s.station_id, s.geom, s.h3_r6, s.instrument_tier, s.datetime_last
    FROM aq_stations s
   WHERE coalesce(s.is_mobile, false) = false
     AND s.datetime_last IS NOT NULL
     AND s.datetime_last > now() - live_within
     AND EXISTS (SELECT 1 FROM aq_sensors sn
                  WHERE sn.station_id = s.station_id
                    AND sn.parameter IN ('pm25','pm10'));

  -- 1. reference monitors
  UPDATE aq_stations t SET selected = true, selection_reason = 'reference', selected_at = now()
    FROM _eligible e
   WHERE t.station_id = e.station_id AND e.instrument_tier = 'reference';

  -- 2. low-cost sensors close enough to a reference monitor to be compared
  UPDATE aq_stations t SET selected = true, selection_reason = 'paired_low_cost', selected_at = now()
    FROM _eligible e
   WHERE t.station_id = e.station_id
     AND e.instrument_tier <> 'reference'
     AND t.selected = false
     AND EXISTS (
       SELECT 1 FROM aq_stations r
        WHERE r.selected AND r.selection_reason = 'reference'
          AND ST_DWithin(r.geom, e.geom, pair_km * 1000)
     );

  -- 3. spatial fill: one station per otherwise-empty r5 cell
  UPDATE aq_stations t SET selected = true, selection_reason = 'spatial_fill', selected_at = now()
   WHERE t.station_id IN (
     SELECT DISTINCT ON (e.h3_r6) e.station_id
       FROM _eligible e
      WHERE NOT EXISTS (
        SELECT 1 FROM aq_stations sel
         WHERE sel.selected AND sel.h3_r6 = e.h3_r6)
      ORDER BY e.h3_r6, e.datetime_last DESC
   );

  -- Enforce the cap, dropping the lowest-priority and least-recent first.
  UPDATE aq_stations SET selected = false, selection_reason = NULL, selected_at = NULL
   WHERE station_id IN (
     SELECT station_id FROM (
       SELECT station_id,
              row_number() OVER (
                ORDER BY CASE selection_reason
                           WHEN 'reference' THEN 1
                           WHEN 'paired_low_cost' THEN 2
                           ELSE 3 END,
                         datetime_last DESC) AS rn
         FROM aq_stations WHERE selected
     ) ranked WHERE rn > max_stations
   );

  RETURN QUERY
    SELECT coalesce(a.selection_reason,'(none)')::text, count(*)
      FROM aq_stations a WHERE a.selected GROUP BY 1 ORDER BY 1;
END;
$$ LANGUAGE plpgsql;
