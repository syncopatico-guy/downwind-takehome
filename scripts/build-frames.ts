/**
 * hourly_frames rollup: one indexed row per (hour, H3 r4 cell).
 *
 *   npm run build:frames
 *   npm run build:frames -- --days=8 --dry-run
 *
 * These frames ARE the timeline. They are exported to Parquet and queried
 * client-side by DuckDB-WASM, so dragging the scrub handle never touches the
 * network. Frames are written sparsely -- only cell-hours where something was
 * observed -- because a cartesian product over 576 hours x 438 cells would be
 * mostly empty.
 *
 * `is_partial` and `missing_sources` exist so a gap renders as a visible hole
 * rather than being silently interpolated over. A cell that normally carries
 * station data and has none this hour is a different fact from a cell that
 * never had a station, and the UI has to be able to draw that difference.
 */

import { config } from 'dotenv';
import { withIngestRun, query, withTransaction, closePool, reapStaleRuns, type TriggerKind } from '../lib/db';

config({ path: '.env.local', quiet: true });
config({ quiet: true });

function arg(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
}
const hasFlag = (n: string) => process.argv.includes(`--${n}`);

async function main(): Promise<void> {
  const days = Number(arg('days') ?? 9);
  const dryRun = hasFlag('dry-run');
  const vacuum = hasFlag('vacuum');
  const triggerKind = (arg('trigger') ?? 'manual') as TriggerKind;

  console.log(`\nFrame rollup — window=${days}d${dryRun ? ' (DRY RUN)' : ''}\n`);
  await reapStaleRuns(60);

  await withIngestRun(
    { sourceId: 'firms_viirs', feedVariant: 'frames', triggerKind },
    async (ctx) => {
      const stats = await withTransaction(async (client) => {
        const since = `now() - interval '${days} days'`;

        // Fire activity per cell-hour. Confident count excludes low-confidence
        // detections, so the UI can show "12 detections, 9 confident".
        await client.query(`
          CREATE TEMP TABLE _f_fire ON COMMIT DROP AS
          SELECT date_trunc('hour', event_time) AS t, h3_r4 AS cell,
                 count(*)::int AS fire_count,
                 count(*) FILTER (WHERE confidence IN ('nominal','high'))::int AS fire_count_confident,
                 sum(frp_mw)::real AS total_frp_mw,
                 max(frp_mw)::real AS max_frp_mw
            FROM fire_detections
           WHERE h3_r4 IS NOT NULL AND event_time > ${since}
           GROUP BY 1, 2`);

        // Observed air quality, taking the LATEST KNOWN value per station-hour
        // so an upstream correction is not double-counted with the original.
        await client.query(`
          CREATE TEMP TABLE _f_aq ON COMMIT DROP AS
          WITH latest AS (
            SELECT DISTINCT ON (m.station_id, m.event_time)
                   m.station_id, m.event_time, m.value, s.h3_r4
              FROM aq_measurements m
              JOIN aq_stations s ON s.station_id = m.station_id
             WHERE m.parameter = 'pm25' AND s.h3_r4 IS NOT NULL
               AND m.event_time > ${since}
             ORDER BY m.station_id, m.event_time, m.ingest_time DESC
          )
          SELECT date_trunc('hour', event_time) AS t, h3_r4 AS cell,
                 count(DISTINCT station_id)::int AS station_count,
                 max(value)::real  AS pm25_obs_max,
                 avg(value)::real  AS pm25_obs_mean
            FROM latest GROUP BY 1, 2`);

        // Modelled air quality and wind, analysis only -- a frame describes
        // what happened, so forecast rows are excluded here.
        await client.query(`
          CREATE TEMP TABLE _f_model ON COMMIT DROP AS
          SELECT date_trunc('hour', m.event_time) AS t, p.h3_r4 AS cell,
                 avg(m.pm25)::real AS pm25_model_mean,
                 max(m.us_aqi)::int AS us_aqi_max
            FROM v_model_aq_latest m
            JOIN sample_points p ON p.point_id = m.point_id
           WHERE p.h3_r4 IS NOT NULL AND NOT m.is_forecast
             AND m.event_time > ${since}
           GROUP BY 1, 2`);

        await client.query(`
          CREATE TEMP TABLE _f_wind ON COMMIT DROP AS
          SELECT date_trunc('hour', w.event_time) AS t, p.h3_r4 AS cell,
                 -- Wind direction is circular: averaging 350 and 10 degrees
                 -- arithmetically gives 180, the exact opposite. Vector mean.
                 -- modulo must happen in numeric: Postgres has no real % integer
                 (((degrees(atan2(avg(sin(radians(w.wind_dir_deg))),
                                  avg(cos(radians(w.wind_dir_deg)))))::numeric
                    + 360) % 360))::real AS wind_dir_deg,
                 avg(w.wind_speed_kmh)::real AS wind_speed_kmh
            FROM v_weather_latest w
            JOIN sample_points p ON p.point_id = w.point_id
           WHERE p.h3_r4 IS NOT NULL AND NOT w.is_forecast
             AND w.wind_dir_deg IS NOT NULL AND w.event_time > ${since}
           GROUP BY 1, 2`);

        // An alert applies to a cell-hour if its geometry covers a station in
        // that cell and the hour falls inside its validity window.
        await client.query(`
          CREATE TEMP TABLE _f_alert ON COMMIT DROP AS
          SELECT h.t, s.h3_r4 AS cell,
                 (array_agg(g.event_type ORDER BY
                    CASE g.severity WHEN 'Extreme' THEN 1 WHEN 'Severe' THEN 2
                                    WHEN 'Moderate' THEN 3 WHEN 'Minor' THEN 4
                                    ELSE 5 END))[1] AS alert_event_type,
                 (array_agg(g.severity ORDER BY
                    CASE g.severity WHEN 'Extreme' THEN 1 WHEN 'Severe' THEN 2
                                    WHEN 'Moderate' THEN 3 WHEN 'Minor' THEN 4
                                    ELSE 5 END))[1] AS alert_severity
            FROM (SELECT DISTINCT date_trunc('hour', event_time) AS t
                    FROM aq_measurements WHERE event_time > ${since}) h
            JOIN v_alert_geometry g
              ON g.status = 'Actual' AND g.geom IS NOT NULL
             AND h.t >= date_trunc('hour', coalesce(g.onset, g.sent))
             AND h.t <= date_trunc('hour', coalesce(g.ends, g.expires, g.sent + interval '6 hours'))
            JOIN aq_stations s ON s.selected AND s.h3_r4 IS NOT NULL
                             AND ST_Intersects(g.geom, s.geom)
           GROUP BY 1, 2`);

        await client.query(`
          CREATE TEMP TABLE _f_attr ON COMMIT DROP AS
          SELECT date_trunc('hour', a.event_time) AS t, s.h3_r4 AS cell,
                 max(a.score)::real AS top_attribution_score
            FROM smoke_attributions a
            JOIN aq_stations s ON s.station_id = a.station_id
           WHERE s.h3_r4 IS NOT NULL AND a.event_time > ${since}
           GROUP BY 1, 2`);

        // Which cells are EXPECTED to carry which feeds. This is what makes
        // "missing" meaningful: a cell with no station was never going to have
        // observed air quality, and reporting that as a gap would be noise.
        await client.query(`
          CREATE TEMP TABLE _expect ON COMMIT DROP AS
          SELECT DISTINCT s.h3_r4 AS cell, true AS has_station
            FROM aq_stations s WHERE s.selected AND s.h3_r4 IS NOT NULL`);

        const res = await client.query(`
          INSERT INTO hourly_frames (
            frame_time, h3_r4, fire_count, fire_count_confident,
            total_frp_mw, max_frp_mw, station_count,
            pm25_obs_max, pm25_obs_mean, pm25_model_mean, us_aqi_max,
            wind_dir_deg, wind_speed_kmh, alert_event_type, alert_severity,
            top_attribution_score, is_partial, missing_sources, computed_at)
          SELECT
            k.t, k.cell,
            coalesce(f.fire_count, 0), coalesce(f.fire_count_confident, 0),
            f.total_frp_mw, f.max_frp_mw,
            coalesce(a.station_count, 0),
            a.pm25_obs_max, a.pm25_obs_mean, m.pm25_model_mean, m.us_aqi_max,
            w.wind_dir_deg, w.wind_speed_kmh,
            al.alert_event_type, al.alert_severity,
            at.top_attribution_score,
            -- Partial when a feed this cell normally carries produced nothing.
            (e.has_station IS TRUE AND (a.station_count IS NULL
                                        OR m.pm25_model_mean IS NULL
                                        OR w.wind_dir_deg IS NULL)),
            nullif(array_remove(ARRAY[
              CASE WHEN e.has_station IS TRUE AND a.station_count IS NULL THEN 'openaq' END,
              CASE WHEN e.has_station IS TRUE AND m.pm25_model_mean IS NULL THEN 'openmeteo_cams_aq' END,
              CASE WHEN e.has_station IS TRUE AND w.wind_dir_deg IS NULL THEN 'openmeteo_wind' END
            ], NULL), '{}'),
            now()
          FROM (
            SELECT t, cell FROM _f_fire
            UNION SELECT t, cell FROM _f_aq
            UNION SELECT t, cell FROM _f_model
            UNION SELECT t, cell FROM _f_wind
            UNION SELECT t, cell FROM _f_attr
          ) k
          LEFT JOIN _f_fire  f  ON f.t  = k.t AND f.cell  = k.cell
          LEFT JOIN _f_aq    a  ON a.t  = k.t AND a.cell  = k.cell
          LEFT JOIN _f_model m  ON m.t  = k.t AND m.cell  = k.cell
          LEFT JOIN _f_wind  w  ON w.t  = k.t AND w.cell  = k.cell
          LEFT JOIN _f_alert al ON al.t = k.t AND al.cell = k.cell
          LEFT JOIN _f_attr  at ON at.t = k.t AND at.cell = k.cell
          LEFT JOIN _expect  e  ON e.cell = k.cell
          ON CONFLICT (frame_time, h3_r4) DO UPDATE SET
            fire_count = EXCLUDED.fire_count,
            fire_count_confident = EXCLUDED.fire_count_confident,
            total_frp_mw = EXCLUDED.total_frp_mw, max_frp_mw = EXCLUDED.max_frp_mw,
            station_count = EXCLUDED.station_count,
            pm25_obs_max = EXCLUDED.pm25_obs_max, pm25_obs_mean = EXCLUDED.pm25_obs_mean,
            pm25_model_mean = EXCLUDED.pm25_model_mean, us_aqi_max = EXCLUDED.us_aqi_max,
            wind_dir_deg = EXCLUDED.wind_dir_deg, wind_speed_kmh = EXCLUDED.wind_speed_kmh,
            alert_event_type = EXCLUDED.alert_event_type,
            alert_severity = EXCLUDED.alert_severity,
            top_attribution_score = EXCLUDED.top_attribution_score,
            is_partial = EXCLUDED.is_partial, missing_sources = EXCLUDED.missing_sources,
            computed_at = now()`);

        const [summary] = (await client.query<{
          frames: string; hours: string; cells: string; partial: string; withfire: string; withaq: string;
        }>(`
          SELECT count(*)::text AS frames,
                 count(DISTINCT frame_time)::text AS hours,
                 count(DISTINCT h3_r4)::text AS cells,
                 count(*) FILTER (WHERE is_partial)::text AS partial,
                 count(*) FILTER (WHERE fire_count > 0)::text AS withfire,
                 count(*) FILTER (WHERE station_count > 0)::text AS withaq
            FROM hourly_frames`)).rows;

        console.log(`  frames written: ${res.rowCount}`);
        console.log(`  total: ${summary.frames} frames across ${summary.hours} hours, ${summary.cells} cells`);
        console.log(`  with fire data: ${summary.withfire}   with station data: ${summary.withaq}`);
        console.log(`  partial (a normally-present feed missing): ${summary.partial}`);

        return {
          written: res.rowCount ?? 0, frames: Number(summary.frames),
          hours: Number(summary.hours), cells: Number(summary.cells),
          partial: Number(summary.partial),
        };
      });

      return {
        value: stats,
        outcome: {
          rowsFetched: stats.frames, rowsInserted: stats.written, rowsRejected: 0,
          notes: { ...stats, days },
        },
      };
    },
  );

  if (vacuum) {
    // The rollup upserts, so every rewritten row leaves a dead tuple behind.
    // Measured: a full 9-day rebuild took hourly_frames from 28 MB to 49 MB in
    // one pass, 44,265 dead tuples at 20% of the table. Autovacuum does clear
    // it -- it had already run twice unprompted -- but it lags, and the table
    // grows while it waits. On a schedule that is a slow leak against a 500 MB
    // ceiling, so the job that causes the churn cleans up after itself.
    //
    // Deliberately outside withIngestRun: VACUUM cannot run inside a
    // transaction block, and this is maintenance rather than ingestion.
    const t0 = Date.now();
    await query('VACUUM (ANALYZE) hourly_frames');
    console.log(`  vacuumed hourly_frames in ${Date.now() - t0} ms`);
  }
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exitCode = 1; })
  .finally(closePool);
