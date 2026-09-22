/**
 * get_data_health -- per-feed freshness, ingest history and known coverage.
 *
 * This is the tool that lets the agent distinguish "no fires were detected"
 * from "we failed to look". Decision 4g established that those are different
 * facts and that the health model must keep them apart, so the four freshness
 * states are surfaced verbatim rather than collapsed into a boolean.
 */

import { z } from 'zod';
import { buildEnvelope, recordId, type Envelope } from './envelope';
import { resolveTime } from './time';
import { sourceRegistry, tq } from './sql';
import type { ToolDefinition } from './types';

export const FRESHNESS_MEANING: Record<string, string> = {
  fresh: 'a scheduled run succeeded within the declared staleness threshold',
  stale: 'scheduled runs exist, but the most recent success is overdue',
  one_off: 'never ran on a schedule; maintenance history only, excluded from the rollup',
  not_scheduled: 'never ran on a schedule; maintenance history only, excluded from the rollup',
  never_succeeded: 'scheduled, but no successful run yet',
};

const inputSchema = z.object({
  known_as_of: z
    .string()
    .optional()
    .describe('ISO 8601 knowledge cutoff. Health is always reported as of now; this is recorded but not applied.'),
  source_id: z
    .string()
    .optional()
    .describe('Restrict to one source, e.g. "firms_viirs", "openaq", "nws_alerts".'),
});

export interface FeedVariantHealth {
  feed_variant: string | null;
  freshness: string;
  last_ok_at: string | null;
  last_attempt_at: string | null;
  last_status: string | null;
  cron_runs: number;
  error_runs: number;
  total_runs: number;
  rows_inserted_total: number;
}

export interface RosterCoverage {
  stations_known: number;
  stations_selected: number;
  stations_synthesized: number;
  selected_synthesized: number;
  cells_covered: number;
  selected_reference: number;
  selected_low_cost: number;
  selected_unknown_tier: number;
}

export interface SourceHealth {
  record_id: string;
  source_id: string;
  display_name: string;
  provider: string;
  measurement_kind: string;
  requires_key: boolean;
  cadence_seconds: number;
  staleness_seconds: number;
  freshness: string;
  freshness_meaning: string;
  seconds_since_ok: number | null;
  last_ok_at: string | null;
  /** Most recent success of ANY kind, including one-off maintenance runs. */
  last_ok_any_at: string | null;
  last_attempt_at: string | null;
  recurring_variants: number;
  one_off_variants: number;
  stale_variants: number;
  docs_url: string | null;
  variants: FeedVariantHealth[];
  /** Present on `openaq` only: the station roster the whole AQ layer rests on. */
  roster_coverage?: RosterCoverage;
}

interface HealthRow {
  source_id: string;
  display_name: string;
  provider: string;
  measurement_kind: string;
  cadence_seconds: number;
  staleness_seconds: number;
  requires_key: boolean;
  recurring_variants: string;
  one_off_variants: string;
  stale_variants: string;
  last_ok_at: string | null;
  last_ok_any_at: string | null;
  last_attempt_at: string | null;
  seconds_since_ok: string | null;
  freshness: string;
}

interface VariantRow {
  source_id: string;
  feed_variant: string | null;
  freshness: string;
  last_ok_at: string | null;
  last_attempt_at: string | null;
  last_status: string | null;
  cron_runs: string;
  error_runs: string;
  total_runs: string;
  rows_inserted_total: string | null;
}

const n = (v: string | null | undefined): number => (v == null ? 0 : Number(v));

