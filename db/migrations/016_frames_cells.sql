-- Migration 016: r4 cells on detections and sample points, for frame rollup
--
-- hourly_frames is keyed on (frame_time, h3_r4) because it serves the
-- CLIENT-SIDE scrub: the browser holds the frames and renders each timeline
-- position without a network round trip. That means frames must cover cells
-- holding fires even where no station exists -- most fire country has no
-- sensor -- so detections and sample points both need an r4 cell.
--
-- r4 (~1,770 km2, 26 km edge) is the frame grain: fine enough for a regional
-- map, coarse enough that a week of hourly frames stays a small Parquet file.
ALTER TABLE fire_detections ADD COLUMN IF NOT EXISTS h3_r4 text;
ALTER TABLE sample_points  ADD COLUMN IF NOT EXISTS h3_r4 text;

CREATE INDEX IF NOT EXISTS ix_fire_det_h3r4 ON fire_detections (h3_r4, event_time DESC);
CREATE INDEX IF NOT EXISTS ix_sample_h3r4   ON sample_points (h3_r4);

-- Region-wide hourly series: what the timeline chart plots. Tiny (one row per
-- hour) and computed from frames so chart and map cannot disagree.
CREATE OR REPLACE VIEW v_timeline_series AS
SELECT
  frame_time,
  sum(fire_count)                                    AS fire_count,
  sum(fire_count_confident)                          AS fire_count_confident,
  round(sum(total_frp_mw)::numeric, 1)               AS total_frp_mw,
  sum(station_count)                                 AS station_count,
  round(max(pm25_obs_max)::numeric, 1)               AS pm25_obs_max,
  round((sum(pm25_obs_mean * station_count)
         / nullif(sum(station_count), 0))::numeric, 1) AS pm25_obs_mean,
  round(avg(pm25_model_mean)::numeric, 1)            AS pm25_model_mean,
  max(us_aqi_max)                                    AS us_aqi_max,
  round(max(top_attribution_score)::numeric, 3)      AS top_attribution_score,
  count(*)                                           AS cells,
  count(*) FILTER (WHERE is_partial)                 AS partial_cells
FROM hourly_frames
GROUP BY frame_time;
