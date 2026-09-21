-- Downwind: wildfire smoke -> air quality observatory
-- Migration 001: bitemporal core schema
--
-- DESIGN CONTRACT
--   * RAW tables are APPEND-ONLY. Nothing is ever UPDATEd or DELETEd.
--     A revised upstream value becomes a NEW ROW with a later ingest_time.
--     Dedupe is by a UNIQUE key that includes a hash of the value, so
--     re-reading an unchanged value is a no-op but a changed value is history.
--   * DERIVED tables are freely recomputable from RAW.
--   * Every observation carries TWO clocks:
--       event_time  = when the phenomenon happened (upstream timestamp)
--       ingest_time = when we first learned of it
--     "What did we know at T" == WHERE ingest_time <= T.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- digest() for value hashes

-- ===========================================================================
-- REGISTRY
-- ===========================================================================

-- Feed registry. staleness_seconds is what makes "stale" a declared property
-- of the feed rather than a number hardcoded in application logic.
CREATE TABLE IF NOT EXISTS sources (
  source_id          text PRIMARY KEY,
  display_name       text        NOT NULL,
  provider           text        NOT NULL,
  base_url           text        NOT NULL,
  docs_url           text,
  license            text,
  -- expected publish interval
  cadence_seconds    integer     NOT NULL,
  -- age (of event_time vs now) beyond which a reading is considered stale
  staleness_seconds  integer     NOT NULL,
  -- known publication lag: FIRMS NRT is ~3h behind acquisition
  latency_seconds    integer     NOT NULL DEFAULT 0,
  -- 'observation' = measured by an instrument
  -- 'model'       = computed by a numerical model (CAMS, Open-Meteo)
  -- 'advisory'    = human-issued judgement (NWS)
  -- This is the axis along which feeds are allowed to disagree.
  measurement_kind   text        NOT NULL
                     CHECK (measurement_kind IN ('observation','model','advisory')),
  requires_key       boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Every write is attributable to exactly one run. This table is the
-- provenance backbone AND the staleness/gap detector: a missing or failed
-- run is why a hole in the data exists, and we can say so.
CREATE TABLE IF NOT EXISTS ingest_runs (
  run_id         bigserial PRIMARY KEY,
  source_id      text        NOT NULL REFERENCES sources(source_id),
  -- Sub-feed within a logical source, e.g. 'viirs_snpp:usa', 'viirs_noaa21:canada'.
  -- Keeps `sources` at one row per logical feed while still tracking each
  -- underlying endpoint's successes, failures and gaps independently.
  -- NULL for single-endpoint sources.
  feed_variant   text,
  trigger_kind   text        NOT NULL
                 CHECK (trigger_kind IN ('cron','manual','backfill','seed')),
  status         text        NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','ok','partial','error')),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  request_url    text,
  http_status    integer,
  rows_fetched   integer,
  rows_inserted  integer,
  rows_rejected  integer,
  -- the event-time window this run intended to cover, so gaps are provable
  window_start   timestamptz,
  window_end     timestamptz,
  error_message  text,
  notes          jsonb
);

CREATE INDEX IF NOT EXISTS ix_ingest_runs_source_started
  ON ingest_runs (source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_ingest_runs_status
  ON ingest_runs (status, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_ingest_runs_variant
  ON ingest_runs (source_id, feed_variant, started_at DESC);

-- Points at which we sample gridded model feeds (wind, CAMS). We deliberately
-- do NOT sample a dense grid: we sample where the question needs an answer --
-- at monitoring stations and fire centroids -- plus a coarse background grid
-- for map visualisation. Keeps row counts (and the Neon free tier) sane.
CREATE TABLE IF NOT EXISTS sample_points (
  point_id    text PRIMARY KEY,            -- 'stn:<station_id>' | 'grid:<h3>' | 'fire:<cluster_id>'
  point_kind  text NOT NULL CHECK (point_kind IN ('station','grid','fire_cluster')),
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  geom        geography(Point,4326) NOT NULL,
  h3_r5       text NOT NULL,
  region      text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_sample_points_geom ON sample_points USING GIST (geom);
CREATE INDEX IF NOT EXISTS ix_sample_points_kind ON sample_points (point_kind, active);

-- ===========================================================================
-- RAW: append-only observations
-- ===========================================================================

-- NASA FIRMS active fire detections (VIIRS / MODIS).
-- observation_key identifies the PHENOMENON (this pixel, this overpass).
-- The UNIQUE constraint identifies THIS REPORT of it (adds processing version),
-- so an NRT detection later reprocessed as SP arrives as a second row with a
-- later ingest_time instead of destroying the original.
CREATE TABLE IF NOT EXISTS fire_detections (
  detection_id    bigserial PRIMARY KEY,
  source_id       text        NOT NULL REFERENCES sources(source_id),
  run_id          bigint      NOT NULL REFERENCES ingest_runs(run_id),
  observation_key text        NOT NULL,
  lat             double precision NOT NULL,
  lon             double precision NOT NULL,
  geom            geography(Point,4326) NOT NULL,
  h3_r6           text        NOT NULL,
  event_time      timestamptz NOT NULL,   -- satellite acquisition, UTC
  ingest_time     timestamptz NOT NULL DEFAULT now(),
  frp_mw          real,                   -- fire radiative power: intensity, not just presence
  brightness_ti4  real,
  brightness_ti5  real,
  confidence      text CHECK (confidence IN ('low','nominal','high')),
  satellite       text,
  instrument      text,
  daynight        char(1) CHECK (daynight IN ('D','N')),
  -- NOT NULL is load-bearing: this column is part of uq_fire_detection, and
  -- Postgres treats NULLs in a unique constraint as distinct -- so a nullable
  -- proc_version would let the same detection re-insert on every cron run.
  proc_version    text        NOT NULL DEFAULT 'unknown',
  cluster_id      bigint,                 -- assigned by the clustering job
  CONSTRAINT uq_fire_detection UNIQUE (source_id, observation_key, proc_version)
);

CREATE INDEX IF NOT EXISTS ix_fire_det_event      ON fire_detections (event_time DESC);
CREATE INDEX IF NOT EXISTS ix_fire_det_ingest     ON fire_detections (ingest_time DESC);
CREATE INDEX IF NOT EXISTS ix_fire_det_h3_event   ON fire_detections (h3_r6, event_time DESC);
CREATE INDEX IF NOT EXISTS ix_fire_det_geom       ON fire_detections USING GIST (geom);
CREATE INDEX IF NOT EXISTS ix_fire_det_cluster    ON fire_detections (cluster_id)
  WHERE cluster_id IS NOT NULL;

-- Air quality monitoring stations (OpenAQ). Slowly-changing dimension.
-- instrument_tier is the lever for the conflicting-data story: reference-grade
-- regulatory monitors and low-cost sensors disagree systematically and should
-- never be averaged together silently.
CREATE TABLE IF NOT EXISTS aq_stations (
  station_id      text PRIMARY KEY,        -- '<source>:<upstream id>'
  source_id       text NOT NULL REFERENCES sources(source_id),
  upstream_id     text NOT NULL,
  name            text,
  provider        text,                    -- e.g. 'AirNow', 'PurpleAir', 'EPA'
  instrument_tier text NOT NULL DEFAULT 'unknown'
                  CHECK (instrument_tier IN ('reference','low_cost','unknown')),
  lat             double precision NOT NULL,
  lon             double precision NOT NULL,
  geom            geography(Point,4326) NOT NULL,
  h3_r6           text NOT NULL,
  country         text,
  region          text,
  timezone        text,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  source_url      text
);

CREATE INDEX IF NOT EXISTS ix_aq_stations_geom ON aq_stations USING GIST (geom);
CREATE INDEX IF NOT EXISTS ix_aq_stations_tier ON aq_stations (instrument_tier);

-- Measured pollutant readings. value_hash in the UNIQUE key means a re-read of
-- an unchanged value is discarded, but an upstream CORRECTION lands as a new
-- row -- giving us revision history for free.
CREATE TABLE IF NOT EXISTS aq_measurements (
  measurement_id bigserial PRIMARY KEY,
  source_id      text        NOT NULL REFERENCES sources(source_id),
  run_id         bigint      NOT NULL REFERENCES ingest_runs(run_id),
  station_id     text        NOT NULL REFERENCES aq_stations(station_id),
  parameter      text        NOT NULL,     -- 'pm25' | 'pm10' | 'o3' | ...
  event_time     timestamptz NOT NULL,
  ingest_time    timestamptz NOT NULL DEFAULT now(),
  value          real        NOT NULL,
  unit           text        NOT NULL,
  value_hash     text        NOT NULL,
  source_url     text,
  CONSTRAINT uq_aq_measurement
    UNIQUE (source_id, station_id, parameter, event_time, value_hash)
);

CREATE INDEX IF NOT EXISTS ix_aq_meas_station_param_event
  ON aq_measurements (station_id, parameter, event_time DESC);
CREATE INDEX IF NOT EXISTS ix_aq_meas_event   ON aq_measurements (event_time DESC);
CREATE INDEX IF NOT EXISTS ix_aq_meas_ingest  ON aq_measurements (ingest_time DESC);
CREATE INDEX IF NOT EXISTS ix_aq_meas_param_event
  ON aq_measurements (parameter, event_time DESC);

-- Wind and boundary-layer conditions: the transport layer that connects a
-- fire to a station. Model output, so revisions are expected (forecast ->
-- analysis) and handled by the same value_hash mechanism.
CREATE TABLE IF NOT EXISTS weather_hourly (
  weather_id      bigserial PRIMARY KEY,
  source_id       text        NOT NULL REFERENCES sources(source_id),
  run_id          bigint      NOT NULL REFERENCES ingest_runs(run_id),
  point_id        text        NOT NULL REFERENCES sample_points(point_id),
  event_time      timestamptz NOT NULL,   -- hour start, UTC
  ingest_time     timestamptz NOT NULL DEFAULT now(),
  -- meteorological convention: direction the wind blows FROM
  wind_dir_deg    real,
  wind_speed_kmh  real,
  wind_gust_kmh   real,
  temp_c          real,
  rh_pct          real,
  precip_mm       real,
  pbl_height_m    real,                   -- mixing depth: shallow PBL traps smoke
  is_forecast     boolean     NOT NULL DEFAULT false,
  value_hash      text        NOT NULL,
  CONSTRAINT uq_weather_hourly
    UNIQUE (source_id, point_id, event_time, value_hash)
);

CREATE INDEX IF NOT EXISTS ix_weather_point_event
  ON weather_hourly (point_id, event_time DESC);
CREATE INDEX IF NOT EXISTS ix_weather_event  ON weather_hourly (event_time DESC);
CREATE INDEX IF NOT EXISTS ix_weather_ingest ON weather_hourly (ingest_time DESC);

-- Modelled air quality (Open-Meteo / CAMS). Deliberately a SEPARATE table from
-- aq_measurements: a model estimate and an instrument reading are different
-- kinds of claim, and collapsing them would destroy the conflict signal.
CREATE TABLE IF NOT EXISTS model_aq_hourly (
  model_aq_id  bigserial PRIMARY KEY,
  source_id    text        NOT NULL REFERENCES sources(source_id),
  run_id       bigint      NOT NULL REFERENCES ingest_runs(run_id),
  point_id     text        NOT NULL REFERENCES sample_points(point_id),
  event_time   timestamptz NOT NULL,
  ingest_time  timestamptz NOT NULL DEFAULT now(),
  pm25         real,
  pm10         real,
  us_aqi       integer,
  aod550       real,                      -- aerosol optical depth: smoke column
  dust         real,
  is_forecast  boolean     NOT NULL DEFAULT false,
  value_hash   text        NOT NULL,
  CONSTRAINT uq_model_aq UNIQUE (source_id, point_id, event_time, value_hash)
);

CREATE INDEX IF NOT EXISTS ix_model_aq_point_event
  ON model_aq_hourly (point_id, event_time DESC);
CREATE INDEX IF NOT EXISTS ix_model_aq_event ON model_aq_hourly (event_time DESC);

-- NWS alerts: official human-issued judgement. Note geom is NULLABLE -- many
-- NWS products are zone-coded (UGC/SAME) with no polygon, which is itself a
-- data-quality case the agent has to be honest about rather than silently drop.
CREATE TABLE IF NOT EXISTS alerts (
  alert_row_id  bigserial PRIMARY KEY,
  source_id     text        NOT NULL REFERENCES sources(source_id),
  run_id        bigint      NOT NULL REFERENCES ingest_runs(run_id),
  alert_id      text        NOT NULL,
  event_type    text        NOT NULL,     -- 'Air Quality Alert', 'Dense Smoke Advisory', ...
  severity      text,
  urgency       text,
  certainty     text,
  status        text,
  message_type  text,                     -- Alert | Update | Cancel
  headline      text,
  description   text,
  instruction   text,
  area_desc     text,
  ugc_codes     text[],                   -- populated when geom is absent
  geom          geography(MultiPolygon,4326),
  sent          timestamptz NOT NULL,     -- event_time
  onset         timestamptz,
  ends          timestamptz,
  expires       timestamptz,
  ingest_time   timestamptz NOT NULL DEFAULT now(),
  source_url    text,
  CONSTRAINT uq_alert UNIQUE (alert_id, sent)
);

CREATE INDEX IF NOT EXISTS ix_alerts_geom    ON alerts USING GIST (geom);
CREATE INDEX IF NOT EXISTS ix_alerts_sent    ON alerts (sent DESC);
CREATE INDEX IF NOT EXISTS ix_alerts_window  ON alerts (onset, expires);
CREATE INDEX IF NOT EXISTS ix_alerts_type    ON alerts (event_type, sent DESC);

-- ===========================================================================
-- DERIVED: recomputable
-- ===========================================================================

-- Detections are pixels, not fires. ~186 detections near Yosemite are ONE
-- complex. Clustering gives the agent nameable entities with IDs stable across
-- ingest runs, so it can say "the Yosemite complex grew 40% since Thursday".
CREATE TABLE IF NOT EXISTS fire_clusters (
  cluster_id        bigserial PRIMARY KEY,
  cluster_key       text UNIQUE NOT NULL,   -- stable across recomputation
  label             text,
  first_event_time  timestamptz NOT NULL,
  last_event_time   timestamptz NOT NULL,
  centroid          geography(Point,4326) NOT NULL,
  hull              geography(Polygon,4326),
  h3_r5             text NOT NULL,
  detection_count   integer NOT NULL,
  total_frp_mw      real,
  max_frp_mw        real,
  mean_confidence   real,                   -- share of non-low-confidence detections
  region            text,
  is_active         boolean NOT NULL DEFAULT true,
  computed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_clusters_centroid ON fire_clusters USING GIST (centroid);
CREATE INDEX IF NOT EXISTS ix_clusters_window   ON fire_clusters (last_event_time DESC);
CREATE INDEX IF NOT EXISTS ix_clusters_active   ON fire_clusters (is_active, last_event_time DESC);

-- The hypothesis layer. Each row is a claim that fire X plausibly contributed
-- to station Y's reading at hour T, and it carries ITS OWN EVIDENCE so the
-- agent can show its work instead of asserting causation.
CREATE TABLE IF NOT EXISTS smoke_attributions (
  attribution_id  bigserial PRIMARY KEY,
  station_id      text        NOT NULL REFERENCES aq_stations(station_id),
  event_time      timestamptz NOT NULL,
  cluster_id      bigint      NOT NULL REFERENCES fire_clusters(cluster_id),
  score           real        NOT NULL,   -- 0..1, FRP- and distance-weighted
  distance_km     real        NOT NULL,
  bearing_deg     real        NOT NULL,   -- fire -> station
  wind_dir_deg    real        NOT NULL,   -- wind FROM, at the fire
  wind_speed_kmh  real        NOT NULL,
  alignment_deg   real        NOT NULL,   -- angular error vs perfect downwind
  travel_hours    real,
  frp_mw          real        NOT NULL,
  pbl_height_m    real,
  method_version  text        NOT NULL,   -- bump to recompute without losing history
  computed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_attribution
    UNIQUE (station_id, event_time, cluster_id, method_version)
);

CREATE INDEX IF NOT EXISTS ix_attr_station_event
  ON smoke_attributions (station_id, event_time DESC);
CREATE INDEX IF NOT EXISTS ix_attr_cluster ON smoke_attributions (cluster_id, event_time DESC);
CREATE INDEX IF NOT EXISTS ix_attr_score   ON smoke_attributions (event_time DESC, score DESC);

-- One indexed read per scrub position. This table is the timeline: it is
-- exported to Parquet and queried client-side by DuckDB-WASM so dragging the
-- handle never touches the network.
CREATE TABLE IF NOT EXISTS hourly_frames (
  frame_time            timestamptz NOT NULL,
  h3_r4                 text        NOT NULL,
  fire_count            integer     NOT NULL DEFAULT 0,
  fire_count_confident  integer     NOT NULL DEFAULT 0,
  total_frp_mw          real,
  max_frp_mw            real,
  station_count         integer     NOT NULL DEFAULT 0,
  pm25_obs_max          real,
  pm25_obs_mean         real,
  pm25_model_mean       real,
  us_aqi_max            integer,
  wind_dir_deg          real,
  wind_speed_kmh        real,
  alert_event_type      text,
  alert_severity        text,
  top_attribution_score real,
  -- true when a contributing feed had no data for this cell-hour: the UI
  -- renders this as a visible hole rather than interpolating over it
  is_partial            boolean     NOT NULL DEFAULT false,
  missing_sources       text[],
  computed_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (frame_time, h3_r4)
);

CREATE INDEX IF NOT EXISTS ix_frames_time ON hourly_frames (frame_time DESC);

-- ===========================================================================
-- HEALTH VIEWS  (back the agent's get_data_health tool and the UI freshness strip)
-- ===========================================================================

-- Per-endpoint health. A logical source may have several underlying endpoints
-- (three VIIRS satellites x two regions), and one of them can die silently
-- while the others keep succeeding. This view makes that visible.
CREATE OR REPLACE VIEW v_feed_variant_health AS
SELECT
  s.source_id,
  s.display_name,
  coalesce(i.feed_variant, '(single)')                     AS feed_variant,
  s.staleness_seconds,
  max(i.started_at) FILTER (WHERE i.status = 'ok')         AS last_ok_at,
  max(i.started_at)                                        AS last_attempt_at,
  (array_agg(i.status ORDER BY i.started_at DESC))[1]      AS last_status,
  count(*) FILTER (WHERE i.status = 'error')               AS error_runs,
  count(*)                                                 AS total_runs,
  sum(i.rows_inserted)                                     AS rows_inserted_total,
  CASE
    WHEN max(i.started_at) FILTER (WHERE i.status = 'ok') IS NULL
      THEN 'never_succeeded'
    WHEN now() - max(i.started_at) FILTER (WHERE i.status = 'ok')
         > (s.staleness_seconds || ' seconds')::interval
      THEN 'stale'
    ELSE 'fresh'
  END                                                      AS freshness
FROM sources s
LEFT JOIN ingest_runs i ON i.source_id = s.source_id
GROUP BY s.source_id, s.display_name, i.feed_variant, s.staleness_seconds;

-- Rolled up to the logical source. A source is only as fresh as its WEAKEST
-- endpoint: if any variant is stale or has never succeeded, the source is not
-- reported as fresh. Deliberately pessimistic -- the alternative is claiming
-- freshness we do not have.
CREATE OR REPLACE VIEW v_source_health AS
SELECT
  s.source_id,
  s.display_name,
  s.provider,
  s.measurement_kind,
  s.cadence_seconds,
  s.staleness_seconds,
  s.latency_seconds,
  s.requires_key,
  coalesce(v.variant_count, 0)                             AS variant_count,
  coalesce(v.stale_variants, 0)                            AS stale_variants,
  v.weakest_last_ok_at                                     AS last_ok_at,
  v.last_attempt_at,
  EXTRACT(EPOCH FROM (now() - v.weakest_last_ok_at))::bigint AS seconds_since_ok,
  CASE
    WHEN v.weakest_last_ok_at IS NULL     THEN 'never_succeeded'
    WHEN coalesce(v.stale_variants, 0) > 0 THEN 'stale'
    ELSE 'fresh'
  END                                                      AS freshness
FROM sources s
LEFT JOIN (
  SELECT
    source_id,
    count(*)                                        AS variant_count,
    min(last_ok_at)                                 AS weakest_last_ok_at,
    max(last_attempt_at)                            AS last_attempt_at,
    count(*) FILTER (WHERE freshness <> 'fresh')    AS stale_variants
  FROM v_feed_variant_health
  GROUP BY source_id
) v ON v.source_id = s.source_id;
