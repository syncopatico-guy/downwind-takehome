/**
 * OpenAQ ingester.
 *
 *   npm run ingest:openaq -- --mode=stations            discover + select (daily)
 *   npm run ingest:openaq -- --mode=latest              bulk current values (hourly cron)
 *   npm run ingest:openaq -- --mode=backfill --days=7   per-sensor history
 *   npm run ingest:openaq -- --mode=stations --dry-run
 *
 * Three modes because the API forces three different access patterns under a
 * 60 req/min limit:
 *   stations  /v3/locations honours bbox     -> a few paginated requests
 *   latest    /v3/parameters/{id}/latest     -> ~22 pages, filtered client-side
 *   backfill  /v3/sensors/{id}/hours         -> one request per sensor, but each
 *                                               covers the entire date range
 */

import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import { latLngToCell } from 'h3-js';
import { H3_RES, inScope, AQ_PARAMETERS } from '../lib/scope';
import {
  fetchStationsInBbox, fetchLatestForParameter, fetchSensorHours, fetchStationById,
  tierOf, PARAM_IDS, stats, setBudget, type OpenAqStation,
} from '../lib/openaq';
import {
  withIngestRun, query, closePool, reapStaleRuns,
  type TriggerKind, type IngestRunContext,
} from '../lib/db';

config({ path: '.env.local', quiet: true });
config({ quiet: true });

const SOURCE_ID = 'openaq';
const STATION_PREFIX = 'openaq:';

function arg(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
}
const hasFlag = (n: string) => process.argv.includes(`--${n}`);

