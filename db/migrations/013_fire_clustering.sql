-- Migration 013: fire cluster identity and merge history
--
-- Parameters chosen from measured data rather than intuition:
--   eps = 1500 m, minpoints = 2. Nearest-neighbour distance between detections
--   is p50 84 m / p90 376 m, then jumps to 28 km at p99 -- detections cluster
--   far tighter than the 375 m pixel because three satellites across multiple
--   overpasses report the same fire at slightly offset coordinates. Cluster
--   count barely moves across that gap (545 at eps=750 vs 427 at eps=5000),
--   which is the signature of genuinely separated groups rather than an
--   arbitrary cut. minpoints=2 keeps small fires as real entities and
--   qualifies them by confidence instead of discarding them.
--
--   48 h temporal split. The maximum observed gap WITHIN a continuously
--   burning fire is 14-24 h -- satellite overpass spacing and cloud cover, not
--   extinction. 48 h sits clear of that, so one fire is never fragmented by a
--   cloudy day, while a genuine re-ignition after two days' silence becomes a
--   separate fire.
--
-- Identity: detections are immutable rows with stable ids, so "which cluster
-- did this detection belong to last run" is an EXACT lookup, not a similarity
-- judgement. Clustering is therefore recomputed freely and identity inherited
-- through detection membership -- no fuzzy spatial matching anywhere.

ALTER TABLE fire_clusters ADD COLUMN IF NOT EXISTS method_version      text NOT NULL DEFAULT 'dbscan-1500m-2pt-48h-v1';
ALTER TABLE fire_clusters ADD COLUMN IF NOT EXISTS seed_detection_id   bigint;
ALTER TABLE fire_clusters ADD COLUMN IF NOT EXISTS label_source        text;
ALTER TABLE fire_clusters ADD COLUMN IF NOT EXISTS low_confidence_share real;
ALTER TABLE fire_clusters ADD COLUMN IF NOT EXISTS bbox                geography(Polygon,4326);
ALTER TABLE fire_clusters ADD COLUMN IF NOT EXISTS last_run_id         bigint;

CREATE INDEX IF NOT EXISTS ix_clusters_frp ON fire_clusters (total_frp_mw DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS ix_clusters_key ON fire_clusters (cluster_key);

-- A merge is a real event, not an accident to be hidden: two fires growing
-- into one another is exactly the kind of change the timeline should show. If
-- the agent said "the Elk fire" yesterday and that fire is now part of a
-- larger complex, it must be able to explain where it went.
CREATE TABLE IF NOT EXISTS fire_cluster_merges (
  merge_id          bigserial PRIMARY KEY,
  surviving_key     text        NOT NULL,
  absorbed_key      text        NOT NULL,
  absorbed_detections integer   NOT NULL,
  detected_at       timestamptz NOT NULL DEFAULT now(),
  run_id            bigint,
  method_version    text        NOT NULL,
  UNIQUE (surviving_key, absorbed_key, method_version)
);

CREATE INDEX IF NOT EXISTS ix_merges_absorbed  ON fire_cluster_merges (absorbed_key);
CREATE INDEX IF NOT EXISTS ix_merges_surviving ON fire_cluster_merges (surviving_key);

-- Resolve a key the agent may still be holding to the cluster that now
-- contains it, following merge chains.
CREATE OR REPLACE FUNCTION resolve_cluster_key(p_key text)
RETURNS text AS $$
DECLARE
  cur text := p_key;
  nxt text;
  hops integer := 0;
BEGIN
  LOOP
    SELECT surviving_key INTO nxt FROM fire_cluster_merges
      WHERE absorbed_key = cur ORDER BY detected_at DESC LIMIT 1;
    EXIT WHEN nxt IS NULL OR hops > 20;   -- hop cap guards against a cycle
    cur := nxt;
    hops := hops + 1;
  END LOOP;
  RETURN cur;
END;
$$ LANGUAGE plpgsql STABLE;

-- Active fires with their growth over the last 24h, which is what "has this
-- fire grown?" actually asks.
CREATE OR REPLACE VIEW v_fire_clusters_active AS
SELECT
  c.cluster_id, c.cluster_key, c.label, c.label_source,
  c.first_event_time, c.last_event_time,
  c.centroid, c.h3_r5, c.region,
  c.detection_count, c.total_frp_mw, c.max_frp_mw,
  c.mean_confidence, c.low_confidence_share,
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
