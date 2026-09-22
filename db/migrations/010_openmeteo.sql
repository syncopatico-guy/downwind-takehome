-- Migration 010: Open-Meteo wind and CAMS
--
-- Batching verified against the live API: 200 coordinates per request is safe
-- (400 works, 800 returns HTTP 414 on URL length), and past_days=7 with
-- forecast_days=2 returns 216 hours in a SINGLE call. All 800 stations
-- therefore cost ~4 requests for wind and ~4 for CAMS -- a different world
-- from OpenAQ's 60/min grind, where requests rather than storage were the
-- binding constraint.
--
-- Because requests turned out to be nearly free, CAMS is additionally sampled
-- on a coarse H3 r3 grid (546 cells over the bbox). Its value is partly to
-- cover terrain with NO sensors -- which is most fire country -- and sampling
-- it only where sensors already exist would have forfeited exactly that.
-- Wind stays at station and fire precision: Open-Meteo's native resolution is
-- ~9-11 km, and 69 km grid cells would smooth away the valley channeling that
-- drove the September 2020 episode.

-- Carbon monoxide is a combustion tracer: it separates smoke from dust or
-- industrial particulate in a way PM alone cannot.
ALTER TABLE model_aq_hourly ADD COLUMN IF NOT EXISTS carbon_monoxide real;

-- Forecast rows are the bitemporal design doing real work: a forecast value is
-- superseded by analysis as time passes, arriving as a NEW row with a later
-- ingest_time rather than overwriting. "What did we think the wind would do"
-- and "what did it actually do" stay separable.
CREATE INDEX IF NOT EXISTS ix_weather_forecast
  ON weather_hourly (point_id, event_time DESC) WHERE is_forecast;
CREATE INDEX IF NOT EXISTS ix_model_aq_forecast
  ON model_aq_hourly (point_id, event_time DESC) WHERE is_forecast;

-- Latest-known value per point-hour, honouring the append-only revision model:
-- the row with the greatest ingest_time wins, and analysis is preferred over
-- forecast at equal recency.
CREATE OR REPLACE VIEW v_weather_latest AS
SELECT DISTINCT ON (point_id, event_time)
  point_id, event_time, ingest_time, is_forecast,
  wind_dir_deg, wind_speed_kmh, wind_gust_kmh,
  temp_c, rh_pct, precip_mm, pbl_height_m
FROM weather_hourly
ORDER BY point_id, event_time, is_forecast ASC, ingest_time DESC;

CREATE OR REPLACE VIEW v_model_aq_latest AS
SELECT DISTINCT ON (point_id, event_time)
  point_id, event_time, ingest_time, is_forecast,
  pm25, pm10, us_aqi, aod550, dust, carbon_monoxide
FROM model_aq_hourly
ORDER BY point_id, event_time, is_forecast ASC, ingest_time DESC;
