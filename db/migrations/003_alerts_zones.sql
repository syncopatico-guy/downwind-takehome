-- Migration 003: alert lifecycle, SAME codes, and cached NWS zone geometry
--
-- Driven by inspection of a real NWS payload (200 features), which revealed
-- three things the initial schema did not account for:
--
--   1. `id` is unique PER MESSAGE, not per alert. An amended or cancelled
--      alert arrives as a NEW message carrying `references` to the prior one
--      (61 of 200 had references; 18 were Cancels). Without the chain we
--      cannot distinguish an alert that was LIFTED EARLY from one that simply
--      expired -- a timeline correctness problem, since a cancelled air
--      quality alert means the hazard was judged over.
--   2. The payload carries both UGC and SAME geocodes.
--   3. 38% of alerts have NULL geometry, and EVERY air-quality / fire-weather
--      alert sampled was in that group, zone-coded with Z-prefix forecast
--      zones. Zone geometry is therefore mandatory, not optional: without it
--      the advisory layer cannot be mapped or joined to stations at all.

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS references_ids text[];
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS same_codes     text[];
-- `effective` is distinct from `onset` in some products
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS effective      timestamptz;
-- 'Actual' | 'Test' | 'Exercise' | 'Draft'. Test messages (5 of 200 sampled)
-- are RETAINED rather than dropped, so the record stays faithful to what the
-- provider published; every product query filters to status = 'Actual'.
CREATE INDEX IF NOT EXISTS ix_alerts_status_actual
  ON alerts (event_type, sent DESC) WHERE status = 'Actual';

-- Cached NWS zone polygons, resolved lazily: a zone is fetched the first time
-- an alert references it and kept forever. Only ~16 distinct zones appeared
-- across our eight states in two weeks, so this stays small -- whereas
-- pre-loading all 601 forecast zones would cost ~20 MB of geometry we would
-- mostly never use.
CREATE TABLE IF NOT EXISTS nws_zones (
  zone_id      text PRIMARY KEY,               -- e.g. 'AZZ001'
  zone_type    text NOT NULL,                  -- forecast | county | fire
  name         text,
  state        text,
  geom         geography(MultiPolygon,4326),
  -- Full-fidelity polygons run to 1,301 points for a single zone, which is
  -- far more than a map needs. The simplified copy is what the client gets.
  geom_simple  geography(MultiPolygon,4326),
  point_count  integer,
  -- A zone that cannot be resolved is RECORDED as such rather than retried on
  -- every run, and makes the resulting map gap explainable instead of mysterious.
  fetch_status text NOT NULL DEFAULT 'ok'
               CHECK (fetch_status IN ('ok','not_found','error')),
  fetch_error  text,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_nws_zones_geom   ON nws_zones USING GIST (geom);
CREATE INDEX IF NOT EXISTS ix_nws_zones_status ON nws_zones (fetch_status);

-- Effective geometry of an alert: its own polygon when it has one, otherwise
-- the union of its referenced zones. This is what makes a zone-coded air
-- quality alert spatially comparable to a sensor reading.
CREATE OR REPLACE VIEW v_alert_geometry AS
SELECT
  a.alert_row_id,
  a.alert_id,
  a.event_type,
  a.severity,
  a.status,
  a.message_type,
  a.headline,
  a.area_desc,
  a.sent,
  a.onset,
  a.ends,
  a.expires,
  a.ingest_time,
  a.source_url,
  a.ugc_codes,
  CASE WHEN a.geom IS NOT NULL THEN 'polygon' ELSE 'zones' END AS geometry_origin,
  COALESCE(
    a.geom,
    (SELECT ST_Multi(ST_Union(z.geom::geometry))::geography
       FROM nws_zones z
      WHERE z.zone_id = ANY(a.ugc_codes) AND z.geom IS NOT NULL)
  ) AS geom,
  -- How many of the alert's zones we could actually resolve. A partial
  -- resolution is reported, never silently rendered as if complete.
  (SELECT count(*) FROM nws_zones z
     WHERE z.zone_id = ANY(a.ugc_codes) AND z.geom IS NOT NULL) AS zones_resolved,
  COALESCE(array_length(a.ugc_codes, 1), 0)                     AS zones_referenced
FROM alerts a;
