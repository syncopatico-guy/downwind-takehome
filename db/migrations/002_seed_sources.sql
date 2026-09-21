-- Migration 002: source registry
--
-- staleness_seconds is the contract between a feed and the agent: beyond this
-- age, a reading is reported as stale rather than presented as current. It is
-- declared per feed here rather than hardcoded in application logic, so the
-- agent's honesty about freshness is a property of the data, not of a prompt.
--
-- latency_seconds is KNOWN publication lag -- the unavoidable delay between a
-- phenomenon occurring and the feed publishing it. FIRMS NRT runs ~3h behind
-- satellite acquisition. Distinguishing "late because physics" from "late
-- because our ingester broke" is the whole point of separating these.

INSERT INTO sources (
  source_id, display_name, provider, base_url, docs_url, license,
  cadence_seconds, staleness_seconds, latency_seconds, measurement_kind, requires_key
) VALUES

-- Where it is burning, and how hard. Three VIIRS satellites (SNPP, NOAA-20,
-- NOAA-21) x two regions (USA, Canada) = six endpoints under one logical
-- source; each is tracked separately via ingest_runs.feed_variant.
-- Keyless CSV feeds carry 24h/48h/7d windows; the 7d window is our day-one
-- archive. Deeper history needs the keyed area API.
('firms_viirs',
 'NASA FIRMS Active Fire (VIIRS 375 m)',
 'NASA LANCE / FIRMS',
 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/',
 'https://firms.modaps.eosdis.nasa.gov/api/area/',
 'NASA Earthdata — open, attribution requested',
 1800,    -- we poll every 30 min
 21600,   -- stale after 6h: satellites overpass a few times a day
 10800,   -- ~3h NRT publication lag
 'observation', false),

-- What people are actually breathing. The only feed giving a named physical
-- station with coordinates and a provider tier -- which is what "follow
-- evidence to its source" concretely means.
('openaq',
 'OpenAQ Ground Measurements',
 'OpenAQ',
 'https://api.openaq.org/v3/',
 'https://docs.openaq.org/',
 'CC BY 4.0 (varies by upstream provider)',
 3600,
 7200,    -- stale after 2h
 3600,    -- stations commonly report up to an hour behind
 'observation', true),

-- The transport layer: how smoke gets from a fire to a person. Also supplies
-- PBL height -- a shallow mixing layer traps smoke at the surface, which is
-- why a moderate fire can produce severe readings.
('openmeteo_wind',
 'Open-Meteo Wind & Boundary Layer',
 'Open-Meteo (ECMWF/GFS)',
 'https://api.open-meteo.com/v1/forecast',
 'https://open-meteo.com/en/docs',
 'CC BY 4.0',
 3600,
 7200,
 0,
 'model', false),

-- An independent modelled estimate of the SAME quantity OpenAQ measures.
-- Deliberately a separate source (and separate table) so model-versus-
-- measurement disagreement is preserved rather than averaged away.
('openmeteo_cams_aq',
 'Open-Meteo Air Quality (CAMS)',
 'Open-Meteo (Copernicus CAMS)',
 'https://air-quality-api.open-meteo.com/v1/air-quality',
 'https://open-meteo.com/en/docs/air-quality-api',
 'CC BY 4.0',
 3600,
 10800,   -- stale after 3h
 3600,
 'model', false),

-- Official human-issued judgement: Air Quality Alert, Dense Smoke Advisory,
-- Red Flag Warning, Fire Weather Watch. Can conflict with both the sensors
-- and the model, which is exactly why it is here. US-only: the Canadian part
-- of our scope has no advisory feed, and the UI says so rather than implying
-- an absence of alerts means an absence of hazard.
('nws_alerts',
 'NWS Active Alerts',
 'NOAA / National Weather Service',
 'https://api.weather.gov/alerts/active',
 'https://www.weather.gov/documentation/services-web-api',
 'US Government work — public domain',
 300,
 3600,
 0,
 'advisory', false)

ON CONFLICT (source_id) DO UPDATE SET
  display_name      = EXCLUDED.display_name,
  provider          = EXCLUDED.provider,
  base_url          = EXCLUDED.base_url,
  docs_url          = EXCLUDED.docs_url,
  license           = EXCLUDED.license,
  cadence_seconds   = EXCLUDED.cadence_seconds,
  staleness_seconds = EXCLUDED.staleness_seconds,
  latency_seconds   = EXCLUDED.latency_seconds,
  measurement_kind  = EXCLUDED.measurement_kind,
  requires_key      = EXCLUDED.requires_key;
