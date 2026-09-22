/**
 * Open-Meteo ingester: wind/boundary-layer and CAMS air quality.
 *
 *   npm run ingest:openmeteo -- --mode=weather
 *   npm run ingest:openmeteo -- --mode=cams
 *   npm run ingest:openmeteo -- --mode=both --dry-run
 *   npm run ingest:openmeteo -- --mode=grid-init      (seed the CAMS grid once)
 *
 * Sampling differs by feed, deliberately:
 *   wind  -> station and fire-cluster points only. Open-Meteo's native
 *            resolution is ~9-11 km, and the September 2020 episode was driven
 *            by east winds channeling through the Columbia Gorge -- terrain
 *            detail a coarse grid would smooth away.
 *   CAMS  -> the same points PLUS a coarse H3 r3 grid, because a model's value
 *            is partly to cover ground that has no sensors, which is most of
 *            fire country.
 */

import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import { latLngToCell, cellToLatLng, getResolution } from 'h3-js';
import { BBOX, H3_RES } from '../lib/scope';
import {
  fetchWeather, fetchCams, stats,
  WEATHER_VARS, CAMS_VARS, type SamplePoint, type HourlySeries,
} from '../lib/openmeteo';
import {
  withIngestRun, query, closePool, reapStaleRuns,
  type TriggerKind, type IngestRunContext,
} from '../lib/db';

config({ path: '.env.local', quiet: true });
config({ quiet: true });

const WEATHER_SOURCE = 'openmeteo_wind';
const CAMS_SOURCE = 'openmeteo_cams_aq';
const INSERT_BATCH = 400;

function arg(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
}
const hasFlag = (n: string) => process.argv.includes(`--${n}`);

function hashValues(vals: (number | null)[]): string {
  return createHash('sha256')
    .update(vals.map((v) => (v === null ? '' : v.toFixed(4))).join('|'))
    .digest('hex').slice(0, 16);
}

/** Seed the coarse CAMS grid: every H3 r3 cell whose centre falls in the bbox. */
async function initGrid(dryRun: boolean): Promise<number> {
  const cells = new Set<string>();
  for (let lat = BBOX.minLat; lat <= BBOX.maxLat; lat += 0.2) {
    for (let lon = BBOX.minLon; lon <= BBOX.maxLon; lon += 0.2) {
      cells.add(latLngToCell(lat, lon, 3));
    }
  }
  console.log(`  H3 r3 cells covering bbox: ${cells.size}`);
  if (dryRun) return cells.size;

  let inserted = 0;
  for (const cell of cells) {
    const [lat, lon] = cellToLatLng(cell);
    const r = await query(
      `INSERT INTO sample_points (point_id, point_kind, lat, lon, geom, h3_r5, active)
       VALUES ($1,'grid',$2,$3,
               ST_SetSRID(ST_MakePoint($3::double precision,$2::double precision),4326)::geography,
               $4,true)
       ON CONFLICT (point_id) DO UPDATE SET active = true`,
      [`grid:${cell}`, lat, lon, latLngToCell(lat, lon, H3_RES.samplePoint)],
    );
    inserted += r.length === 0 ? 1 : 1;
  }
  console.log(`  grid sample_points upserted: ${cells.size}`);
  return inserted;
}

async function loadPoints(kinds: string[]): Promise<SamplePoint[]> {
  const rows = await query<{ point_id: string; lat: number; lon: number }>(
    `SELECT point_id, lat, lon FROM sample_points
      WHERE active AND point_kind = ANY($1) ORDER BY point_id`, [kinds]);
  return rows.map((r) => ({ pointId: r.point_id, lat: Number(r.lat), lon: Number(r.lon) }));
}

/** Flatten a batched hourly response into per-row tuples. */
function toRows(
  series: HourlySeries[], vars: readonly string[], now: number,
): { pointId: string; eventTime: Date; vals: (number | null)[]; isForecast: boolean }[] {
  const out: { pointId: string; eventTime: Date; vals: (number | null)[]; isForecast: boolean }[] = [];
  for (const s of series) {
    for (let i = 0; i < s.times.length; i++) {
      const t = s.times[i];
      if (Number.isNaN(t.getTime())) continue;
      out.push({
        pointId: s.pointId,
        eventTime: t,
        vals: vars.map((v) => s.values[v]?.[i] ?? null),
        // Anything beyond the current hour is prediction, not observation.
        // Keeping them distinguishable is what lets the replay show what we
        // EXPECTED to happen alongside what did.
        isForecast: t.getTime() > now,
      });
    }
  }
  return out;
}

