/**
 * Tool-layer sanity check: npm run verify:tools
 *
 * Exercises all nine tools against the live database and asserts the
 * invariants the agent will depend on. Re-runnable at any time; useful after a
 * schema change, after a deploy, or when an answer looks wrong.
 *
 * It asserts BEHAVIOUR rather than row counts wherever possible, because the
 * data underneath changes every hour. Where a count is checked it is checked
 * as a relationship ("the envelope is populated", "ids are citable") rather
 * than as a fixed number that would rot within the day.
 */

import { config } from 'dotenv';

config({ path: '.env.local', quiet: true });
config({ quiet: true });

import { anthropicToolDefinitions, invokeTool, TOOL_NAMES } from '../lib/tools/registry';
import type { Envelope } from '../lib/tools/envelope';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function run(
  tool: string,
  input: Record<string, unknown>,
): Promise<Envelope<unknown> | null> {
  const started = Date.now();
  const outcome = await invokeTool(tool, input);
  if (!outcome.ok) {
    failed++;
    console.log(`  FAIL  ${tool} threw — ${outcome.failure.error}`);
    return null;
  }
  const ms = Date.now() - started;
  if (ms > 3000) {
    console.log(`  WARN  ${tool} took ${ms} ms (over the 3 s comfort threshold)`);
  }
  return outcome.result;
}

/** Every tool must return the full envelope, whether or not it found anything. */
function checkEnvelope(tool: string, env: Envelope<unknown>): void {
  const p = env.provenance;
  const q = env.quality;
  check(
    `${tool}: envelope shape`,
    Array.isArray(env.data) && Array.isArray(p.record_ids) &&
      typeof p.row_count === 'number' && typeof q.as_of === 'string' &&
      typeof q.known_as_of === 'string' && Array.isArray(q.caveats),
    `${p.row_count} rows, ${q.caveats.length} caveats`,
  );
  check(
    `${tool}: row_count matches data`,
    p.row_count === env.data.length,
  );
  // An empty array would read as "we checked and found none".
  check(
    `${tool}: uncomputed quality is null, not empty`,
    (q.gaps === null) === (q.gaps_computed === false) &&
      (q.conflicts === null) === (q.conflicts_computed === false),
  );
  check(
    `${tool}: sources named`,
    p.source_id.length > 0 && p.source_id.length === p.source_url.length,
    p.source_id.join(', '),
  );
}

