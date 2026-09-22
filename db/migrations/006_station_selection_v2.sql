-- Migration 006: corrected station selection
--
-- Two problems with the v1 selection, both found by running it:
--
-- 1. SPATIAL FILL AT THE WRONG RESOLUTION. It filled "empty" h3_r6 cells, but
--    r6 is ~36 km2 and 1,401 live stations occupy 766 distinct r6 cells -- so
--    almost every station had its own cell and "fill the gaps" selected nearly
--    everything. Result: 668 spatial_fill vs 42 reference, inverting the
--    intended priority. Fixed by grouping at r4 (~1,770 km2) and selecting
--    ROUND-ROBIN across cells, which both spreads coverage evenly and fills
--    exactly to the cap.
--
-- 2. THE REFERENCE TIER IS NEARLY EMPTY. Only 42 of 856 regulatory monitors
--    reported within 24h (6 within 3h). Verified as a genuine upstream
--    condition, not stale metadata: every station the bulk feed shows as fresh
--    is also marked fresh by /locations, with zero discrepancies. AirNow has
--    effectively stopped feeding OpenAQ for this region.
--
--    The live network is therefore almost entirely low-cost community sensors
--    (AirGradient 713, Clarity 552, AirNow 6). The 'reference vs low-cost pair'
--    conflict design does not survive that, so instrument tier becomes a
--    first-class CAVEAT the agent must state, and the conflict story rests on
--    model-vs-measurement (CAMS vs sensors) and sensor-vs-sensor disagreement.
--    Selection still prioritises what reference monitors exist -- they are just
--    no longer the backbone.

ALTER TABLE aq_stations ADD COLUMN IF NOT EXISTS h3_r4 text;
CREATE INDEX IF NOT EXISTS ix_aq_stations_h3r4 ON aq_stations (h3_r4);

DROP FUNCTION IF EXISTS select_aq_stations(integer, interval, double precision);

CREATE OR REPLACE FUNCTION select_aq_stations(
  max_stations integer DEFAULT 800,
  live_within  interval DEFAULT '24 hours',
  pair_km      double precision DEFAULT 10
) RETURNS TABLE(reason text, n bigint) AS $$
DECLARE
  remaining integer;
BEGIN
  UPDATE aq_stations SET selected = false, selection_reason = NULL, selected_at = NULL;

  DROP TABLE IF EXISTS _eligible;
  CREATE TEMP TABLE _eligible AS
  SELECT s.station_id, s.geom, s.h3_r4, s.instrument_tier, s.datetime_last
    FROM aq_stations s
   WHERE coalesce(s.is_mobile, false) = false
     AND s.datetime_last IS NOT NULL
     AND s.datetime_last > now() - live_within
     AND s.h3_r4 IS NOT NULL
     AND EXISTS (SELECT 1 FROM aq_sensors sn
                  WHERE sn.station_id = s.station_id
                    AND sn.parameter IN ('pm25','pm10'));

  -- 1. Every live regulatory monitor. Scarce, but the most authoritative
  --    readings available, so they are never displaced by the cap.
  UPDATE aq_stations t
     SET selected = true, selection_reason = 'reference', selected_at = now()
    FROM _eligible e
   WHERE t.station_id = e.station_id AND e.instrument_tier = 'reference';

  -- 2. Low-cost sensors close enough to a reference monitor to be compared
  --    directly. Few now, but each one is a genuine like-for-like pair.
  UPDATE aq_stations t
     SET selected = true, selection_reason = 'paired_low_cost', selected_at = now()
    FROM _eligible e
   WHERE t.station_id = e.station_id
     AND e.instrument_tier <> 'reference'
     AND t.selected = false
     AND EXISTS (SELECT 1 FROM aq_stations r
                  WHERE r.selected AND r.selection_reason = 'reference'
                    AND ST_DWithin(r.geom, e.geom, pair_km * 1000));

  SELECT max_stations - count(*) INTO remaining FROM aq_stations WHERE selected;

  -- 3. Round-robin across r4 cells: take the most recent station from every
  --    cell, then the second from every cell, and so on until the cap is met.
  --    This spreads coverage geographically instead of concentrating it in
  --    whichever cities happen to have the densest sensor networks -- which
  --    matters because a fire needs SOME downwind sensor, wherever it burns.
  IF remaining > 0 THEN
    UPDATE aq_stations t
       SET selected = true, selection_reason = 'spatial_fill', selected_at = now()
     WHERE t.station_id IN (
       SELECT station_id FROM (
         SELECT e.station_id,
                row_number() OVER (PARTITION BY e.h3_r4 ORDER BY e.datetime_last DESC) AS rn_in_cell,
                e.datetime_last
           FROM _eligible e
           JOIN aq_stations a ON a.station_id = e.station_id
          WHERE a.selected = false
       ) x
       ORDER BY rn_in_cell ASC, datetime_last DESC
       LIMIT remaining
     );
  END IF;

  -- Safety net only; round-robin already fills to exactly the cap.
  UPDATE aq_stations SET selected = false, selection_reason = NULL, selected_at = NULL
   WHERE station_id IN (
     SELECT station_id FROM (
       SELECT station_id, row_number() OVER (
                ORDER BY CASE selection_reason
                           WHEN 'reference' THEN 1
                           WHEN 'paired_low_cost' THEN 2
                           ELSE 3 END,
                         datetime_last DESC) AS rn
         FROM aq_stations WHERE selected
     ) r WHERE rn > max_stations
   );

  DROP TABLE IF EXISTS _eligible;

  RETURN QUERY
    SELECT coalesce(a.selection_reason,'(none)')::text, count(*)
      FROM aq_stations a WHERE a.selected GROUP BY 1 ORDER BY 1;
END;
$$ LANGUAGE plpgsql;