async function handler(input: z.infer<typeof inputSchema>): Promise<Envelope<SourceHealth>> {
  const time = resolveTime({ known_as_of: input.known_as_of }, { defaultWindowHours: 1 });
  const only = input.source_id ?? null;

  // Three independent reads, overlapped rather than chained -- each is a
  // separate HTTP round trip on the serverless driver.
  const [health, variants, roster, reg] = await Promise.all([
    tq<HealthRow>(
      `SELECT source_id, display_name, provider, measurement_kind, cadence_seconds,
              staleness_seconds, requires_key, recurring_variants, one_off_variants,
              stale_variants, last_ok_at, last_ok_any_at, last_attempt_at,
              seconds_since_ok, freshness
         FROM v_source_health
        WHERE ($1::text IS NULL OR source_id = $1)
        ORDER BY source_id`,
      [only],
    ),
    tq<VariantRow>(
      `SELECT source_id, feed_variant, freshness, last_ok_at, last_attempt_at, last_status,
              cron_runs, error_runs, total_runs, rows_inserted_total
         FROM v_feed_variant_health
        WHERE ($1::text IS NULL OR source_id = $1)
        ORDER BY source_id, feed_variant`,
      [only],
    ),
    tq<Record<string, string>>(`SELECT * FROM v_roster_coverage`),
    sourceRegistry(),
  ]);

  const bySource = new Map<string, FeedVariantHealth[]>();
  for (const v of variants) {
    const list = bySource.get(v.source_id) ?? [];
    list.push({
      feed_variant: v.feed_variant,
      freshness: v.freshness,
      last_ok_at: v.last_ok_at,
      last_attempt_at: v.last_attempt_at,
      last_status: v.last_status,
      cron_runs: n(v.cron_runs),
      error_runs: n(v.error_runs),
      total_runs: n(v.total_runs),
      rows_inserted_total: n(v.rows_inserted_total),
    });
    bySource.set(v.source_id, list);
  }

  const r = roster[0];
  const rosterCoverage: RosterCoverage | undefined = r
    ? {
        stations_known: n(r.stations_known),
        stations_selected: n(r.stations_selected),
        stations_synthesized: n(r.stations_synthesized),
        selected_synthesized: n(r.selected_synthesized),
        cells_covered: n(r.cells_covered),
        selected_reference: n(r.selected_reference),
        selected_low_cost: n(r.selected_low_cost),
        selected_unknown_tier: n(r.selected_unknown_tier),
      }
    : undefined;

  const data: SourceHealth[] = health.map((h) => ({
    record_id: recordId('source', h.source_id),
    source_id: h.source_id,
    display_name: h.display_name,
    provider: h.provider,
    measurement_kind: h.measurement_kind,
    requires_key: h.requires_key,
    cadence_seconds: h.cadence_seconds,
    staleness_seconds: h.staleness_seconds,
    freshness: h.freshness,
    freshness_meaning: FRESHNESS_MEANING[h.freshness] ?? 'unrecognised freshness state',
    seconds_since_ok: h.seconds_since_ok == null ? null : Number(h.seconds_since_ok),
    last_ok_at: h.last_ok_at,
    last_ok_any_at: h.last_ok_any_at,
    last_attempt_at: h.last_attempt_at,
    recurring_variants: n(h.recurring_variants),
    one_off_variants: n(h.one_off_variants),
    stale_variants: n(h.stale_variants),
    docs_url: reg.get(h.source_id)?.docs_url ?? null,
    variants: bySource.get(h.source_id) ?? [],
    ...(h.source_id === 'openaq' && rosterCoverage ? { roster_coverage: rosterCoverage } : {}),
  }));

  const caveats: string[] = [
    'Freshness is measured over scheduled (cron) runs only. A source whose history is ' +
      'entirely one-off maintenance runs reports "not_scheduled", which means we have ' +
      'never polled it on a schedule -- a different fact from being overdue.',
    'A source is only as fresh as its weakest endpoint: the rollup is deliberately ' +
      'pessimistic, so one dead satellite feed makes the whole source stale.',
  ];
  if (rosterCoverage && rosterCoverage.selected_unknown_tier > 0) {
    caveats.push(
      `${rosterCoverage.selected_unknown_tier} of ${rosterCoverage.stations_selected} selected ` +
        'air-quality stations have instrument_tier "unknown" because they were synthesized ' +
        'from the measurement feed and carry no provider metadata.',
    );
  }

  return buildEnvelope<SourceHealth>({
    data,
    recordIds: data.map((d) => d.record_id),
    sources: data.map((d) => ({ source_id: d.source_id, source_url: d.docs_url })),
    // Health is a statement about now, so it has no event-time span of its own.
    eventTimes: [],
    ingestTimes: health.map((h) => h.last_ok_any_at),
    asOf: time.to,
    knownAsOf: time.knownAsOf,
    knownAsOfApplied: false,
    knownAsOfNote:
      'Health describes the current state of the pipeline. It is not replayable to a past ' +
      'knowledge cutoff, because ingest_runs records outcomes rather than revisions.',
    stalenessSeconds: null,
    gaps: null,
    conflicts: null,
    caveats,
  });
}

export const getDataHealth: ToolDefinition<typeof inputSchema, SourceHealth> = {
  name: 'get_data_health',
  description:
    'Per-feed freshness, ingest history and roster coverage for all five data sources. ' +
    'Use this to answer questions about whether the data is current, which feeds are ' +
    'stale or unscheduled, and how much of the station network is covered. Distinguishes ' +
    '"overdue" from "never scheduled" from "never succeeded" -- these are different facts.',
  inputSchema,
  handler,
};