async function main(): Promise<void> {
  const NOW = new Date();
  const iso = (d: Date) => d.toISOString();
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

  console.log('\n=== schema surface ===');
  const defs = anthropicToolDefinitions();
  check('nine tools registered', TOOL_NAMES.length === 9, TOOL_NAMES.join(', '));
  check('every tool yields a JSON Schema', defs.every((d) => d.input_schema && d.description));
  check(
    'every tool documents its parameters',
    defs.every((d) => {
      const props = (d.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
      return Object.keys(props).length > 0;
    }),
  );

  console.log('\n=== get_data_health ===');
  const health = await run('get_data_health', {});
  if (health) {
    checkEnvelope('get_data_health', health);
    check('all five sources reported', health.data.length === 5);
    const states = (health.data as { source_id: string; freshness: string }[])
      .map((d) => `${d.source_id}=${d.freshness}`);
    console.log(`        ${states.join('  ')}`);
  }

  console.log('\n=== resolve_place ===');
  const place = await run('resolve_place', { query: 'Portland' });
  if (place) {
    checkEnvelope('resolve_place', place);
    check('Portland resolves', place.data.length > 0);
  }
  const ambiguous = await run('resolve_place', { query: 'Vancouver', limit: 2 });
  if (ambiguous) {
    // The point of the tool: never pick silently between distant namesakes.
    check(
      'ambiguity is surfaced even below the row limit',
      ambiguous.quality.caveats.some((c) => c.includes('ambiguous')),
    );
  }
  const nowhere = await run('resolve_place', { query: 'Atlantis' });
  if (nowhere) {
    check('unresolvable place is an answer, not an error', nowhere.data.length === 0);
    check(
      'and says not to substitute a nearby place',
      nowhere.quality.caveats.some((c) => c.includes('Do not substitute')),
    );
  }

  console.log('\n=== get_air_quality ===');
  const aq = await run('get_air_quality', { from: iso(hoursAgo(168)), to: iso(NOW), limit: 800 });
  if (aq) {
    checkEnvelope('get_air_quality', aq);
    check('readings returned', aq.data.length > 0, `${aq.data.length} rows`);
    check('record ids are citable', aq.provenance.record_ids.length >= aq.data.length);
    check('conflicts computed', aq.quality.conflicts_computed === true,
      `${aq.quality.conflicts?.length ?? 0} found`);
    check('bitemporal cutoff applied on raw data', aq.quality.known_as_of_applied === true);
  }
  // The known extreme reading must carry its neighbour comparison.
  const extreme = await run('get_air_quality', {
    station_ids: ['openaq:26780'], from: '2026-09-21T00:00:00Z', to: '2026-09-21T23:59:59Z',
  });
  if (extreme) {
    const kinds = new Set((extreme.quality.conflicts ?? []).map((c) => c.kind));
    check('both conflict types fire on the 985 µg/m³ monitor',
      kinds.has('model_vs_observed') && kinds.has('sensor_vs_neighbours'),
      [...kinds].join(' + '));
  }
  const emptyRegion = await run('get_air_quality', {
    bbox: { min_lat: 58, max_lat: 59, min_lon: -127, max_lon: -126 },
  });
  if (emptyRegion) {
    check('empty region returns a populated envelope', emptyRegion.provenance.row_count === 0);
  }

  console.log('\n=== get_fires ===');
  const fires = await run('get_fires', { from: iso(hoursAgo(192)), to: iso(NOW), limit: 50 });
  if (fires) {
    checkEnvelope('get_fires', fires);
    check('clusters returned', fires.data.length > 0, `${fires.data.length} clusters`);
    check('every cluster is characterised',
      (fires.data as { source_character: string }[]).every((d) =>
        ['likely_wildfire', 'likely_industrial', 'indeterminate'].includes(d.source_character)));
    check('derived data reports the knowledge cutoff as unapplied',
      fires.quality.known_as_of_applied === false);
  }
  const evidence = await run('get_fires', {
    from: iso(hoursAgo(192)), to: iso(NOW), include_detections: true, limit: 1,
  });
  if (evidence) {
    check('evidence chain reaches individual detections',
      evidence.provenance.record_ids.some((r) => r.startsWith('fire_detection:')),
      `${evidence.provenance.record_ids.length} ids`);
  }

  console.log('\n=== get_wind ===');
  const wind = await run('get_wind', { from: iso(hoursAgo(12)), to: iso(NOW), limit: 100 });
  if (wind) {
    checkEnvelope('get_wind', wind);
    check('wind rows returned', wind.data.length > 0, `${wind.data.length} rows`);
  }
  const agg = await run('get_wind', { aggregate: true, from: iso(hoursAgo(6)), to: iso(NOW) });
  if (agg) {
    const dirs = (agg.data as { wind_dir_deg: number | null }[])
      .map((d) => d.wind_dir_deg).filter((d): d is number => d != null);
    check('vector-mean directions stay in range',
      dirs.every((d) => d >= 0 && d <= 360), `${dirs.length} hours`);
    check('aggregated rows are not passed off as citable records',
      (agg.data as { record_id: string | null }[]).every((d) => d.record_id === null));
  }

  console.log('\n=== get_alerts ===');
  const alerts = await run('get_alerts', { from: iso(hoursAgo(168)), to: iso(NOW), limit: 300 });
  if (alerts) {
    checkEnvelope('get_alerts', alerts);
    check('alerts returned', alerts.data.length > 0, `${alerts.data.length} alerts`);
    check('cancelled is distinguished from expired',
      (alerts.data as { cancelled: boolean }[]).some((d) => d.cancelled));
  }

  console.log('\n=== explain_smoke ===');
  const smoke = await run('explain_smoke', {
    from: iso(hoursAgo(168)), to: iso(NOW), limit: 150,
  });
  if (smoke) {
    checkEnvelope('explain_smoke', smoke);
    const rows = smoke.data as { explained: boolean; contributors: unknown[] }[];
    check('elevated station-hours found', rows.length > 0, `${rows.length} rows`);
    // The single most important behaviour in the system.
    check('"nothing explains this" is returned as a result',
      rows.some((d) => !d.explained),
      `${rows.filter((d) => !d.explained).length} unexplained of ${rows.length}`);
    check('explained rows carry their evidence',
      rows.filter((d) => d.explained).every((d) => d.contributors.length > 0));
    check('attributions are citable',
      smoke.provenance.record_ids.every((r) => r.startsWith('smoke_attribution:')));
  }

  console.log('\n=== rank_places ===');
  const rank = await run('rank_places', { limit: 10 });
  if (rank) {
    checkEnvelope('rank_places', rank);
    check('cells ranked', rank.data.length > 0, `${rank.data.length} cells`);
    check('station_count travels with every row',
      (rank.data as { station_count: number }[]).every((d) => typeof d.station_count === 'number'));
    check('unnamed cells are described rather than guessed at',
      (rank.data as { label: string | null; description: string }[])
        .every((d) => d.label !== null || d.description.includes('unnamed area')));
  }

  console.log('\n=== compare_time ===');
  const cmp = await run('compare_time', { from: iso(hoursAgo(48)), to: iso(hoursAgo(24)) });
  if (cmp) {
    checkEnvelope('compare_time', cmp);
    check('regional comparison returns one row', cmp.data.length === 1);
    const m = (cmp.data[0] as { metrics: Record<string, unknown> }).metrics;
    check('percentiles are compared, not only maxima',
      'pm25_p50' in m && 'pm25_p90' in m && 'pm25_worst_cell' in m);
  }
  const cells = await run('compare_time', {
    from: iso(hoursAgo(48)), to: iso(hoursAgo(24)), granularity: 'cell', limit: 50,
  });
  if (cells) {
    const rows = cells.data as {
      metrics: Record<string, { before: number | null; after: number | null; delta: number | null }>;
    }[];
    // Absence must never be rendered as a change to zero.
    check('a metric missing on one side yields a null delta, never a fabricated drop',
      rows.every((d) => {
        const v = d.metrics.pm25_obs_mean;
        return !(v.before == null || v.after == null) || v.delta === null;
      }));
  }

  console.log('\n=== input validation ===');
  const bad = await invokeTool('get_air_quality', { at: 'yesterday' });
  check('malformed timestamp is rejected', !bad.ok && bad.failure.kind === 'invalid_input');
  const both = await invokeTool('get_air_quality', { at: iso(NOW), from: iso(hoursAgo(2)) });
  check('at + from together is rejected rather than silently preferred',
    !both.ok && both.failure.kind === 'invalid_input');
  const unknown = await invokeTool('no_such_tool', {});
  check('unknown tool is reported', !unknown.ok && unknown.failure.kind === 'unknown_tool');
  const junk = await invokeTool('rank_places', { limit: 9999 });
  check('out-of-range input is rejected', !junk.ok && junk.failure.kind === 'invalid_input');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
