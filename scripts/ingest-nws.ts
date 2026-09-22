/**
 * NWS alerts ingester.
 *
 *   npm run ingest:nws                        active alerts (the cron path)
 *   npm run ingest:nws -- --days=7 --trigger=backfill
 *   npm run ingest:nws -- --days=7 --dry-run
 *
 * IMPORTANT constraint on this feed, established by probing: NWS retains only
 * about 7-14 days of alert history. Beyond that the data is gone upstream --
 * a national query 30 days back returns zero features. This is the ONLY feed
 * in the system that decays, and it is why the September 2020 seeded episode
 * cannot have an advisory layer at all.
 */

import { config } from 'dotenv';
import { NWS_AREAS } from '../lib/scope';
import { parseAlertFeature, fetchAlertsPaged, ensureZonesCached, NWS_BASE, type AlertRow }
  from '../lib/nws';
import { withIngestRun, closePool, type TriggerKind, type IngestRunContext } from '../lib/db';
import { describeFetchError } from '../lib/http';

config({ path: '.env.local', quiet: true });
config({ quiet: true });

const SOURCE_ID = 'nws_alerts';
const BATCH_ROWS = 50;          // long description fields; keep params modest

function arg(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
}
const hasFlag = (n: string) => process.argv.includes(`--${n}`);

const COLUMNS = [
  'source_id', 'run_id', 'alert_id', 'event_type', 'severity', 'urgency', 'certainty',
  'status', 'message_type', 'headline', 'description', 'instruction', 'area_desc',
  'ugc_codes', 'same_codes', 'references_ids', 'geom', 'sent', 'effective',
  'onset', 'ends', 'expires', 'source_url',
] as const;
const PARAMS_PER_ROW = 23;

function buildInsert(rowCount: number): string {
  const rows: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const b = i * PARAMS_PER_ROW;
    const p = (n: number) => `$${b + n}`;
    rows.push(
      `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},` +
        `${p(10)},${p(11)},${p(12)},${p(13)},${p(14)}::text[],${p(15)}::text[],${p(16)}::text[],` +
        // NWS publishes Polygon, the column is MultiPolygon -- ST_Multi coerces.
        `CASE WHEN ${p(17)}::text IS NULL THEN NULL
              ELSE ST_Multi(ST_GeomFromGeoJSON(${p(17)}::text))::geography END,` +
        `${p(18)},${p(19)},${p(20)},${p(21)},${p(22)},${p(23)})`,
    );
  }
  return (
    `INSERT INTO alerts (${COLUMNS.join(', ')})\nVALUES\n  ${rows.join(',\n  ')}\n` +
    // Same message seen again is a no-op, preserving the original ingest_time.
    // An AMENDED alert has a different id and sent, so it lands as a new row.
    `ON CONFLICT (alert_id, sent) DO NOTHING`
  );
}

async function insertBatch(ctx: IngestRunContext, batch: AlertRow[]): Promise<number> {
  const params: unknown[] = [];
  for (const a of batch) {
    params.push(
      SOURCE_ID, ctx.runId, a.alertId, a.eventType, a.severity, a.urgency, a.certainty,
      a.status, a.messageType, a.headline, a.description, a.instruction, a.areaDesc,
      a.ugcCodes, a.sameCodes, a.referencesIds,
      a.geometry ? JSON.stringify(a.geometry) : null,
      a.sent, a.effective, a.onset, a.ends, a.expires, a.sourceUrl,
    );
  }
  const res = await ctx.client.query(buildInsert(batch.length), params);
  return res.rowCount ?? 0;
}

/**
 * Re-resolve zone geometry for every zone referenced by a stored alert,
 * retrying ones that previously failed. Used to backfill geometry after the
 * zone-type fallback fix, and safe to re-run at any time.
 */
async function resolveZonesOnly(): Promise<void> {
  const { query } = await import('../lib/db');
  const rows = await query<{ zone_id: string }>(
    `SELECT DISTINCT unnest(ugc_codes) AS zone_id FROM alerts WHERE ugc_codes IS NOT NULL`);
  const zoneIds = rows.map((r) => r.zone_id);
  console.log(`\nre-resolving ${zoneIds.length} distinct zones referenced by stored alerts\n`);

  await withIngestRun(
    { sourceId: SOURCE_ID, feedVariant: 'zone_geometry', triggerKind: 'manual' },
    async (ctx) => {
      const zones = await ensureZonesCached(ctx.client, zoneIds, { retryFailed: true, maxFetch: 600 });
      console.log(
        `  requested=${zones.requested} already_ok=${zones.alreadyCached} ` +
        `fetched=${zones.fetched} unresolvable=${zones.notFound} errored=${zones.errored}`);
      return { value: zones, outcome: { rowsFetched: zones.requested, rowsInserted: zones.fetched, rowsRejected: 0, notes: { zones } } };
    },
  );
}

