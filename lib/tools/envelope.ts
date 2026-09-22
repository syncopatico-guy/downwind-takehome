/**
 * The provenance envelope every tool returns.
 *
 * The brief asks for two things that are easy to say and hard to mean:
 * following evidence to its source, and clear treatment of stale, missing or
 * conflicting data. Both live here rather than in each tool, so a tool cannot
 * quietly ship without them.
 *
 * The rule that matters most: an empty array is a claim. `gaps: []` reads as
 * "we checked and there are none", so anything we have not computed is `null`
 * with its `*_computed` flag false. The agent can then say "not assessed"
 * instead of "none found", which are different facts.
 */

/** A record id the agent may cite, shaped `<entity>:<primary key>`. */
export type RecordId = string;

export interface Provenance {
  /** Upstream sources that contributed rows, by `sources.source_id`. */
  source_id: string[];
  /** Upstream URLs, one per source_id, in the same order. */
  source_url: (string | null)[];
  /** Every row returned, citable individually. Step 12 validates claims against this. */
  record_ids: RecordId[];
  /** Span of `event_time` across the returned rows -- when the phenomena happened. */
  event_time_range: { start: string; end: string } | null;
  /** Span of `ingest_time` across the returned rows -- when we learned of them. */
  ingest_time: { earliest: string; latest: string } | null;
  row_count: number;
}

export interface Gap {
  start: string;
  end: string;
  reason: string;
}

export type ConflictKind = 'model_vs_observed' | 'sensor_vs_neighbours';

export interface Conflict {
  kind: ConflictKind;
  /** The record the conflict is about, so the agent can cite the disputed row. */
  record_id: RecordId | null;
  station_id?: string;
  event_time?: string;
  /** Human-readable statement of the disagreement. Never a verdict. */
  detail: string;
  /** The numbers behind `detail`, so the agent quotes rather than recomputes. */
  values: Record<string, number | string | null>;
}

export interface Quality {
  /** Effective event-time upper bound actually used. */
  as_of: string;
  /** Effective knowledge cutoff: rows with `ingest_time` after this were excluded. */
  known_as_of: string;
  /**
   * False when the data cannot honour a knowledge cutoff at all -- the derived
   * tables (fire_clusters, smoke_attributions, hourly_frames) carry a single
   * `computed_at` and no `ingest_time`, so "what we knew at T" is unanswerable
   * over them. Reporting that beats silently ignoring the parameter.
   */
  known_as_of_applied: boolean;
  known_as_of_note: string | null;
  /** Seconds between the newest returned `event_time` and now. */
  age_seconds: number | null;
  /** Measured against the feed's declared `sources.staleness_seconds`. */
  is_stale: boolean | null;
  gaps: Gap[] | null;
  gaps_computed: boolean;
  conflicts: Conflict[] | null;
  conflicts_computed: boolean;
  /**
   * Standing limitations that apply to this result, phrased for the agent to
   * quote. These are measured facts about the data, not hedging.
   */
  caveats: string[];
}

export interface Envelope<T> {
  data: T[];
  provenance: Provenance;
  quality: Quality;
}

// ---------------------------------------------------------------------------
// Record ids
// ---------------------------------------------------------------------------

/** Entities that can be cited. The prefix is part of the citation contract. */
export const RECORD_PREFIX = {
  fire_detection: 'fire_detection',
  fire_cluster: 'fire_cluster',
  aq_measurement: 'aq_measurement',
  aq_station: 'aq_station',
  weather: 'weather',
  model_aq: 'model_aq',
  alert: 'alert',
  nws_zone: 'nws_zone',
  smoke_attribution: 'smoke_attribution',
  frame: 'frame',
  source: 'source',
  ingest_run: 'ingest_run',
  place: 'place',
} as const;

export type RecordPrefix = (typeof RECORD_PREFIX)[keyof typeof RECORD_PREFIX];

export function recordId(prefix: RecordPrefix, ...parts: (string | number)[]): RecordId {
  return `${prefix}:${parts.join(':')}`;
}

// ---------------------------------------------------------------------------
// Assembling the envelope
// ---------------------------------------------------------------------------

export interface BuildEnvelopeInput<T> {
  data: T[];
  recordIds: RecordId[];
  sources: { source_id: string; source_url: string | null }[];
  /** Event times of the returned rows, for the range and the age calculation. */
  eventTimes?: (Date | string | null | undefined)[];
  ingestTimes?: (Date | string | null | undefined)[];
  asOf: Date;
  knownAsOf: Date;
  knownAsOfApplied?: boolean;
  knownAsOfNote?: string | null;
  /** Declared staleness budget of the primary feed, in seconds. */
  stalenessSeconds?: number | null;
  gaps?: Gap[] | null;
  conflicts?: Conflict[] | null;
  caveats?: string[];
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function span(values: (Date | string | null | undefined)[] | undefined) {
  if (!values || values.length === 0) return null;
  const times = values
    .map(toIso)
    .filter((v): v is string => v !== null)
    .sort();
  if (times.length === 0) return null;
  return { start: times[0], end: times[times.length - 1] };
}

export function buildEnvelope<T>(input: BuildEnvelopeInput<T>): Envelope<T> {
  const eventRange = span(input.eventTimes);
  const ingestRange = span(input.ingestTimes);

  // Age is measured from the newest event we hold, not from the newest row we
  // wrote: a run that succeeds while the upstream feed is frozen is fresh by
  // ingest and stale by observation, and the second is the honest one.
  const newestEvent = eventRange ? new Date(eventRange.end) : null;
  const ageSeconds = newestEvent
    ? Math.max(0, Math.round((Date.now() - newestEvent.getTime()) / 1000))
    : null;

  const staleness = input.stalenessSeconds ?? null;
  const isStale = ageSeconds === null || staleness === null ? null : ageSeconds > staleness;

  return {
    data: input.data,
    provenance: {
      source_id: input.sources.map((s) => s.source_id),
      source_url: input.sources.map((s) => s.source_url),
      record_ids: input.recordIds,
      event_time_range: eventRange,
      ingest_time: ingestRange ? { earliest: ingestRange.start, latest: ingestRange.end } : null,
      row_count: input.data.length,
    },
    quality: {
      as_of: input.asOf.toISOString(),
      known_as_of: input.knownAsOf.toISOString(),
      known_as_of_applied: input.knownAsOfApplied ?? true,
      known_as_of_note: input.knownAsOfNote ?? null,
      age_seconds: ageSeconds,
      is_stale: isStale,
      gaps: input.gaps ?? null,
      gaps_computed: input.gaps !== undefined && input.gaps !== null,
      conflicts: input.conflicts ?? null,
      conflicts_computed: input.conflicts !== undefined && input.conflicts !== null,
      caveats: input.caveats ?? [],
    },
  };
}

/**
 * The note attached whenever a knowledge cutoff is requested over derived data.
 * Measured, not assumed: fire_clusters, smoke_attributions and hourly_frames
 * each hold exactly one distinct `computed_at` value, because each is recomputed
 * wholesale rather than accumulated.
 */
export function derivedKnowledgeNote(table: string, computedAt: Date | string | null): string {
  const at = toIso(computedAt);
  return (
    `${table} is a derived table with no ingest_time: it is recomputed wholesale, ` +
    `so a knowledge cutoff cannot be applied to it` +
    (at ? `. The statistics returned were computed at ${at}.` : '.')
  );
}