/** value_hash: covers the VALUE only — see migration 005 for why. */
function valueHash(value: number): string {
  return createHash('sha256').update(value.toFixed(6)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// mode=stations
// ---------------------------------------------------------------------------

/** Upsert one station and its PM sensors. Shared by roster discovery and the
 *  individual fetches used to recover sensors missing from /locations?bbox. */
async function upsertStation(
  client: IngestRunContext['client'], s: OpenAqStation,
): Promise<number> {
  const stationId = `${STATION_PREFIX}${s.upstreamId}`;
  const h3 = latLngToCell(s.lat, s.lon, H3_RES.detection);
  // r4 (~1,770 km2) groups stations for round-robin spatial selection. r6
  // proved far too fine: 1,401 stations occupied 766 r6 cells, so "fill empty
  // cells" selected almost everything (see migration 006).
  const h3r4 = latLngToCell(s.lat, s.lon, 4);

  await client.query(
    `INSERT INTO aq_stations (
       station_id, source_id, upstream_id, name, locality, provider, owner_name,
       instrument_tier, is_monitor, is_mobile, instruments,
       lat, lon, geom, h3_r6, h3_r4, country, datetime_first, datetime_last,
       source_url, last_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             ST_SetSRID(ST_MakePoint($13::double precision,$12::double precision),4326)::geography,
             $14,$19,$15,$16,$17,$18, now())
     ON CONFLICT (station_id) DO UPDATE SET
       name = EXCLUDED.name, locality = EXCLUDED.locality,
       provider = EXCLUDED.provider, owner_name = EXCLUDED.owner_name,
       instrument_tier = EXCLUDED.instrument_tier, is_monitor = EXCLUDED.is_monitor,
       is_mobile = EXCLUDED.is_mobile, instruments = EXCLUDED.instruments,
       datetime_first = EXCLUDED.datetime_first, datetime_last = EXCLUDED.datetime_last,
       h3_r4 = EXCLUDED.h3_r4, last_seen = now()`,
    [stationId, SOURCE_ID, String(s.upstreamId), s.name, s.locality, s.provider,
     s.ownerName, tierOf(s.isMonitor), s.isMonitor, s.isMobile, s.instruments,
     s.lat, s.lon, h3, s.country, s.datetimeFirst, s.datetimeLast,
     `https://explore.openaq.org/locations/${s.upstreamId}`, h3r4],
  );

  let sensorRows = 0;
  for (const sn of s.sensors) {
    if (!(AQ_PARAMETERS as readonly string[]).includes(sn.parameter)) continue;
    await client.query(
      `INSERT INTO aq_sensors (sensor_id, station_id, parameter, units)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (sensor_id) DO UPDATE SET last_seen = now(), units = EXCLUDED.units`,
      [sn.sensorId, stationId, sn.parameter, sn.units],
    );
    sensorRows++;
  }
  return sensorRows;
}

async function ingestStations(
  triggerKind: TriggerKind, dryRun: boolean, maxResolve: number, skipRoster = false,
): Promise<void> {
  // Draining the queue is resumable and chunkable, but re-fetching and
  // re-upserting 2,799 roster rows on every chunk is pure waste -- the roster
  // changes daily, the queue drains in batches.
  const { stations, pages, truncated } = skipRoster
    ? { stations: [] as OpenAqStation[], pages: 0, truncated: false }
    : await fetchStationsInBbox();
  const fixed = stations.filter((s) => s.isMobile !== true);
  const withPm = fixed.filter((s) =>
    s.sensors.some((sn) => (AQ_PARAMETERS as readonly string[]).includes(sn.parameter)));
  const live24 = withPm.filter(
    (s) => s.datetimeLast && Date.now() - s.datetimeLast.getTime() < 86_400_000);
  const tiers = withPm.reduce<Record<string, number>>((acc, s) => {
    const t = tierOf(s.isMonitor); acc[t] = (acc[t] ?? 0) + 1; return acc;
  }, {});

  if (skipRoster) {
    console.log('  roster refresh SKIPPED (--skip-roster): draining queue only');
  } else {
    console.log(`  discovered=${stations.length} pages=${pages}${truncated ? ' (TRUNCATED)' : ''}`);
    console.log(`  fixed=${fixed.length} with_pm=${withPm.length} live_24h=${live24.length}`);
    console.log(`  tiers=${JSON.stringify(tiers)}`);
  }

  if (dryRun) return;

  await withIngestRun(
    { sourceId: SOURCE_ID, feedVariant: 'stations', triggerKind },
    async (ctx) => {
      let upserted = 0;
      let sensorRows = 0;

      for (const s of withPm) {
        sensorRows += await upsertStation(ctx.client, s);
        upserted++;
      }

      // The individual-fetch drain that used to live here has been removed:
      // every queued id returns 404 from /v3/locations/{id}. Those stations
      // are now synthesized in `latest` mode from the bulk feed's coordinates
      // at zero API cost. All that remains is reconciling the queue.
      const rec = await ctx.client.query(
        `UPDATE aq_discovery_queue q SET status = 'synthesized', last_attempt_at = now()
          WHERE q.status = 'pending'
            AND EXISTS (SELECT 1 FROM aq_stations s
                         WHERE s.upstream_id = q.upstream_id::text)`);
      const resolved = rec.rowCount ?? 0;
      const noPm = 0, failedResolve = 0;
      console.log(`  queue reconciled: ${resolved} now backed by a synthesized station`);

      // Selection is an auditable SQL pass (see migration 004), not hidden here.
      const sel = await ctx.client.query<{ reason: string; n: string }>(
        'SELECT * FROM select_aq_stations($1, $2, $3)', [800, '24 hours', 10]);
      console.log('  selection:');
      for (const r of sel.rows) console.log(`    ${r.reason.padEnd(18)} ${r.n}`);

      // Selected stations become sample points, which is where Step 5 samples
      // wind and CAMS — preserving Open-Meteo's ~9-11 km native resolution at
      // the sensors we actually cite.
      const sp = await ctx.client.query(
        `INSERT INTO sample_points (point_id, point_kind, lat, lon, geom, h3_r5, region, active)
         SELECT 'stn:' || s.station_id, 'station', s.lat, s.lon, s.geom,
                h3_lat_lng_to_cell_string(s.lat, s.lon, $1), s.region, true
           FROM aq_stations s WHERE s.selected
         ON CONFLICT (point_id) DO UPDATE SET active = true`,
        [H3_RES.samplePoint],
      ).catch(async (err) => {
        // h3 postgres extension is not installed; compute cells in JS instead.
        if (!/h3_lat_lng_to_cell_string|function .* does not exist/i.test(err.message)) throw err;
        const rows = await ctx.client.query<{ station_id: string; lat: number; lon: number; region: string | null }>(
          'SELECT station_id, lat, lon, region FROM aq_stations WHERE selected');
        for (const r of rows.rows) {
          await ctx.client.query(
            `INSERT INTO sample_points (point_id, point_kind, lat, lon, geom, h3_r5, region, active)
             VALUES ($1,'station',$2,$3,
                     ST_SetSRID(ST_MakePoint($3::double precision,$2::double precision),4326)::geography,
                     $4,$5,true)
             ON CONFLICT (point_id) DO UPDATE SET active = true`,
            [`stn:${r.station_id}`, r.lat, r.lon,
             latLngToCell(r.lat, r.lon, H3_RES.samplePoint), r.region],
          );
        }
        return { rowCount: rows.rowCount ?? 0 };
      });

      // Deactivate points whose station is no longer selected. Without this the
      // upsert only ever sets active=true, so stations dropped by a later
      // selection linger and Step 5 samples wind at more points than we chose
      // to keep -- silently inflating storage.
      const deact = await ctx.client.query(
        `UPDATE sample_points p SET active = false
          WHERE p.point_kind = 'station' AND p.active
            AND NOT EXISTS (SELECT 1 FROM aq_stations s
                             WHERE s.selected AND 'stn:' || s.station_id = p.point_id)`);
      console.log(`  sample_points activated=${sp.rowCount ?? 0} deactivated=${deact.rowCount ?? 0}`);

      return {
        value: undefined,
        outcome: {
          rowsFetched: stations.length,
          rowsInserted: upserted,
          rowsRejected: stations.length - fixed.length,
          notes: {
            pages, truncated, sensors: sensorRows,
            fixed: fixed.length, with_pm: withPm.length, live_24h: live24.length,
            tiers, selection: sel.rows, api_requests: stats.requests,
            gap_resolved: resolved, gap_no_pm: noPm, gap_failed: failedResolve,
          },
        },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// mode=latest
// ---------------------------------------------------------------------------

async function ingestLatest(triggerKind: TriggerKind, dryRun: boolean): Promise<void> {
  // Sensors belonging to SELECTED stations. The bulk endpoint returns the whole
  // world, so this map is how we keep only what we committed to storing.
  const sensorRows = await query<{ sensor_id: string; station_id: string; parameter: string; units: string | null }>(
    `SELECT sn.sensor_id::text, sn.station_id, sn.parameter, sn.units
       FROM aq_sensors sn JOIN aq_stations s ON s.station_id = sn.station_id
      WHERE s.selected`);
  const wanted = new Map(sensorRows.map((r) => [Number(r.sensor_id), r]));
  // Every location we have metadata for -- not just selected ones -- so the
  // queue only ever holds genuinely unknown locations.
  const knownLocations = new Set(
    (await query<{ upstream_id: string }>('SELECT upstream_id FROM aq_stations'))
      .map((r) => Number(r.upstream_id)));
  console.log(`  selected sensors: ${wanted.size}  known locations: ${knownLocations.size}`);
  if (wanted.size === 0) {
    console.log('  nothing selected — run --mode=stations first');
    return;
  }

  // 6h floor: comfortably wider than the hourly cadence so a late-reporting
  // station is still caught, while cutting the global payload substantially.
  const since = new Date(Date.now() - 6 * 3600_000);

  for (const param of AQ_PARAMETERS) {
    const paramId = PARAM_IDS[param];
    const t0 = Date.now();
    const { readings, pages, truncated } = await fetchLatestForParameter(paramId, since);
    const mine = readings.filter((r) => wanted.has(r.sensorId));
    // The bulk feed returns more rows than it has distinct sensors (overlapping
    // pages), so surface both counts -- otherwise "matched 926, inserted 649"
    // looks like data loss when it is the dedupe working correctly.
    const distinctSensors = new Set(mine.map((r) => r.sensorId)).size;
    const inBox = readings.filter((r) => inScope(r.lat, r.lon)).length;

    // Cheap side of gap discovery: note in-bbox locations we have no roster
    // entry for. Resolving them costs a request each, so that is deferred to
    // `stations` mode rather than done here on the hourly path.
    const unknownHere = new Map<number, {
      lat: number; lon: number; sensorId: number; eventTime: Date;
    }>();
    for (const r of readings) {
      if (!inScope(r.lat, r.lon)) continue;
      if (!knownLocations.has(r.locationId)) {
        unknownHere.set(r.locationId, {
          lat: r.lat, lon: r.lon, sensorId: r.sensorId, eventTime: r.eventTime,
        });
      }
    }

    if (dryRun) {
      console.log(
        `  ${param}: global=${readings.length} pages=${pages} in_bbox=${inBox} ` +
        `selected=${mine.length} unknown=${unknownHere.size}` +
        `${truncated ? ' TRUNCATED' : ''} (${Date.now() - t0} ms)`);
      continue;
    }

    const inserted = await withIngestRun(
      {
        sourceId: SOURCE_ID, feedVariant: `latest:${param}`, triggerKind,
        windowStart: since, windowEnd: new Date(),
      },
      async (ctx) => {
        // Synthesize a minimal station for every in-bbox location we have no
        // metadata for. Coordinates come from the reading itself, so this
        // costs no extra requests. Tier stays 'unknown' -- these are probably
        // low-cost sensors, but a guess is not something the agent can cite.
        let synthesized = 0;
        for (const [locId, c] of unknownHere) {
          await ctx.client.query(
            `INSERT INTO aq_discovery_queue (upstream_id, lat, lon)
             VALUES ($1,$2,$3) ON CONFLICT (upstream_id) DO NOTHING`,
            [locId, c.lat, c.lon]);

          const stationId = `${STATION_PREFIX}${locId}`;
          const r = await ctx.client.query(
            `INSERT INTO aq_stations (
               station_id, source_id, upstream_id, instrument_tier, is_mobile,
               lat, lon, geom, h3_r6, h3_r4, datetime_last, metadata_source,
               source_url, last_seen)
             VALUES ($1,$2,$3,'unknown',false,$4,$5,
                     ST_SetSRID(ST_MakePoint($5::double precision,$4::double precision),4326)::geography,
                     $6,$7,$8,'bulk_feed_synthesized',$9, now())
             ON CONFLICT (station_id) DO UPDATE SET
               datetime_last = GREATEST(aq_stations.datetime_last, EXCLUDED.datetime_last),
               last_seen = now()`,
            [stationId, SOURCE_ID, String(locId), c.lat, c.lon,
             latLngToCell(c.lat, c.lon, H3_RES.detection),
             latLngToCell(c.lat, c.lon, 4), c.eventTime,
             `https://explore.openaq.org/locations/${locId}`],
          );
          if ((r.rowCount ?? 0) > 0) synthesized++;

          await ctx.client.query(
            `INSERT INTO aq_sensors (sensor_id, station_id, parameter, units)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (sensor_id) DO UPDATE SET last_seen = now()`,
            [c.sensorId, stationId, param, 'µg/m³'],
          );

          await ctx.client.query(
            `UPDATE aq_discovery_queue SET status='synthesized', last_attempt_at=now()
              WHERE upstream_id=$1`, [locId]);
        }
        if (synthesized > 0) console.log(`    synthesized ${synthesized} station(s) from the feed`);

        let count = 0;
        for (const r of mine) {
          const meta = wanted.get(r.sensorId)!;
          const res = await ctx.client.query(
            `INSERT INTO aq_measurements
               (source_id, run_id, station_id, sensor_id, parameter, event_time,
                value, unit, value_hash, source_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (source_id, station_id, parameter, event_time, value_hash)
             DO NOTHING`,
            [SOURCE_ID, ctx.runId, meta.station_id, r.sensorId, param, r.eventTime,
             r.value, meta.units ?? 'µg/m³', valueHash(r.value),
             `https://explore.openaq.org/locations/${r.locationId}`],
          );
          count += res.rowCount ?? 0;
        }
        return {
          value: count,
          outcome: {
            rowsFetched: readings.length, rowsInserted: count, rowsRejected: 0,
            notes: {
              pages, truncated, global: readings.length, in_bbox: inBox,
              matched_selected: mine.length, duplicates_skipped: mine.length - count,
              unknown_synthesized: unknownHere.size, api_requests: stats.requests,
              matched_distinct_sensors: distinctSensors,
              feed_level_repeats: mine.length - distinctSensors,
            },
          },
        };
      },
    );
    console.log(
      `  ${param}: global=${readings.length} in_bbox=${inBox} matched=${mine.length} ` +
      `(${distinctSensors} distinct sensors, ${mine.length - distinctSensors} feed repeats) ` +
      `new=${inserted} synthesized=${unknownHere.size} (${Date.now() - t0} ms)`);
  }
}

// ---------------------------------------------------------------------------
// mode=backfill
// ---------------------------------------------------------------------------

async function backfill(days: number, triggerKind: TriggerKind, dryRun: boolean): Promise<void> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  // Self-resuming: skip sensors that already have coverage in this window.
  // Two earlier long jobs died to interruptions, and an offset-based resume
  // would silently drift if the sensor set changed between runs. Asking the
  // data what is already present cannot drift.
  // Resume on the recorded ATTEMPT, not on whether rows came back. Inferring
  // it from results meant sensors with no data in the window were re-fetched
  // on every run and could never converge. --force re-attempts everything.
  const force = hasFlag('force');
  const sensors = await query<{
    sensor_id: string; station_id: string; parameter: string;
    units: string | null; metadata_source: string;
  }>(
    `SELECT sn.sensor_id::text, sn.station_id, sn.parameter, sn.units, s.metadata_source
       FROM aq_sensors sn
       JOIN aq_stations s ON s.station_id = sn.station_id
      WHERE s.selected
        AND ($2::boolean OR sn.backfill_attempted_at IS NULL
             OR sn.backfill_window_start > $1::timestamptz)
      ORDER BY sn.backfill_attempted_at NULLS FIRST, s.instrument_tier, sn.sensor_id
      LIMIT $3`,
    [from, force, Number(arg('limit') ?? 100000)]);

  const [{ total }] = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM aq_sensors sn
       JOIN aq_stations s ON s.station_id = sn.station_id WHERE s.selected`);

  console.log(
    `  window=${from.toISOString().slice(0,10)}..${to.toISOString().slice(0,10)}  ` +
    `sensors_remaining=${sensors.length} of ${total} selected ` +
    `(already covered: ${Number(total) - sensors.length})`);
  console.log(`  estimated wall time at ~54 req/min: ~${Math.ceil(sensors.length / 54)} min`);
  if (dryRun) return;
  if (sensors.length === 0) { console.log('  nothing to do — all selected sensors already covered'); return; }

  await withIngestRun(
    {
      sourceId: SOURCE_ID, feedVariant: `backfill:${days}d`, triggerKind,
      windowStart: from, windowEnd: to,
    },
    async (ctx) => {
      let inserted = 0, fetched = 0, failed = 0, usedFallback = 0;
      let done = 0;

      for (const s of sensors) {
        try {
          // Pick the endpoint by what we already know about the station rather
          // than discovering it every time. Synthesized stations have no hourly
          // rollup computed -- /hours returns found:0 for them while
          // /measurements returns ~165 readings for the same window -- so they
          // go straight to /measurements. Trying /hours first for these cost
          // two requests per sensor for nothing.
          const preferred = s.metadata_source === 'bulk_feed_synthesized'
            ? 'measurements' as const
            : 'hours' as const;
          const alternate = preferred === 'hours'
            ? 'measurements' as const
            : 'hours' as const;

          let hours = await fetchSensorHours(Number(s.sensor_id), from, to, preferred);
          if (hours.length === 0) {
            hours = await fetchSensorHours(Number(s.sensor_id), from, to, alternate);
            if (hours.length > 0) usedFallback++;
          }
          fetched += hours.length;

          // One multi-row INSERT per sensor rather than one per reading.
          // At 168 readings each, per-row statements made database round-trips
          // dominate the loop -- 22 sensors/min against a rate limit that
          // allows 54. Batching removes the bottleneck entirely.
          if (hours.length > 0) {
            const params: unknown[] = [];
            const tuples: string[] = [];
            hours.forEach((h, i) => {
              const b = i * 11;
              const p = (n: number) => `$${b + n}`;
              tuples.push(`(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)})`);
              params.push(
                SOURCE_ID, ctx.runId, s.station_id, Number(s.sensor_id), s.parameter,
                h.eventTime, h.value, s.units ?? 'µg/m³', valueHash(h.value), h.hasFlags,
                `https://explore.openaq.org/locations/${s.station_id.replace(STATION_PREFIX, '')}`,
              );
            });
            const res = await ctx.client.query(
              `INSERT INTO aq_measurements
                 (source_id, run_id, station_id, sensor_id, parameter, event_time,
                  value, unit, value_hash, has_flags, source_url)
               VALUES ${tuples.join(',')}
               ON CONFLICT (source_id, station_id, parameter, event_time, value_hash)
               DO NOTHING`,
              params,
            );
            inserted += res.rowCount ?? 0;
          }

          // Record the attempt regardless of yield, so a sensor that reported
          // nothing is never re-fetched for this window.
          await ctx.client.query(
            `UPDATE aq_sensors
                SET backfill_attempted_at = now(), backfill_window_start = $2, backfill_rows = $3
              WHERE sensor_id = $1`,
            [Number(s.sensor_id), from, hours.length]);
        } catch (err) {
          // One dead sensor must not abort a long backfill.
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          if (failed <= 3) console.error(`    sensor ${s.sensor_id} failed: ${msg.slice(0,90)}`);
          if (msg.includes('budget exhausted')) {
            console.log(`    budget reached at ${done}/${sensors.length} — re-run to continue`);
            break;
          }
        }
        done++;
        if (done % 50 === 0) {
          console.log(`    ${done}/${sensors.length} sensors — ${inserted} rows, ${failed} failed, ${stats.requests} api calls`);
        }
      }

      console.log(`  fetched=${fetched} inserted=${inserted} fallback_used=${usedFallback} failed_sensors=${failed}`);
      return {
        value: undefined,
        outcome: {
          rowsFetched: fetched, rowsInserted: inserted, rowsRejected: 0,
          notes: {
            days, sensors: sensors.length, failed_sensors: failed,
            measurements_fallback_used: usedFallback, api_requests: stats.requests,
          },
        },
      };
    },
  );
}

