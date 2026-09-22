-- Migration 015: attribution evidence columns
--
-- Every attribution row must carry its OWN evidence. The brief asks for
-- answers that can be followed to their source, and attribution is the one
-- place this system makes a causal claim -- so the claim travels with the
-- numbers that produced it, not a bare score the agent would have to be
-- trusted about.
--
-- Scoring is a plausibility HYPOTHESIS, never a concentration prediction. It
-- is the product of four interpretable factors, each stored separately so the
-- agent can say WHICH one carried the claim:
--
--   alignment_factor  exp(-(alignment/30)^2)      how well the wind pointed
--                                                 from the fire to the station
--   distance_factor   1/(1+(distance/50)^2)       dilution with distance
--   frp_factor        ln(1+frp)/ln(1+frp_ref)     fire intensity, log-scaled
--   pbl_factor        clamp(800/pbl, 0.5, 2.5)    a shallow mixing layer
--                                                 concentrates smoke at the
--                                                 surface, which is why a
--                                                 moderate fire can produce
--                                                 severe readings
ALTER TABLE smoke_attributions ADD COLUMN IF NOT EXISTS lagged_event_time timestamptz;
ALTER TABLE smoke_attributions ADD COLUMN IF NOT EXISTS frp_at_lag        real;
ALTER TABLE smoke_attributions ADD COLUMN IF NOT EXISTS observed_pm25     real;
ALTER TABLE smoke_attributions ADD COLUMN IF NOT EXISTS baseline_pm25     real;
ALTER TABLE smoke_attributions ADD COLUMN IF NOT EXISTS alignment_factor  real;
ALTER TABLE smoke_attributions ADD COLUMN IF NOT EXISTS distance_factor   real;
ALTER TABLE smoke_attributions ADD COLUMN IF NOT EXISTS frp_factor        real;
ALTER TABLE smoke_attributions ADD COLUMN IF NOT EXISTS pbl_factor        real;
ALTER TABLE smoke_attributions ADD COLUMN IF NOT EXISTS source_character  text;
ALTER TABLE smoke_attributions ADD COLUMN IF NOT EXISTS run_id            bigint;

CREATE INDEX IF NOT EXISTS ix_attr_station_time_score
  ON smoke_attributions (station_id, event_time DESC, score DESC);

-- Per station-hour: the ranked explanation, with the leading candidate named.
-- This is what the agent's explain_smoke tool reads.
CREATE OR REPLACE VIEW v_smoke_explanations AS
SELECT
  a.station_id,
  a.event_time,
  a.observed_pm25,
  a.baseline_pm25,
  round((a.observed_pm25 / nullif(a.baseline_pm25, 0))::numeric, 2) AS ratio_to_baseline,
  count(*)                                    AS candidate_count,
  round(max(a.score)::numeric, 3)             AS top_score,
  round(sum(a.score)::numeric, 3)             AS total_score,
  (array_agg(c.cluster_key      ORDER BY a.score DESC))[1] AS top_cluster_key,
  (array_agg(c.label            ORDER BY a.score DESC))[1] AS top_cluster_label,
  (array_agg(c.source_character ORDER BY a.score DESC))[1] AS top_source_character,
  (array_agg(round(a.distance_km::numeric,1)  ORDER BY a.score DESC))[1] AS top_distance_km,
  (array_agg(round(a.alignment_deg::numeric,1) ORDER BY a.score DESC))[1] AS top_alignment_deg,
  (array_agg(round(a.travel_hours::numeric,1)  ORDER BY a.score DESC))[1] AS top_travel_hours,
  (array_agg(round(a.frp_at_lag::numeric,1)    ORDER BY a.score DESC))[1] AS top_frp_at_lag,
  -- A claim resting entirely on industrial sources is a different claim from
  -- one resting on wildfires, and must not be reported as wildfire smoke.
  bool_and(c.source_character = 'likely_industrial') AS all_industrial,
  a.method_version
FROM smoke_attributions a
JOIN fire_clusters c ON c.cluster_id = a.cluster_id
GROUP BY a.station_id, a.event_time, a.observed_pm25, a.baseline_pm25, a.method_version;
