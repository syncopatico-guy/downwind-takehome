/**
 * FIRMS active-fire ingester.
 *
 *   npm run ingest:firms                    live 24h window, all six endpoints
 *   npm run ingest:firms -- --window=7d --trigger=backfill
 *   npm run ingest:firms -- --dry-run       fetch + parse only, no database
 *   npm run ingest:firms -- --variant=viirs_noaa21
 *
 * Each of the six endpoints (3 VIIRS satellites x 2 regions) gets its OWN
 * ingest run, so one satellite's endpoint failing is recorded against that
 * endpoint rather than poisoning the whole source's health.
 *
 * Detections are filtered to the scope bbox before insert (--no-scope-filter
 * overrides). Note this REVERSES an earlier decision to store everything: the
 * store-all argument rested on the live window being unrecoverable, which is
 * true of feeds like GBFS but NOT of FIRMS -- its keyed archive API can
 * re-fetch any historical window on demand. Since nothing is permanently lost,
 * filtering wins: it cuts the largest raw table by ~63% (measured: only 29% of
 * fetched rows fall in scope), and scope can be widened later by re-running a
 * backfill with --no-scope-filter.
 */

import { config } from 'dotenv';
import { firmsFeedVariants, type FirmsWindow } from '../lib/scope';
import { parseFirmsCsv, type FirmsDetection } from '../lib/firms';
import { withIngestRun, closePool, type TriggerKind, type IngestRunContext } from '../lib/db';
import { fetchWithRetry, describeFetchError } from '../lib/http';

config({ path: '.env.local', quiet: true });
config({ quiet: true });

const SOURCE_ID = 'firms_viirs';
const BATCH_ROWS = 500;          // 500 x 15 params = 7,500, well under Postgres' 65,535
const FETCH_TIMEOUT_MS = 60_000;
// All six endpoints share one hostname, so a single unreachable host fails
// every one of them at once -- which is exactly what happened on 2026-09-22,
// six failures inside 1.5 seconds. Retries turn a blip into a slow run rather
// than a lost half-hour of coverage.
const FETCH_ATTEMPTS = 3;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=');
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const COLUMNS = [
  'source_id', 'run_id', 'observation_key', 'lat', 'lon', 'geom', 'h3_r6',
  'event_time', 'frp_mw', 'brightness_ti4', 'brightness_ti5', 'confidence',
  'satellite', 'instrument', 'daynight', 'proc_version',
] as const;
const PARAMS_PER_ROW = 15;       // every column except geom, which is derived

function buildInsert(rowCount: number): string {
  const rows: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const b = i * PARAMS_PER_ROW;
    const p = (n: number) => `$${b + n}`;
    rows.push(
      `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},` +
        // geom is derived from the same lat/lon params rather than passed twice
        `ST_SetSRID(ST_MakePoint(${p(5)}::double precision,${p(4)}::double precision),4326)::geography,` +
        `${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)},${p(13)},${p(14)},${p(15)})`,
    );
  }
  return (
    `INSERT INTO fire_detections (${COLUMNS.join(', ')})\nVALUES\n  ${rows.join(',\n  ')}\n` +
    // The append-only contract: a detection we already hold is a no-op, which
    // preserves its ORIGINAL ingest_time -- i.e. when we first learned of it.
    `ON CONFLICT (source_id, observation_key, proc_version) DO NOTHING`
  );
}

async function insertBatch(
  ctx: IngestRunContext, batch: FirmsDetection[],
): Promise<number> {
  const params: unknown[] = [];
  for (const d of batch) {
    params.push(
      SOURCE_ID, ctx.runId, d.observationKey, d.lat, d.lon, d.h3r6,
      d.eventTime, d.frpMw, d.brightnessTi4, d.brightnessTi5, d.confidence,
      d.satellite, d.instrument, d.daynight, d.procVersion,
    );
  }
  const res = await ctx.client.query(buildInsert(batch.length), params);
  return res.rowCount ?? 0;
}

async function fetchCsv(url: string): Promise<{ body: string; status: number }> {
  const { body, status } = await fetchWithRetry(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    attempts: FETCH_ATTEMPTS,
    label: 'firms',
    headers: { 'User-Agent': process.env.NWS_USER_AGENT ?? '(downwind)' },
  });
  return { body, status };
}