async function main(): Promise<void> {
  if (hasFlag('resolve-zones')) { await resolveZonesOnly(); return; }
  const days = arg('days') ? Number(arg('days')) : null;
  const triggerKind = (arg('trigger') ?? (days ? 'backfill' : 'cron')) as TriggerKind;
  const dryRun = hasFlag('dry-run');

  if (days !== null && (!Number.isFinite(days) || days <= 0 || days > 30)) {
    throw new Error('--days must be between 1 and 30 (NWS retains only ~7-14 days)');
  }

  // Backfill walks 2-day windows: a single wide query would hit the 500-row
  // page cap repeatedly and lean entirely on cursor pagination.
  const windows: { url: string; start: Date; end: Date; label: string }[] = [];
  if (days === null) {
    const now = new Date();
    windows.push({
      // NO `limit` here: /alerts/active rejects it with HTTP 400
      // ("Query parameter \"limit\" is not recognized") -- unlike /alerts,
      // which requires it. The active endpoint also returns no `pagination`
      // key, delivering every active alert in one response (347 nationwide
      // when checked), so paging is neither available nor needed.
      url: `${NWS_BASE}/alerts/active?area=${NWS_AREAS}`,
      start: now, end: now, label: 'active',
    });
  } else {
    for (let d = days; d > 0; d -= 2) {
      const start = new Date(Date.now() - d * 86_400_000);
      const end = new Date(Date.now() - Math.max(d - 2, 0) * 86_400_000);
      windows.push({
        url: `${NWS_BASE}/alerts?area=${NWS_AREAS}` +
             `&start=${start.toISOString()}&end=${end.toISOString()}&limit=500`,
        start, end,
        label: `${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`,
      });
    }
  }

  console.log(
    `\nNWS alerts — ${days === null ? 'ACTIVE' : `backfill ${days}d`} ` +
      `trigger=${triggerKind} windows=${windows.length}` +
      `${dryRun ? ' (DRY RUN, no database)' : ''}\n`,
  );

  let totalNew = 0;
  let failures = 0;

  for (const w of windows) {
    const t0 = Date.now();
    try {
      if (dryRun) {
        const { features, pages } = await fetchAlertsPaged(w.url);
        const parsed = features
          .map((f) => parseAlertFeature(f))
          .filter((a): a is AlertRow => a !== null);
        const zoneIds = parsed.flatMap((a) => a.ugcCodes);
        const withGeom = parsed.filter((a) => a.geometry).length;
        console.log(
          `  ${w.label.padEnd(24)} features=${String(features.length).padStart(4)} ` +
            `parsed=${String(parsed.length).padStart(4)} pages=${pages} ` +
            `polygon=${withGeom} zone_coded=${parsed.length - withGeom} ` +
            `distinct_zones=${new Set(zoneIds).size} (${Date.now() - t0} ms)`,
        );
        continue;
      }

      const inserted = await withIngestRun(
        {
          sourceId: SOURCE_ID, triggerKind, requestUrl: w.url,
          windowStart: w.start, windowEnd: w.end,
        },
        async (ctx) => {
          // The fetch happens inside the run, so a network failure is recorded
          // rather than vanishing -- see the FIRMS outage of 2026-09-22, where
          // six endpoints failed and left no trace at all. Safe here because
          // withIngestRun hands over the pool, not a checked-out client.
          const { features, pages, truncated } = await fetchAlertsPaged(w.url);
          const parsed = features
            .map((f) => parseAlertFeature(f))
            .filter((a): a is AlertRow => a !== null);
          const unparseable = features.length - parsed.length;
          const zoneIds = parsed.flatMap((a) => a.ugcCodes);
          const withGeom = parsed.filter((a) => a.geometry).length;

          // Zones first: the alert geometry view unions cached zone polygons,
          // so resolving them before insert means an alert is never briefly
          // mapless after it lands.
          const zones = await ensureZonesCached(ctx.client, zoneIds);

          let count = 0;
          for (let i = 0; i < parsed.length; i += BATCH_ROWS) {
            count += await insertBatch(ctx, parsed.slice(i, i + BATCH_ROWS));
          }
          return {
            // The counts travel out with the value, because the summary line
            // is printed outside the run and these no longer exist there.
            value: {
              count, zones,
              featureCount: features.length,
              parsedCount: parsed.length,
              withGeom,
            },
            outcome: {
              rowsFetched: features.length,
              rowsInserted: count,
              // Only genuinely unparseable features count as rejected.
              rowsRejected: unparseable,
              httpStatus: 200,
              notes: {
                pages, truncated,
                with_polygon: withGeom,
                zone_coded: parsed.length - withGeom,
                duplicates_skipped: parsed.length - count,
                zones,
              },
            },
          };
        },
      );

      totalNew += inserted.count;
      console.log(
        `  ${w.label.padEnd(24)} features=${String(inserted.featureCount).padStart(4)} ` +
          `new=${String(inserted.count).padStart(4)} ` +
          `dup=${String(inserted.parsedCount - inserted.count).padStart(4)} ` +
          `poly=${String(inserted.withGeom).padStart(3)} ` +
          `zoned=${String(inserted.parsedCount - inserted.withGeom).padStart(3)} ` +
          `zones(+${inserted.zones.fetched} cached=${inserted.zones.alreadyCached} ` +
          `nf=${inserted.zones.notFound} err=${inserted.zones.errored}) ` +
          `(${Date.now() - t0} ms)`,
      );
    } catch (err) {
      failures++;
      console.error(`  ${w.label.padEnd(24)} FAILED: ${describeFetchError(err)}`);
    }
  }

  console.log(`\nnew_alerts=${totalNew} windows_failed=${failures}\n`);
  if (failures === windows.length) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exitCode = 1; })
  .finally(closePool);
