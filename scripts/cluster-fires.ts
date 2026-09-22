/**
 * Fire clustering: turn detection pixels into nameable fires with stable ids.
 *
 *   npm run cluster:fires
 *   npm run cluster:fires -- --dry-run
 *   npm run cluster:fires -- --eps=1500 --minpoints=2 --split-hours=48
 *
 * 7,431 detections are not 7,431 fires -- the busiest H3 cell alone holds
 * 1,577 detections of one complex. Clustering gives the agent entities it can
 * name, track and compare over time.
 *
 * Identity is inherited through EXACT detection membership, never fuzzy
 * spatial matching: detections are immutable rows with stable ids, so "which
 * cluster did this detection belong to last run" is a lookup. Clustering can
 * therefore be recomputed freely without identities churning.
 */

import { config } from 'dotenv';
import { latLngToCell } from 'h3-js';
import { H3_RES } from '../lib/scope';
import { withIngestRun, withTransaction, closePool, reapStaleRuns, type TriggerKind } from '../lib/db';
import type { PoolClient } from 'pg';

config({ path: '.env.local', quiet: true });
config({ quiet: true });

const SOURCE_ID = 'firms_viirs';

function arg(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
}
const hasFlag = (n: string) => process.argv.includes(`--${n}`);

interface RunCluster {
  sid: number; seg: number; n: number;
  first_t: string; last_t: string;
  total_frp: number | null; max_frp: number | null;
  low_share: number; mean_conf: number;
  lat: number; lon: number;
  seed_detection_id: string; seed_key: string;
}
interface Prior { sid: number; seg: number; cluster_key: string; cluster_id: string; shared: number; prior_first: string }

async function buildRunClusters(
  client: PoolClient, eps: number, minpoints: number, splitHours: number,
): Promise<{ clusters: RunCluster[]; priors: Prior[]; noise: number }> {
  // Spatial DBSCAN in a metric projection (EPSG:5070, NAD83 Conus Albers) so
  // eps is in real metres. Degrees would be anisotropic across 31-60N, where a
  // longitude degree shrinks from ~95 km to ~62 km.
  await client.query(`
    CREATE TEMP TABLE _rc ON COMMIT DROP AS
    WITH spatial AS (
      SELECT detection_id, event_time, frp_mw, confidence, geom, observation_key,
             ST_ClusterDBSCAN(ST_Transform(geom::geometry, 5070), $1, $2) OVER () AS sid
        FROM fire_detections
    ), gapped AS (
      SELECT *,
             CASE WHEN event_time - lag(event_time)
                    OVER (PARTITION BY sid ORDER BY event_time, detection_id)
                  > ($3 || ' hours')::interval THEN 1 ELSE 0 END AS brk
        FROM spatial WHERE sid IS NOT NULL
    )
    SELECT detection_id, event_time, frp_mw, confidence, geom, observation_key, sid,
           sum(brk) OVER (PARTITION BY sid ORDER BY event_time, detection_id
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS seg
      FROM gapped`,
    [eps, minpoints, splitHours]);

  const [{ noise }] = (await client.query<{ noise: string }>(`
    SELECT (SELECT count(*) FROM fire_detections)
         - (SELECT count(*) FROM _rc) AS noise`)).rows
    .map((r) => ({ noise: Number(r.noise) }));

  await client.query(`
    CREATE TEMP TABLE _rcs ON COMMIT DROP AS
    SELECT sid, seg, count(*)::int AS n,
           min(event_time) AS first_t, max(event_time) AS last_t,
           sum(frp_mw) AS total_frp, max(frp_mw) AS max_frp,
           avg(CASE WHEN confidence = 'low' THEN 1.0 ELSE 0.0 END) AS low_share,
           avg(CASE WHEN confidence IN ('nominal','high') THEN 1.0 ELSE 0.0 END) AS mean_conf,
           ST_Centroid(ST_Collect(geom::geometry))::geography AS centroid,
           -- A cluster of coincident points envelopes to a POINT, not a polygon,
           -- which would violate the geography(Polygon) column.
           CASE WHEN ST_GeometryType(ST_Envelope(ST_Collect(geom::geometry))) = 'ST_Polygon'
                THEN ST_Envelope(ST_Collect(geom::geometry))::geography END AS bbox,
           (array_agg(detection_id ORDER BY event_time, detection_id))[1] AS seed_detection_id,
           (array_agg(observation_key ORDER BY event_time, detection_id))[1] AS seed_key
      FROM _rc GROUP BY sid, seg`);

  // Exact membership overlap with the PREVIOUS clustering. This is the whole
  // identity mechanism: no geometry comparison, just which rows were where.
  await client.query(`
    CREATE TEMP TABLE _prior ON COMMIT DROP AS
    SELECT r.sid, r.seg, c.cluster_key, c.cluster_id,
           count(*)::int AS shared, min(c.first_event_time) AS prior_first
      FROM _rc r
      JOIN fire_detections d ON d.detection_id = r.detection_id
      JOIN fire_clusters c   ON c.cluster_id  = d.cluster_id
     GROUP BY r.sid, r.seg, c.cluster_key, c.cluster_id`);

  const clusters = (await client.query<RunCluster>(`
    SELECT sid, seg, n, first_t::text, last_t::text, total_frp, max_frp,
           low_share, mean_conf,
           ST_Y(centroid::geometry) AS lat, ST_X(centroid::geometry) AS lon,
           seed_detection_id::text, seed_key
      FROM _rcs ORDER BY n DESC`)).rows;

  const priors = (await client.query<Prior>(`
    SELECT sid, seg, cluster_key, cluster_id::text, shared, prior_first::text FROM _prior`)).rows;

  return { clusters, priors, noise };
}