async function main(): Promise<void> {
  const mode = arg('mode') ?? 'latest';
  const dryRun = hasFlag('dry-run');
  const days = arg('days') ? Number(arg('days')) : 7;
  const triggerKind = (arg('trigger') ??
    (mode === 'backfill' ? 'backfill' : mode === 'stations' ? 'manual' : 'cron')) as TriggerKind;

  const budgetMin = Number(arg('budget') ?? (mode === 'backfill' ? 45 : 20));
  const maxResolve = Number(arg('max-resolve') ?? 600);
  setBudget(budgetMin);

  console.log(`\nOpenAQ — mode=${mode} budget=${budgetMin}min${dryRun ? ' (DRY RUN)' : ''}\n`);
  await reapStaleRuns(60);

  if (mode === 'stations') {
    await ingestStations(triggerKind, dryRun, maxResolve, hasFlag('skip-roster'));
  }
  else if (mode === 'latest') await ingestLatest(triggerKind, dryRun);
  else if (mode === 'backfill') await backfill(days, triggerKind, dryRun);
  else throw new Error(`unknown --mode=${mode} (stations | latest | backfill)`);

  console.log(`\napi_requests=${stats.requests} retries=${stats.retries} rate_limit_waits=${stats.rateLimitWaits}\n`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exitCode = 1; })
  .finally(closePool);
