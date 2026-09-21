/**
 * Schema sanity check: npm run verify:schema
 *
 * Confirms extensions, tables, views, indexes and the source registry landed,
 * and exercises PostGIS with a real distance calculation. Re-runnable at any
 * time; useful after a migration or when a deployment looks wrong.
 */
import { config } from 'dotenv';
import { query, closePool } from '../lib/db';

config({ path: '.env.local', quiet: true });
config({ quiet: true });

async function main(): Promise<void> {
  const ext = await query<{ extname: string; extversion: string }>(
    `SELECT extname, extversion FROM pg_extension
      WHERE extname IN ('postgis','pgcrypto') ORDER BY extname`);
  console.log('extensions:');
  ext.forEach((e) => console.log(`  ${e.extname} ${e.extversion}`));

  const tables = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'
        AND table_name NOT IN ('spatial_ref_sys')
      ORDER BY table_name`);
  console.log(`\ntables (${tables.length}):`);
  tables.forEach((t) => console.log(`  ${t.table_name}`));

  const views = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.views
      WHERE table_schema='public' AND table_name LIKE 'v_%' ORDER BY table_name`);
  console.log(`\nviews (${views.length}):`);
  views.forEach((v) => console.log(`  ${v.table_name}`));

  const idx = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_indexes
      WHERE schemaname='public' AND tablename <> 'spatial_ref_sys'`);
  console.log(`\nindexes: ${idx[0].n}`);

  const src = await query<{
    source_id: string; measurement_kind: string; staleness_seconds: number; requires_key: boolean;
  }>(`SELECT source_id, measurement_kind, staleness_seconds, requires_key
        FROM sources ORDER BY source_id`);
  console.log(`\nsources (${src.length}):`);
  src.forEach((s) => console.log(
    `  ${s.source_id.padEnd(20)} ${s.measurement_kind.padEnd(12)}` +
    ` stale=${String(s.staleness_seconds).padStart(5)}s key=${s.requires_key}`));

  const health = await query<{ source_id: string; freshness: string }>(
    `SELECT source_id, freshness FROM v_source_health ORDER BY source_id`);
  console.log('\nhealth view:');
  health.forEach((h) => console.log(`  ${h.source_id.padEnd(20)} ${h.freshness}`));

  // Exercise the geography type and confirm PostGIS maths is real.
  const geo = await query<{ km: string }>(
    `SELECT round((ST_Distance(
        ST_SetSRID(ST_MakePoint(-119.612,37.629),4326)::geography,
        ST_SetSRID(ST_MakePoint(-122.676,45.523),4326)::geography)/1000)::numeric,1)::text AS km`);
  console.log(`\nPostGIS check — Yosemite fire to Portland: ${geo[0].km} km`);

  const counts = await query<{ t: string; n: string }>(`
    SELECT 'fire_detections' AS t, count(*)::text AS n FROM fire_detections
    UNION ALL SELECT 'aq_measurements', count(*)::text FROM aq_measurements
    UNION ALL SELECT 'weather_hourly',  count(*)::text FROM weather_hourly
    UNION ALL SELECT 'alerts',          count(*)::text FROM alerts
    UNION ALL SELECT 'ingest_runs',     count(*)::text FROM ingest_runs
    ORDER BY t`);
  console.log('\nrow counts:');
  counts.forEach((c) => console.log(`  ${c.t.padEnd(18)} ${c.n}`));
}

main()
  .catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(closePool);