async function main(): Promise<void> {
  const window = (arg('window') ?? '24h') as FirmsWindow;
  const triggerKind = (arg('trigger') ?? 'cron') as TriggerKind;
  const variantFilter = arg('variant');
  const dryRun = hasFlag('dry-run');
  const scopeFilter = !hasFlag('no-scope-filter');

  if (!['24h', '48h', '7d'].includes(window)) {
    throw new Error(`--window must be 24h, 48h or 7d (got "${window}")`);
  }

  let variants = firmsFeedVariants(window);
  if (variantFilter) {
    variants = variants.filter((v) => v.feedVariant.includes(variantFilter));
    if (variants.length === 0) throw new Error(`no endpoint matches --variant=${variantFilter}`);
  }

  console.log(
    `\nFIRMS ingest — window=${window} trigger=${triggerKind} ` +
      `endpoints=${variants.length} scope=${scopeFilter ? 'bbox' : 'ALL'}` +
      `${dryRun ? ' (DRY RUN, no database)' : ''}\n`,
  );

  let totalParsed = 0;
  let totalInserted = 0;
  let totalInScope = 0;
  let failures = 0;

  for (const v of variants) {
    const started = Date.now();

    // The event-time window this run INTENDED to cover. Computed BEFORE the
    // fetch, deliberately: recording the intent is what later lets a query
    // prove a gap rather than merely suspect one, and a run that dies in the
    // fetch is precisely the case that needs proving.
    const days = window === '7d' ? 7 : window === '48h' ? 2 : 1;
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - days * 86_400_000);

    try {
      if (dryRun) {
        const { body } = await fetchCsv(v.url);
        const parsed = parseFirmsCsv(body, {
          satellite: v.platform,
          instrument: v.instrument,
        });
        const toStore = scopeFilter
          ? parsed.detections.filter((d) => d.inScope)
          : parsed.detections;
        totalParsed += parsed.detections.length;
        totalInScope += parsed.inScopeCount;
        console.log(
          `  ${v.feedVariant.padEnd(22)} parsed=${String(parsed.detections.length).padStart(6)} ` +
            `to-store=${String(toStore.length).padStart(6)} ` +
            `rejected=${parsed.rowsRejected} ` +
            `anomalies=${JSON.stringify(parsed.anomalies)} ` +
            `(${Date.now() - started} ms)`,
        );
        continue;
      }

      const result = await withIngestRun(
        {
          sourceId: SOURCE_ID,
          feedVariant: v.feedVariant,
          triggerKind,
          requestUrl: v.url,
          windowStart,
          windowEnd,
        },
        async (ctx) => {
          // The fetch happens INSIDE the run, not before it.
          //
          // It used to run first, and on 2026-09-22 all six endpoints failed
          // at the network level -- leaving ZERO rows in ingest_runs. The feed
          // went stale and the database could not say why, because a failed
          // attempt was indistinguishable from no attempt. That is the exact
          // distinction the provenance log exists to make (Decision 4b).
          //
          // This is safe by construction: withIngestRun hands over the pool
          // rather than a checked-out client, precisely so that long HTTP work
          // can happen in here without idling a connection to death.
          const { body, status } = await fetchCsv(v.url);
          const parsed = parseFirmsCsv(body, {
            satellite: v.platform,
            instrument: v.instrument,
          });

          // Scope filtering happens here, not in the parser: the parser's job
          // is a faithful read of what the feed published, and the
          // anomaly/reject counts stay meaningful over the whole payload
          // rather than a subset.
          const toStore = scopeFilter
            ? parsed.detections.filter((d) => d.inScope)
            : parsed.detections;

          totalParsed += parsed.detections.length;
          totalInScope += parsed.inScopeCount;

          let count = 0;
          for (let i = 0; i < toStore.length; i += BATCH_ROWS) {
            count += await insertBatch(ctx, toStore.slice(i, i + BATCH_ROWS));
          }

          return {
            value: { count, parsed, stored: toStore.length },
            outcome: {
              rowsFetched: parsed.rowsFetched,
              rowsInserted: count,
              rowsRejected: parsed.rowsRejected,
              httpStatus: status,
              notes: {
                window,
                scope_filtered: scopeFilter,
                in_scope: parsed.inScopeCount,
                out_of_scope: parsed.outOfScopeCount,
                // Dropped by the scope filter -- deliberately NOT counted as
                // rows_rejected, which is reserved for malformed data and marks
                // a run 'partial'. "This fire is in Texas" is not a defect.
                dropped_out_of_scope: parsed.detections.length - toStore.length,
                // Duplicates are expected and healthy: the 30-min cron keeps
                // re-reading a 24h window, so most rows are already held.
                duplicates_skipped: toStore.length - count,
                anomalies: parsed.anomalies,
                reject_samples: parsed.rejectSamples,
              },
            },
          };
        },
      );

      totalInserted += result.count;
      console.log(
        `  ${v.feedVariant.padEnd(22)} fetched=${String(result.parsed.rowsFetched).padStart(6)} ` +
          `new=${String(result.count).padStart(6)} ` +
          `dup=${String(result.stored - result.count).padStart(6)} ` +
          `dropped=${String(result.parsed.detections.length - result.stored).padStart(6)} ` +
          `rejected=${result.parsed.rowsRejected} (${Date.now() - started} ms)`,
      );
    } catch (err) {
      failures++;
      // One endpoint failing must not abort the others -- partial data with a
      // recorded failure beats no data with no explanation. describeFetchError
      // walks the cause chain, because undici reports every network fault as
      // the single unactionable word "fetch failed".
      console.error(
        `  ${v.feedVariant.padEnd(22)} FAILED: ${describeFetchError(err)}`,
      );
    }
  }

  console.log(
    `\nparsed=${totalParsed} in-scope=${totalInScope}` +
      (dryRun ? '' : ` inserted=${totalInserted}`) +
      ` endpoints_failed=${failures}\n`,
  );

  if (failures === variants.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
