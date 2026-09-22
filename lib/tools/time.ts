/**
 * The two clocks, resolved in exactly one place.
 *
 * Decision 3a stores every observation against both `event_time` (when it
 * happened) and `ingest_time` (when we learned of it), which permits two
 * different replays. The tool surface exposes both, and this module is the
 * only thing that turns caller parameters into SQL predicates -- per-tool
 * interpretation is how two tools end up disagreeing about what "as of" meant.
 *
 * A correction recorded during Step 11 planning: the original design passed
 * the timeline scrub position as a single `as_of` meaning `ingest_time <=
 * as_of`. Measured against the live database, that returns ZERO rows beyond
 * about five hours back, because the entire seven-day history was backfilled
 * in one sitting -- so knowledge-time is only as deep as our collector is old.
 * Event-time spans roughly eight days of history plus two of forecast. The
 * scrub therefore rides on event time, and the knowledge cutoff is a separate,
 * optional parameter whose depth grows an hour per hour.
 */

export interface TimeParams {
  /** A single event-time instant, ISO 8601. Mutually exclusive with from/to. */
  at?: string;
  /** Event-time range start, ISO 8601. */
  from?: string;
  /** Event-time range end, ISO 8601. */
  to?: string;
  /**
   * Knowledge cutoff: exclude anything we had not ingested by this moment.
   * Defaults to now, i.e. best current knowledge.
   */
  known_as_of?: string;
}

export interface ResolvedTime {
  /** Inclusive event-time lower bound. */
  from: Date;
  /** Inclusive event-time upper bound; also the envelope's `as_of`. */
  to: Date;
  /** True when the caller asked for a point rather than a range. */
  instant: boolean;
  /** The instant the caller asked for, when `instant` is true. */
  at: Date | null;
  /** Knowledge cutoff applied as `ingest_time <= knownAsOf`. */
  knownAsOf: Date;
  /** False when `known_as_of` was defaulted rather than requested. */
  knownAsOfRequested: boolean;
}

export interface ResolveTimeOptions {
  /** Trailing window used when the caller gives no time at all. */
  defaultWindowHours: number;
  /** Half-width of the window derived from a bare `at`. */
  instantWindowHours?: number;
}

export class TimeParamError extends Error {}

function parse(label: string, value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new TimeParamError(`${label} is not a valid ISO 8601 timestamp: ${JSON.stringify(value)}`);
  }
  return d;
}

export function resolveTime(params: TimeParams, opts: ResolveTimeOptions): ResolvedTime {
  const hasAt = params.at != null;
  const hasRange = params.from != null || params.to != null;

  // Accepting both would mean silently preferring one, and the caller would
  // never learn which. An agent that asked for two different things should be
  // told, so it can ask again rather than cite a window it did not request.
  if (hasAt && hasRange) {
    throw new TimeParamError(
      'Pass either `at` (a single instant) or `from`/`to` (a range), not both.',
    );
  }

  const now = new Date();
  const knownAsOfRequested = params.known_as_of != null;
  const knownAsOf = knownAsOfRequested ? parse('known_as_of', params.known_as_of!) : now;

  const instantWindowMs = (opts.instantWindowHours ?? 1) * 3_600_000;

  let from: Date;
  let to: Date;
  let at: Date | null = null;

  if (hasAt) {
    at = parse('at', params.at!);
    from = new Date(at.getTime() - instantWindowMs);
    to = new Date(at.getTime() + instantWindowMs);
  } else if (hasRange) {
    to = params.to != null ? parse('to', params.to) : now;
    from =
      params.from != null
        ? parse('from', params.from)
        : new Date(to.getTime() - opts.defaultWindowHours * 3_600_000);
  } else {
    to = now;
    from = new Date(to.getTime() - opts.defaultWindowHours * 3_600_000);
  }

  if (from > to) {
    throw new TimeParamError(
      `\`from\` (${from.toISOString()}) is after \`to\` (${to.toISOString()}).`,
    );
  }

  return { from, to, instant: hasAt, at, knownAsOf, knownAsOfRequested };
}

/**
 * How much knowledge-time history exists is a property of when our collector
 * started, so a cutoff earlier than that returns nothing at all. Callers use
 * this to add a caveat rather than hand back a mysteriously empty result.
 */
export function knowledgeCutoffCaveat(
  knownAsOf: Date,
  earliestIngest: Date | null,
  requested: boolean,
): string | null {
  if (!requested || earliestIngest === null) return null;
  if (knownAsOf >= earliestIngest) return null;
  return (
    `The knowledge cutoff ${knownAsOf.toISOString()} predates our earliest ingest ` +
    `(${earliestIngest.toISOString()}), so nothing was known to us at that moment. ` +
    `Knowledge-time history begins when our collector started, not when the data was published.`
  );
}