async function insertWeather(
  ctx: IngestRunContext,
  rows: { pointId: string; eventTime: Date; vals: (number | null)[]; isForecast: boolean }[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const chunk = rows.slice(i, i + INSERT_BATCH);
    const params: unknown[] = [];
    const tuples: string[] = [];
    chunk.forEach((r, j) => {
      const b = j * 13;
      const p = (n: number) => `$${b + n}`;
      tuples.push(`(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)},${p(13)})`);
      // WEATHER_VARS order: speed, direction, gusts, pbl, temp, rh, precip
      const [spd, dir, gust, pbl, temp, rh, precip] = r.vals;
      params.push(
        WEATHER_SOURCE, ctx.runId, r.pointId, r.eventTime,
        dir, spd, gust, temp, rh, precip, pbl, r.isForecast, hashValues(r.vals),
      );
    });
    const res = await ctx.client.query(
      `INSERT INTO weather_hourly
         (source_id, run_id, point_id, event_time, wind_dir_deg, wind_speed_kmh,
          wind_gust_kmh, temp_c, rh_pct, precip_mm, pbl_height_m, is_forecast, value_hash)
       VALUES ${tuples.join(',')}
       ON CONFLICT (source_id, point_id, event_time, value_hash) DO NOTHING`,
      params);
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

async function insertCams(
  ctx: IngestRunContext,
  rows: { pointId: string; eventTime: Date; vals: (number | null)[]; isForecast: boolean }[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const chunk = rows.slice(i, i + INSERT_BATCH);
    const params: unknown[] = [];
    const tuples: string[] = [];
    chunk.forEach((r, j) => {
      const b = j * 12;
      const p = (n: number) => `$${b + n}`;
      tuples.push(`(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)})`);
      // CAMS_VARS order: pm2_5, pm10, us_aqi, aod, dust, co
      const [pm25, pm10, aqi, aod, dust, co] = r.vals;
      params.push(
        CAMS_SOURCE, ctx.runId, r.pointId, r.eventTime,
        pm25, pm10, aqi === null ? null : Math.round(aqi),
        aod, dust, co, r.isForecast, hashValues(r.vals),
      );
    });
    const res = await ctx.client.query(
      `INSERT INTO model_aq_hourly
         (source_id, run_id, point_id, event_time, pm25, pm10, us_aqi,
          aod550, dust, carbon_monoxide, is_forecast, value_hash)
       VALUES ${tuples.join(',')}
       ON CONFLICT (source_id, point_id, event_time, value_hash) DO NOTHING`,
      params);
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

async function runFeed(
  which: 'weather' | 'cams', triggerKind: TriggerKind, dryRun: boolean,
  pastDays: number, forecastDays: number,
): Promise<void> {
  const kinds = which === 'weather'
    ? ['station', 'fire_cluster']
    : ['station', 'fire_cluster', 'grid'];
  const points = await loadPoints(kinds);
  const sourceId = which === 'weather' ? WEATHER_SOURCE : CAMS_SOURCE;

  console.log(`  ${which}: ${points.length} points (${kinds.join('+')}), ` +
              `past=${pastDays}d forecast=${forecastDays}d, ` +
              `~${Math.ceil(points.length / 200)} requests`);
  if (points.length === 0) { console.log('    no active points — skipping'); return; }

  const t0 = Date.now();
  const series = which === 'weather'
    ? await fetchWeather(points, pastDays, forecastDays,
        (d, t) => console.log(`    fetched ${d}/${t} points`))
    : await fetchCams(points, pastDays, forecastDays,
        (d, t) => console.log(`    fetched ${d}/${t} points`));

  const now = Date.now();
  const vars = which === 'weather' ? WEATHER_VARS : CAMS_VARS;
  const rows = toRows(series, vars, now);
  const forecastRows = rows.filter((r) => r.isForecast).length;

  if (dryRun) {
    console.log(`    would insert ${rows.length} rows ` +
                `(${rows.length - forecastRows} analysis, ${forecastRows} forecast) ` +
                `(${Date.now() - t0} ms)`);
    return;
  }

  const inserted = await withIngestRun(
    {
      sourceId, triggerKind,
      windowStart: new Date(now - pastDays * 86_400_000),
      windowEnd: new Date(now + forecastDays * 86_400_000),
    },
    async (ctx) => {
      const n = which === 'weather'
        ? await insertWeather(ctx, rows)
        : await insertCams(ctx, rows);
      return {
        value: n,
        outcome: {
          rowsFetched: rows.length, rowsInserted: n, rowsRejected: 0,
          notes: {
            points: points.length, kinds, past_days: pastDays,
            forecast_days: forecastDays, forecast_rows: forecastRows,
            analysis_rows: rows.length - forecastRows,
            duplicates_skipped: rows.length - n, api_requests: stats.requests,
          },
        },
      };
    },
  );

  console.log(`    rows=${rows.length} new=${inserted} dup=${rows.length - inserted} ` +
              `forecast=${forecastRows} (${Date.now() - t0} ms)`);
}

async function main(): Promise<void> {
  const mode = arg('mode') ?? 'both';
  const dryRun = hasFlag('dry-run');
  const pastDays = Number(arg('past-days') ?? 7);
  const forecastDays = Number(arg('forecast-days') ?? 2);
  const triggerKind = (arg('trigger') ?? 'cron') as TriggerKind;

  console.log(`\nOpen-Meteo — mode=${mode}${dryRun ? ' (DRY RUN)' : ''}\n`);
  await reapStaleRuns(60);

  if (mode === 'grid-init') { await initGrid(dryRun); }
  else if (mode === 'weather') { await runFeed('weather', triggerKind, dryRun, pastDays, forecastDays); }
  else if (mode === 'cams') { await runFeed('cams', triggerKind, dryRun, pastDays, forecastDays); }
  else if (mode === 'both') {
    await runFeed('weather', triggerKind, dryRun, pastDays, forecastDays);
    await runFeed('cams', triggerKind, dryRun, pastDays, forecastDays);
  } else throw new Error(`unknown --mode=${mode}`);

  console.log(
    `\napi_requests=${stats.requests} retries=${stats.retries} ` +
    `locations=${stats.locations} rate_limit_429s=${stats.rateLimit429s} ` +
    `rate_limit_wait=${(stats.rateLimitWaitMs / 1000).toFixed(0)}s\n`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exitCode = 1; })
  .finally(closePool);
