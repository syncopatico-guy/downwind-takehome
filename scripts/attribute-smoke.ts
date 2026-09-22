/**
 * Smoke attribution: which fires plausibly explain an elevated reading.
 *
 *   npm run attribute:smoke
 *   npm run attribute:smoke -- --dry-run
 *   npm run attribute:smoke -- --max-km=300 --min-score=0.01 --days=7
 *
 * This is the system's one causal claim, so it is framed as a HYPOTHESIS WITH
 * EVIDENCE rather than a conclusion. Every row carries the numbers that
 * produced it -- distance, wind alignment, travel time, fire intensity at the
 * time the smoke would have left, mixing depth -- so the agent can show its
 * work instead of being trusted.
 *
 * Bounded deliberately. Unbounded, this is 800 stations x 576 hours x 617
 * fires = 284M pairs. Two bounds make it ~25k rows:
 *   1. Only attributable fires (122 of 617; the other 495 have fewer than 10
 *      detections and carry 13.6% of FRP between them).
 *   2. Only station-hours with something to explain -- PM2.5 at 2x the
 *      station's own 7-day median AND at least 8 ug/m3. Attribution explains
 *      anomalies, not baselines.
 *
 * TRAVEL TIME is a single-step back-trajectory. Wind speed at the reading's
 * hour estimates how long the smoke took to arrive; the fire's intensity and
 * the wind direction are then read at that EARLIER hour. Smoke from 100 km
 * away at 20 km/h left five hours ago, so the fire's state then is what
 * matters -- attributing to its state on arrival would credit a fire that had
 * only just ignited. Using arrival-hour speed to estimate the lag is an
 * approximation that avoids a circular dependency; a full iterative
 * trajectory through the curved wind field was judged too much modelling risk.
 */

import { config } from 'dotenv';
import { withIngestRun, withTransaction, closePool, reapStaleRuns, type TriggerKind } from '../lib/db';

config({ path: '.env.local', quiet: true });
config({ quiet: true });

const SOURCE_ID = 'openaq';   // attribution is anchored to the measurement it explains

function arg(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
}
const hasFlag = (n: string) => process.argv.includes(`--${n}`);