async function main(): Promise<void> {
  const eps = Number(arg('eps') ?? 1500);
  const minpoints = Number(arg('minpoints') ?? 2);
  const splitHours = Number(arg('split-hours') ?? 48);
  const dryRun = hasFlag('dry-run');
  const triggerKind = (arg('trigger') ?? 'manual') as TriggerKind;
  const methodVersion = `dbscan-${eps}m-${minpoints}pt-${splitHours}h-v1`;

  console.log(`\nFire clustering — eps=${eps}m minpoints=${minpoints} split=${splitHours}h` +
              `${dryRun ? ' (DRY RUN)' : ''}\n  method_version=${methodVersion}\n`);
  await reapStaleRuns(60);

  await withIngestRun(
    { sourceId: SOURCE_ID, feedVariant: 'clustering', triggerKind },
    async (ctx) => {
      // Held client, deliberately: temp tables are session-scoped and pool
      // queries can land on different connections. Safe here because this is
      // pure database work with no network waits.
      const stats = await withTransaction(async (client) => {
        const { clusters, priors, noise } = await buildRunClusters(client, eps, minpoints, splitHours);

        const priorsBy = new Map<string, Prior[]>();
        for (const p of priors) {
          const k = `${p.sid}/${p.seg}`;
          (priorsBy.get(k) ?? priorsBy.set(k, []).get(k)!).push(p);
        }

        let created = 0, inherited = 0, merged = 0;
        const merges: { surviving: string; absorbed: string; detections: number }[] = [];
        const assignments: { sid: number; seg: number; key: string }[] = [];

        for (const c of clusters) {
          const ps = priorsBy.get(`${c.sid}/${c.seg}`) ?? [];
          if (ps.length === 0) {
            // New fire: identity derives from its earliest detection, which is
            // immutable, so the key is reproducible rather than sequential.
            assignments.push({ sid: c.sid, seg: c.seg, key: `fire:${c.seed_key}` });
            created++;
          } else if (ps.length === 1) {
            assignments.push({ sid: c.sid, seg: c.seg, key: ps[0].cluster_key });
            inherited++;
          } else {
            // Genuine merge. The survivor is the prior cluster contributing the
            // most detections; ties break to the older fire, so identity flows
            // toward the longer-established entity.
            const sorted = [...ps].sort(
              (a, b) => b.shared - a.shared || a.prior_first.localeCompare(b.prior_first));
            const survivor = sorted[0];
            assignments.push({ sid: c.sid, seg: c.seg, key: survivor.cluster_key });
            for (const absorbed of sorted.slice(1)) {
              merges.push({
                surviving: survivor.cluster_key,
                absorbed: absorbed.cluster_key,
                detections: absorbed.shared,
              });
            }
            merged++;
          }
        }

        console.log(`  run clusters: ${clusters.length}  noise detections: ${noise}`);
        console.log(`  identity: created=${created} inherited=${inherited} merged=${merged}`);
        if (merges.length > 0) console.log(`  merge events: ${merges.length}`);

        if (dryRun) {
          console.log('\n  largest clusters this run:');
          for (const c of clusters.slice(0, 8)) {
            console.log(`    n=${String(c.n).padStart(4)} frp=${String(Math.round(c.total_frp ?? 0)).padStart(6)} MW ` +
              `low_conf=${(c.low_share * 100).toFixed(0)}%  @ ${c.lat.toFixed(3)},${c.lon.toFixed(3)}  ` +
              `${c.first_t.slice(0, 16)}..${c.last_t.slice(0, 16)}`);
          }
          return { clusters: clusters.length, noise, created, inherited, merged, written: 0 };
        }

        // Stage the (sid,seg) -> key mapping so the writes are bulk SQL.
        await client.query(`CREATE TEMP TABLE _keys (sid int, seg int, cluster_key text) ON COMMIT DROP`);
        for (let i = 0; i < assignments.length; i += 500) {
          const chunk = assignments.slice(i, i + 500);
          const tuples = chunk.map((_, j) => `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`);
          await client.query(
            `INSERT INTO _keys (sid, seg, cluster_key) VALUES ${tuples.join(',')}`,
            chunk.flatMap((a) => [a.sid, a.seg, a.key]));
        }

        // Footprint spread and FRP variability distinguish a wildfire from a
        // persistent industrial heat source: a fire's intensity swings as it
        // consumes fuel, a flare's does not. Measured separation is clean --
        // wildfires CV 0.63-2.60, industrial 0.30-0.37.
        await client.query(`
          CREATE TEMP TABLE _char ON COMMIT DROP AS
          SELECT r.sid, r.seg,
                 max(ST_Distance(r.geom, s.centroid))                        AS spread_m,
                 coalesce(stddev_pop(r.frp_mw) / nullif(avg(r.frp_mw), 0), 0) AS frp_cv,
                 EXTRACT(EPOCH FROM (max(r.event_time) - min(r.event_time)))/86400 AS duration_days
            FROM _rc r JOIN _rcs s ON s.sid = r.sid AND s.seg = r.seg
           GROUP BY r.sid, r.seg`);

        const up = await client.query(`
          INSERT INTO fire_clusters (
            cluster_key, first_event_time, last_event_time, centroid, bbox, h3_r5,
            detection_count, total_frp_mw, max_frp_mw, mean_confidence,
            low_confidence_share, seed_detection_id, is_active, method_version,
            last_run_id, computed_at,
            footprint_spread_m, frp_cv, duration_days, source_character)
          SELECT k.cluster_key, s.first_t, s.last_t, s.centroid, s.bbox,
                 -- h3 is computed in SQL from the centroid to avoid a round trip
                 substr(md5(ST_AsText(s.centroid)), 1, 15),
                 s.n, s.total_frp, s.max_frp, s.mean_conf, s.low_share,
                 s.seed_detection_id, true, $1, $2, now(),
                 ch.spread_m, ch.frp_cv, ch.duration_days,
                 CASE
                   -- Too few detections to characterise either way. Saying so
                   -- beats guessing.
                   WHEN s.n < 10 THEN 'indeterminate'
                   WHEN ch.duration_days > 4 AND ch.spread_m < 1500 AND ch.frp_cv < 0.6
                     THEN 'likely_industrial'
                   ELSE 'likely_wildfire'
                 END
            FROM _rcs s
            JOIN _keys k ON k.sid = s.sid AND k.seg = s.seg
            JOIN _char ch ON ch.sid = s.sid AND ch.seg = s.seg
          ON CONFLICT (cluster_key) DO UPDATE SET
            first_event_time = LEAST(fire_clusters.first_event_time, EXCLUDED.first_event_time),
            last_event_time  = GREATEST(fire_clusters.last_event_time, EXCLUDED.last_event_time),
            centroid = EXCLUDED.centroid, bbox = EXCLUDED.bbox,
            detection_count = EXCLUDED.detection_count,
            total_frp_mw = EXCLUDED.total_frp_mw, max_frp_mw = EXCLUDED.max_frp_mw,
            mean_confidence = EXCLUDED.mean_confidence,
            low_confidence_share = EXCLUDED.low_confidence_share,
            is_active = true, method_version = EXCLUDED.method_version,
            last_run_id = EXCLUDED.last_run_id, computed_at = now(),
            footprint_spread_m = EXCLUDED.footprint_spread_m,
            frp_cv = EXCLUDED.frp_cv, duration_days = EXCLUDED.duration_days,
            source_character = EXCLUDED.source_character
          RETURNING cluster_id`, [methodVersion, ctx.runId]);

        // Point every detection at its cluster.
        await client.query(`
          UPDATE fire_detections d
             SET cluster_id = c.cluster_id
            FROM _rc r
            JOIN _keys k  ON k.sid = r.sid AND k.seg = r.seg
            JOIN fire_clusters c ON c.cluster_key = k.cluster_key
           WHERE d.detection_id = r.detection_id
             AND (d.cluster_id IS DISTINCT FROM c.cluster_id)`);

        // Detections that fell to noise this run must not keep a stale pointer.
        const orphaned = await client.query(`
          UPDATE fire_detections d SET cluster_id = NULL
           WHERE d.cluster_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM _rc r WHERE r.detection_id = d.detection_id)`);

        for (const m of merges) {
          await client.query(
            `INSERT INTO fire_cluster_merges
               (surviving_key, absorbed_key, absorbed_detections, run_id, method_version)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (surviving_key, absorbed_key, method_version) DO NOTHING`,
            [m.surviving, m.absorbed, m.detections, ctx.runId, methodVersion]);
        }

        // A cluster with no detections left is history, not a live fire.
        const deact = await client.query(`
          UPDATE fire_clusters c SET is_active = false
           WHERE c.is_active
             AND NOT EXISTS (SELECT 1 FROM fire_detections d WHERE d.cluster_id = c.cluster_id)`);

        // Labels come only from a CONTAINING zone, never the nearest one.
        // NWS zone names read like a person's description of a place
        // ("Yosemite NP outside of the valley", "Northern Boise National
        // Forest"), which is exactly what makes them useful -- and exactly why
        // attaching the wrong one matters. The previous nearest-within-60 km
        // version named a neighbouring zone 223 times out of 358, including
        // Mexican fires labelled with US county names.
        const lbl = await client.query(`
          UPDATE fire_clusters c
             SET label = n.name, label_source = n.src
            FROM (
              SELECT c2.cluster_id, z.name, 'nws_zone_containing:' || z.zone_type AS src
                FROM fire_clusters c2
                CROSS JOIN LATERAL (
                  SELECT z.name, z.zone_type FROM nws_zones z
                   WHERE z.geom IS NOT NULL
                     AND ST_Intersects(z.geom, c2.centroid)
                   -- Prefer the more specific zone type when several contain the point
                   ORDER BY CASE z.zone_type WHEN 'fire' THEN 1 WHEN 'county' THEN 2 ELSE 3 END
                   LIMIT 1) z
               WHERE c2.is_active AND c2.label IS NULL
            ) n
           WHERE c.cluster_id = n.cluster_id`);

        // Cluster centroids become sample points, which is how Step 5's wind
        // ingestion gets data AT the fires -- the precision attribution needs.
        //
        // Only ATTRIBUTABLE clusters: 495 of 617 are 'indeterminate' (fewer
        // than 10 detections, too sparse to characterise), and they could not
        // be meaningfully attributed to a downwind reading anyway. Sampling
        // wind at them would cost ~29 MB to compute scores that round to zero.
        // The 122 retained carry 86.4% of total FRP.
        await client.query(`
          INSERT INTO sample_points (point_id, point_kind, lat, lon, geom, h3_r5, region, active)
          SELECT 'fire:' || c.cluster_key, 'fire_cluster',
                 ST_Y(c.centroid::geometry), ST_X(c.centroid::geometry), c.centroid,
                 substr(md5(c.cluster_key), 1, 15), c.region, true
            FROM fire_clusters c
           WHERE c.is_active AND c.source_character <> 'indeterminate'
          ON CONFLICT (point_id) DO UPDATE SET
            lat = EXCLUDED.lat, lon = EXCLUDED.lon, geom = EXCLUDED.geom, active = true`);

        const deactSp = await client.query(`
          UPDATE sample_points p SET active = false
           WHERE p.point_kind = 'fire_cluster' AND p.active
             AND NOT EXISTS (SELECT 1 FROM fire_clusters c
                              WHERE c.is_active AND c.source_character <> 'indeterminate'
                                AND 'fire:' || c.cluster_key = p.point_id)`);

        console.log(`  written: ${up.rowCount} clusters, labelled ${lbl.rowCount}, ` +
          `deactivated ${deact.rowCount}, orphaned detections ${orphaned.rowCount}`);
        console.log(`  fire sample_points: +active, ${deactSp.rowCount} deactivated`);

        return {
          clusters: clusters.length, noise, created, inherited, merged,
          written: up.rowCount ?? 0, merges: merges.length,
        };
      });

      return {
        value: stats,
        outcome: {
          rowsFetched: stats.clusters, rowsInserted: stats.written, rowsRejected: 0,
          notes: { ...stats, eps, minpoints, splitHours, methodVersion },
        },
      };
    },
  );
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exitCode = 1; })
  .finally(closePool);
