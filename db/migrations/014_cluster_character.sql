-- Migration 014: source character, and honest labels
--
-- FINDING: FIRMS detects industrial heat as fire. Refinery flares, cement
-- plants and oil-sands facilities appear as clusters that burn continuously
-- for a week at a fixed ~500 m footprint with steady intensity. Confirmed
-- against known locations: Ferndale WA refineries (39 detections, 7.1 days),
-- Edmonton refinery row (25 / 6.1 days), Seattle's Duwamish industrial area
-- (34 / 7.0 days), Victorville cement plants (36 / 7.0 days).
--
-- FRP variability separates them cleanly, because the physics differ: a
-- wildfire's intensity swings as it consumes fuel and the weather shifts,
-- while a flare burns steadily.
--
--   wildfires   spread 1,458-4,799 m   FRP CV 0.63-2.60
--   industrial  spread   291-  610 m   FRP CV 0.30-0.37
--
-- They are FLAGGED, not excluded. A refinery is a real emission source and a
-- station downwind of Ferndale genuinely reads elevated PM -- excluding it
-- would leave that reading with no attributable cause. What matters is that
-- the agent never calls it a wildfire.
ALTER TABLE fire_clusters ADD COLUMN IF NOT EXISTS footprint_spread_m real;
ALTER TABLE fire_clusters ADD COLUMN IF NOT EXISTS frp_cv              real;
ALTER TABLE fire_clusters ADD COLUMN IF NOT EXISTS duration_days       real;
ALTER TABLE fire_clusters ADD COLUMN IF NOT EXISTS source_character    text
  NOT NULL DEFAULT 'indeterminate'
  CHECK (source_character IN ('likely_wildfire','likely_industrial','indeterminate'));

CREATE INDEX IF NOT EXISTS ix_clusters_character ON fire_clusters (source_character);

-- LABELS: the previous heuristic took the NEAREST NWS zone within 60 km, and
-- measurement showed it named a neighbouring zone rather than the containing
-- one 223 times out of 358 -- including 18 clusters in Mexico and 6 in Canada
-- carrying US place names. "Imperial" for a fire 30 km inside Baja California
-- is precisely the kind of statement the agent would cite and be wrong about.
--
-- Labels are now assigned ONLY where the centroid lies inside the zone, so
-- every label is a true statement. Coverage drops (135 of 617) and the
-- remainder are described by coordinates and region, which is honest rather
-- than merely quieter.
UPDATE fire_clusters SET label = NULL, label_source = NULL
 WHERE label IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM nws_zones z
      WHERE z.name = fire_clusters.label AND z.geom IS NOT NULL
        AND ST_Intersects(z.geom, fire_clusters.centroid));

DROP VIEW IF EXISTS v_fire_clusters_active;
CREATE VIEW v_fire_clusters_active AS
SELECT
  c.cluster_id, c.cluster_key, c.label, c.label_source,
  c.source_character,
  c.first_event_time, c.last_event_time,
  c.centroid, c.h3_r5, c.region,
  c.detection_count, c.total_frp_mw, c.max_frp_mw,
  c.mean_confidence, c.low_confidence_share,
  c.footprint_spread_m, c.frp_cv, c.duration_days,
  EXTRACT(EPOCH FROM (now() - c.last_event_time))::bigint AS seconds_since_detection,
  (SELECT count(*) FROM fire_detections d
    WHERE d.cluster_id = c.cluster_id
      AND d.event_time > now() - interval '24 hours')            AS detections_24h,
  (SELECT round(coalesce(sum(d.frp_mw),0)::numeric,1) FROM fire_detections d
    WHERE d.cluster_id = c.cluster_id
      AND d.event_time > now() - interval '24 hours')            AS frp_24h,
  c.method_version, c.computed_at
FROM fire_clusters c
WHERE c.is_active;