async function main(): Promise<void> {
  const maxKm = Number(arg('max-km') ?? 300);
  const minScore = Number(arg('min-score') ?? 0.01);
  const days = Number(arg('days') ?? 8);
  const ratioTrigger = Number(arg('ratio') ?? 2);
  const floorTrigger = Number(arg('floor') ?? 8);
  const dryRun = hasFlag('dry-run');
  const triggerKind = (arg('trigger') ?? 'manual') as TriggerKind;
  const methodVersion = `upwind-cone-v1-${maxKm}km-r${ratioTrigger}f${floorTrigger}`;

  console.log(`\nSmoke attribution — max=${maxKm}km min_score=${minScore} ` +
              `trigger=${ratioTrigger}x median AND >=${floorTrigger} µg/m³` +
              `${dryRun ? ' (DRY RUN)' : ''}\n  method_version=${methodVersion}\n`);
  await reapStaleRuns(60);

  await withIngestRun(
    { sourceId: SOURCE_ID, feedVariant: 'attribution', triggerKind },
    async (ctx) => {
      const stats = await withTransaction(async (client) => {
        // ---- 1. station-hours with something to explain -------------------
        await client.query(`
          CREATE TEMP TABLE _elevated ON COMMIT DROP AS
          WITH baseline AS (
            SELECT station_id,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS med
              FROM aq_measurements
             WHERE parameter = 'pm25'
               AND event_time > now() - ($1 || ' days')::interval
             GROUP BY station_id
          ), latest AS (
            -- Latest-known value per station-hour, honouring the append-only
            -- revision model rather than double-counting corrections.
            SELECT DISTINCT ON (station_id, event_time)
                   station_id, event_time, value
              FROM aq_measurements
             WHERE parameter = 'pm25'
               AND event_time > now() - ($1 || ' days')::interval
             ORDER BY station_id, event_time, ingest_time DESC
          )
          SELECT l.station_id, l.event_time, l.value AS observed_pm25, b.med AS baseline_pm25
            FROM latest l
            JOIN baseline b ON b.station_id = l.station_id
            JOIN aq_stations s ON s.station_id = l.station_id AND s.selected
           WHERE b.med > 0
             AND l.value >= $2 * b.med
             AND l.value >= $3`,
          [days, ratioTrigger, floorTrigger]);

        const [{ n: elevated }] = (await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM _elevated`)).rows;
        console.log(`  station-hours to explain: ${elevated}`);

        // ---- 2. candidate fire pairs, with the lag computed ---------------
        await client.query(`
          CREATE TEMP TABLE _cand ON COMMIT DROP AS
          SELECT
            e.station_id, e.event_time, e.observed_pm25, e.baseline_pm25,
            c.cluster_id, c.source_character,
            ST_Distance(s.geom, c.centroid) / 1000.0                         AS distance_km,
            -- Azimuth FROM the fire TO the station: the direction smoke must
            -- travel to arrive here. Degrees clockwise from north.
            degrees(ST_Azimuth(c.centroid::geometry, s.geom::geometry))       AS bearing_deg,
            wf.wind_speed_kmh                                                AS arrival_speed,
            wf.pbl_height_m,
            -- Single-step lag: distance / speed at the arrival hour, floored
            -- so a dead calm does not produce an infinite travel time.
            LEAST(
              (ST_Distance(s.geom, c.centroid) / 1000.0)
                / GREATEST(coalesce(wf.wind_speed_kmh, 0), 3.0),
              48.0)                                                          AS travel_hours
          FROM _elevated e
          JOIN aq_stations s   ON s.station_id = e.station_id
          JOIN fire_clusters c ON c.is_active
                              AND c.source_character <> 'indeterminate'
                              AND ST_DWithin(s.geom, c.centroid, $1)
          LEFT JOIN v_weather_latest wf
                 ON wf.point_id = 'fire:' || c.cluster_key
                AND wf.event_time = date_trunc('hour', e.event_time)`,
          [maxKm * 1000]);

        const [{ n: cand }] = (await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM _cand`)).rows;
        console.log(`  candidate station-hour x fire pairs: ${cand}`);

        // ---- 3. score, using wind direction and fire state AT THE LAG -----
        await client.query(`
          CREATE TEMP TABLE _scored ON COMMIT DROP AS
          WITH lagged AS (
            SELECT
              k.*,
              date_trunc('hour', k.event_time - (k.travel_hours || ' hours')::interval) AS lag_hour
              FROM _cand k
          ), joined AS (
            SELECT
              l.*,
              wl.wind_dir_deg   AS lag_wind_dir,
              wl.wind_speed_kmh AS lag_wind_speed,
              -- Fire intensity in a 3-hour window around the departure time:
              -- a single overpass may not coincide with the exact hour.
              (SELECT coalesce(sum(d.frp_mw), 0) FROM fire_detections d
                WHERE d.cluster_id = l.cluster_id
                  AND d.event_time BETWEEN l.lag_hour - interval '90 minutes'
                                       AND l.lag_hour + interval '90 minutes') AS frp_at_lag
              FROM lagged l
              LEFT JOIN v_weather_latest wl
                     ON wl.point_id = 'fire:' || (SELECT cluster_key FROM fire_clusters fc
                                                   WHERE fc.cluster_id = l.cluster_id)
                    AND wl.event_time = l.lag_hour
          )
          SELECT
            j.*,
            -- Angular distance between where the smoke had to go and where the
            -- wind was actually pushing it. Wind direction is the direction it
            -- comes FROM, so smoke travels toward dir+180.
            LEAST(
              abs(j.bearing_deg - ((j.lag_wind_dir + 180)::numeric % 360)),
              360 - abs(j.bearing_deg - ((j.lag_wind_dir + 180)::numeric % 360))
            )::double precision AS alignment_deg
            FROM joined j
           WHERE j.lag_wind_dir IS NOT NULL`);

        const [{ n: scored }] = (await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM _scored`)).rows;
        console.log(`  pairs with wind at the departure hour: ${scored}`);

        if (dryRun) {
          console.log('\n  strongest candidate explanations (dry run):');
          for (const r of (await client.query<Record<string, string>>(`
            SELECT station_id, event_time::text, round(observed_pm25::numeric,1)::text AS pm,
                   round(baseline_pm25::numeric,1)::text AS base,
                   round(distance_km::numeric,0)::text AS km,
                   round(alignment_deg::numeric,0)::text AS align,
                   round(travel_hours::numeric,1)::text AS hrs,
                   round(frp_at_lag::numeric,0)::text AS frp,
                   source_character
              FROM _scored
             WHERE alignment_deg <= 90 AND frp_at_lag > 0
             ORDER BY (exp(-power(alignment_deg/30.0,2))
                       * (1/(1+power(distance_km/50.0,2)))
                       * ln(1+frp_at_lag)) DESC
             LIMIT 10`)).rows)
            console.log(`    pm=${r.pm.padStart(6)} (base ${r.base.padStart(4)}) ` +
              `${r.km.padStart(4)}km align=${r.align.padStart(3)}° lag=${r.hrs.padStart(4)}h ` +
              `frp=${r.frp.padStart(6)}MW ${r.source_character.padEnd(18)} ${r.station_id}`);
          return { elevated: Number(elevated), candidates: Number(cand), scored: Number(scored), stored: 0 };
        }

        // ---- 4. persist, with every factor kept separately ---------------
        const ins = await client.query(`
          INSERT INTO smoke_attributions (
            station_id, event_time, cluster_id, score,
            distance_km, bearing_deg, wind_dir_deg, wind_speed_kmh, alignment_deg,
            travel_hours, frp_mw, pbl_height_m, method_version,
            lagged_event_time, frp_at_lag, observed_pm25, baseline_pm25,
            alignment_factor, distance_factor, frp_factor, pbl_factor,
            source_character, run_id)
          SELECT
            s.station_id, s.event_time, s.cluster_id,
            LEAST(1.0,
              exp(-power(s.alignment_deg/30.0, 2))
              * (1.0/(1.0 + power(s.distance_km/50.0, 2)))
              * (ln(1 + s.frp_at_lag) / ln(1 + 5000.0))
              * LEAST(2.5, GREATEST(0.5, 800.0 / GREATEST(coalesce(s.pbl_height_m, 800), 50)))
            )::real,
            s.distance_km, s.bearing_deg, s.lag_wind_dir, s.lag_wind_speed, s.alignment_deg,
            s.travel_hours, s.frp_at_lag, s.pbl_height_m, $1,
            s.lag_hour, s.frp_at_lag, s.observed_pm25, s.baseline_pm25,
            exp(-power(s.alignment_deg/30.0, 2))::real,
            (1.0/(1.0 + power(s.distance_km/50.0, 2)))::real,
            (ln(1 + s.frp_at_lag) / ln(1 + 5000.0))::real,
            LEAST(2.5, GREATEST(0.5, 800.0 / GREATEST(coalesce(s.pbl_height_m, 800), 50)))::real,
            s.source_character, $2
            FROM _scored s
           WHERE s.alignment_deg <= 90          -- beyond 90° it is not downwind at all
             AND s.frp_at_lag > 0               -- the fire must have been burning then
             AND LEAST(1.0,
                   exp(-power(s.alignment_deg/30.0, 2))
                   * (1.0/(1.0 + power(s.distance_km/50.0, 2)))
                   * (ln(1 + s.frp_at_lag) / ln(1 + 5000.0))
                   * LEAST(2.5, GREATEST(0.5, 800.0 / GREATEST(coalesce(s.pbl_height_m, 800), 50)))
                 ) >= $3
          ON CONFLICT (station_id, event_time, cluster_id, method_version) DO NOTHING`,
          [methodVersion, ctx.runId, minScore]);

        console.log(`  attributions stored: ${ins.rowCount}`);
        return {
          elevated: Number(elevated), candidates: Number(cand),
          scored: Number(scored), stored: ins.rowCount ?? 0,
        };
      });

      return {
        value: stats,
        outcome: {
          rowsFetched: stats.candidates, rowsInserted: stats.stored, rowsRejected: 0,
          notes: { ...stats, maxKm, minScore, ratioTrigger, floorTrigger, methodVersion },
        },
      };
    },
  );
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exitCode = 1; })
  .finally(closePool);
