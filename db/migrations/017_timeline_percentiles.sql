-- Migration 017: the timeline series needs percentiles, not maxima
--
-- BUG in the first version: it plotted max(us_aqi_max) and max(pm25_obs_max)
-- across every cell, which reports the single worst point in a 3-million-km2
-- region. That is always extreme somewhere, so the line sat flat at 350-366
-- ("Hazardous") while the regional median AQI was 39. Technically correct,
-- practically a lie.
--
-- The underlying data was fine -- AQI distribution is p50 39 / p90 59 / p99 79
-- and internally consistent with its own PM2.5. Only the aggregation was wrong.
--
-- Percentiles are what a regional series should show, with the max retained
-- separately and clearly named so a single hot station cannot masquerade as
-- the regional condition.
-- CREATE OR REPLACE cannot change a view's column list (same restriction hit
-- in migration 012), and this revision replaces maxima with percentiles.
DROP VIEW IF EXISTS v_timeline_series;
CREATE VIEW v_timeline_series AS
SELECT
  frame_time,
  sum(fire_count)                                     AS fire_count,
  sum(fire_count_confident)                           AS fire_count_confident,
  round(sum(total_frp_mw)::numeric, 1)                AS total_frp_mw,
  sum(station_count)                                  AS station_count,

  -- Regional condition: what most places were like.
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY pm25_obs_mean)::numeric, 1)  AS pm25_p50,
  round(percentile_cont(0.9) WITHIN GROUP (ORDER BY pm25_obs_max)::numeric, 1)   AS pm25_p90,
  round(percentile_cont(0.99) WITHIN GROUP (ORDER BY pm25_obs_max)::numeric, 1)  AS pm25_p99,
  -- Retained, but named so it cannot be mistaken for the regional level.
  round(max(pm25_obs_max)::numeric, 1)                                           AS pm25_worst_cell,

  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY pm25_model_mean)::numeric, 1) AS pm25_model_p50,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY us_aqi_max)::int                    AS us_aqi_p50,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY us_aqi_max)::int                    AS us_aqi_p90,
  max(us_aqi_max)                                                                 AS us_aqi_worst_cell,

  round(max(top_attribution_score)::numeric, 3)       AS top_attribution_score,
  count(*) FILTER (WHERE top_attribution_score > 0)   AS cells_with_attribution,
  count(*)                                            AS cells,
  count(*) FILTER (WHERE is_partial)                  AS partial_cells
FROM hourly_frames
GROUP BY frame_time;

-- Corroboration: does any nearby station agree with an extreme reading?
-- An isolated 985 µg/m³ spike on a station whose own median is 7.5, with
-- neighbours reading single digits, is a different claim from a genuine local
-- event. The agent is given the neighbour comparison rather than a verdict --
-- a reference-grade monitor spiking 130x could be a structure fire or a
-- calibration artifact, and the data should say which is plausible.
CREATE OR REPLACE VIEW v_reading_corroboration AS
SELECT
  m.station_id,
  m.event_time,
  m.value                                              AS value,
  s.instrument_tier,
  s.provider,
  (SELECT count(*) FROM aq_measurements n
     JOIN aq_stations ns ON ns.station_id = n.station_id
    WHERE n.parameter = 'pm25' AND n.event_time = m.event_time
      AND n.station_id <> m.station_id
      AND ST_DWithin(ns.geom, s.geom, 25000))          AS neighbours_reporting,
  (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY n.value)::numeric, 1)
     FROM aq_measurements n
     JOIN aq_stations ns ON ns.station_id = n.station_id
    WHERE n.parameter = 'pm25' AND n.event_time = m.event_time
      AND n.station_id <> m.station_id
      AND ST_DWithin(ns.geom, s.geom, 25000))          AS neighbour_median_pm25
FROM aq_measurements m
JOIN aq_stations s ON s.station_id = m.station_id
WHERE m.parameter = 'pm25' AND m.value >= 100;
