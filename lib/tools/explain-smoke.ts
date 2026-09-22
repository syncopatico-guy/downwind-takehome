/**
 * explain_smoke -- the system's one causal claim, framed as a hypothesis.
 *
 * Everything else here reports what was observed. This asserts that a
 * particular fire plausibly explains a particular reading, which is a
 * modelling claim rather than a measurement, so every row travels with the
 * numbers that produced it: distance, wind alignment, travel time, the fire's
 * intensity at the hour the smoke would have departed, and the mixing depth.
 * The agent shows its work instead of being trusted.
 *
 * The most important thing this tool returns is sometimes NOTHING. Measured,
 * only 20.9% of elevated station-hours (1,015 of 4,858) have a plausible
 * upwind fire. The other 79% are traffic, industry, dust, cooking or a sensor
 * fault -- and a system that attributed every elevated reading to wildfire
 * smoke would be wrong most of the time. So unexplained station-hours are
 * returned as first-class rows with `explained: false`, using the SAME trigger
 * the attribution engine uses, rather than being silently absent.
 */

import { z } from 'zod';
import {
  buildEnvelope, derivedKnowledgeNote, recordId,
  type Envelope, type RecordId,
} from './envelope';
import { resolveTime, type TimeParams } from './time';
import { sourceRefs, tq } from './sql';
import type { ToolDefinition } from './types';

/**
 * These MUST match `scripts/attribute-smoke.ts`. If they drift, "unexplained"
 * would be computed against a different population than "explained", and the
 * 20.9% figure would stop meaning anything.
 */
const RATIO_TRIGGER = 2;
const FLOOR_TRIGGER_UG = 8;
const BASELINE_DAYS = 8;

/**
 * Below this, "N times baseline" stops meaning much. Measured: 145 of 1,099
 * stations carry an 8-day median under 2 µg/m³, and the 64 attributions
 * resting on one average a 16.4x ratio against 3.6x for the rest -- while
 * their absolute readings are LOWER (12.1 against 19.1 µg/m³). The ratio
 * flatters them, so it is flagged rather than quietly reported.
 */
const LOW_BASELINE_UG = 2;

const bboxSchema = z.object({
  min_lat: z.number(), max_lat: z.number(),
  min_lon: z.number(), max_lon: z.number(),
});

const inputSchema = z.object({
  station_ids: z.array(z.string()).optional().describe('Specific stations to explain.'),
  bbox: bboxSchema.optional().describe('Bounding box, typically from resolve_place.'),
  at: z.string().optional().describe('ISO 8601 instant (event time).'),
  from: z.string().optional().describe('ISO 8601 range start (event time).'),
  to: z.string().optional().describe('ISO 8601 range end (event time).'),
  known_as_of: z.string().optional()
    .describe('Recorded but NOT applied: attributions are derived and carry no ingest_time.'),
  min_score: z.number().optional().describe('Drop contributing fires scoring below this.'),
  include_unexplained: z.boolean().optional()
    .describe('Include elevated readings with NO attributable fire. Default true — these are 79% of cases and are a real answer.'),
  limit: z.number().int().min(1).max(500).optional(),
});

export interface Contributor {
  record_id: RecordId;
  cluster_record_id: RecordId;
  cluster_key: string;
  cluster_label: string | null;
  source_character: string;
  score: number;
  distance_km: number;
  /** Direction smoke must travel from fire to station, degrees clockwise from north. */
  bearing_deg: number | null;
  wind_dir_deg: number | null;
  wind_speed_kmh: number | null;
  /** Angle between where the wind came from and where the fire is. Smaller is stronger. */
  alignment_deg: number | null;
  travel_hours: number | null;
  /** Fire intensity at the hour the smoke would have departed, not on arrival. */
  frp_at_lag: number | null;
  pbl_height_m: number | null;
  alignment_factor: number | null;
  distance_factor: number | null;
  frp_factor: number | null;
  pbl_factor: number | null;
}

export interface SmokeExplanation {
  station_id: string;
  station_name: string | null;
  lat: number | null;
  lon: number | null;
  event_time: string;
  observed_pm25: number;
  baseline_pm25: number | null;
  ratio_to_baseline: number | null;
  /** False means: this reading is elevated and no upwind fire explains it. */
  explained: boolean;
  /** True when every contributing source is industrial. Never call this wildfire smoke. */
  all_industrial: boolean;
  /** The station's own median is so low that ratio_to_baseline overstates the event. */
  baseline_is_low: boolean;
  candidate_count: number;
  top_score: number | null;
  total_score: number | null;
  method_version: string | null;
  contributors: Contributor[];
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** Elevated station-hours, by the attribution engine's own definition. */
const SQL_ELEVATED = `
WITH stns AS (
  -- Scoping the station set FIRST matters: the baseline is a percentile over
  -- every reading a station has, and computing it for all 1,099 stations when
  -- the caller asked about one city cost 2.4 s for nothing.
  SELECT station_id, name, lat, lon FROM aq_stations
   WHERE selected
     AND ($6::text[] IS NULL OR station_id = ANY($6))
     AND ($7::float8 IS NULL OR (lat BETWEEN $7 AND $8 AND lon BETWEEN $9 AND $10))
), baseline AS (
  SELECT m.station_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY m.value) AS med
    FROM aq_measurements m
    JOIN stns ON stns.station_id = m.station_id
   WHERE m.parameter = 'pm25' AND m.event_time > now() - ($1 || ' days')::interval
   GROUP BY m.station_id
), latest AS (
  SELECT DISTINCT ON (m.station_id, m.event_time) m.station_id, m.event_time, m.value
    FROM aq_measurements m
    JOIN stns ON stns.station_id = m.station_id
   WHERE m.parameter = 'pm25'
     AND m.event_time >= $2::timestamptz AND m.event_time <= $3::timestamptz
   ORDER BY m.station_id, m.event_time, m.ingest_time DESC
)
SELECT l.station_id, l.event_time, l.value AS observed_pm25, b.med AS baseline_pm25,
       s.name AS station_name, s.lat, s.lon
  FROM latest l
  JOIN baseline b ON b.station_id = l.station_id
  JOIN stns s ON s.station_id = l.station_id
 WHERE b.med > 0
   AND l.value >= $4 * b.med
   AND l.value >= $5
 -- Ordered by the absolute reading, not the ratio. Ordering by ratio put
 -- near-zero-baseline stations at the top, where a 12 µg/m³ reading outranked
 -- a 900 µg/m³ one purely because its median was 0.3.
 ORDER BY l.value DESC
 LIMIT $11`;

/** Contributing fires for a set of station-hours, with their full evidence. */
const SQL_CONTRIBUTORS = `
SELECT a.attribution_id, a.station_id, a.event_time, a.cluster_id,
       c.cluster_key, c.label AS cluster_label, a.source_character,
       a.score, a.distance_km, a.bearing_deg, a.wind_dir_deg, a.wind_speed_kmh,
       a.alignment_deg, a.travel_hours, a.frp_at_lag, a.pbl_height_m,
       a.alignment_factor, a.distance_factor, a.frp_factor, a.pbl_factor,
       a.method_version, a.computed_at
  FROM smoke_attributions a
  JOIN fire_clusters c ON c.cluster_id = a.cluster_id
 WHERE a.station_id = ANY($1::text[])
   AND a.event_time >= $2::timestamptz AND a.event_time <= $3::timestamptz
   AND ($4::float8 IS NULL OR a.score >= $4)
 ORDER BY a.station_id, a.event_time, a.score DESC`;

async function handler(input: z.infer<typeof inputSchema>): Promise<Envelope<SmokeExplanation>> {
  const params: TimeParams = {
    at: input.at, from: input.from, to: input.to, known_as_of: input.known_as_of,
  };
  const time = resolveTime(params, { defaultWindowHours: 24, instantWindowHours: 2 });
  const bbox = input.bbox ?? null;
  const includeUnexplained = input.include_unexplained ?? true;
  const limit = input.limit ?? 100;

  const elevated = await tq<Record<string, unknown>>(SQL_ELEVATED, [
    BASELINE_DAYS, time.from.toISOString(), time.to.toISOString(),
    RATIO_TRIGGER, FLOOR_TRIGGER_UG,
    input.station_ids ?? null,
    bbox?.min_lat ?? null, bbox?.max_lat ?? null, bbox?.min_lon ?? null, bbox?.max_lon ?? null,
    limit,
  ]);

  const contributorsByKey = new Map<string, Contributor[]>();
  const meta = new Map<string, { method_version: string; computed_at: string }>();
  const attributionIds: RecordId[] = [];

  if (elevated.length > 0) {
    const rows = await tq<Record<string, unknown>>(SQL_CONTRIBUTORS, [
      [...new Set(elevated.map((e) => e.station_id as string))],
      time.from.toISOString(), time.to.toISOString(),
      input.min_score ?? null,
    ]);
    for (const r of rows) {
      const key = `${r.station_id}|${new Date(r.event_time as string).toISOString()}`;
      const id = recordId('smoke_attribution', r.attribution_id as string);
      attributionIds.push(id);
      const list = contributorsByKey.get(key) ?? [];
      list.push({
        record_id: id,
        cluster_record_id: recordId('fire_cluster', r.cluster_id as string),
        cluster_key: r.cluster_key as string,
        cluster_label: (r.cluster_label as string) ?? null,
        source_character: r.source_character as string,
        score: Number(Number(r.score).toFixed(4)),
        distance_km: Number(Number(r.distance_km).toFixed(1)),
        bearing_deg: num(r.bearing_deg), wind_dir_deg: num(r.wind_dir_deg),
        wind_speed_kmh: num(r.wind_speed_kmh), alignment_deg: num(r.alignment_deg),
        travel_hours: num(r.travel_hours), frp_at_lag: num(r.frp_at_lag),
        pbl_height_m: num(r.pbl_height_m),
        alignment_factor: num(r.alignment_factor), distance_factor: num(r.distance_factor),
        frp_factor: num(r.frp_factor), pbl_factor: num(r.pbl_factor),
      });
      contributorsByKey.set(key, list);
      meta.set(key, {
        method_version: r.method_version as string,
        computed_at: r.computed_at as string,
      });
    }
  }

  let data: SmokeExplanation[] = elevated.map((e) => {
    const eventIso = new Date(e.event_time as string).toISOString();
    const key = `${e.station_id}|${eventIso}`;
    const contributors = contributorsByKey.get(key) ?? [];
    const observed = Number(e.observed_pm25);
    const baseline = num(e.baseline_pm25);
    return {
      station_id: e.station_id as string,
      station_name: (e.station_name as string) ?? null,
      lat: num(e.lat), lon: num(e.lon),
      event_time: eventIso,
      observed_pm25: Number(observed.toFixed(2)),
      baseline_pm25: baseline == null ? null : Number(baseline.toFixed(2)),
      ratio_to_baseline:
        baseline && baseline > 0 ? Number((observed / baseline).toFixed(2)) : null,
      explained: contributors.length > 0,
      all_industrial:
        contributors.length > 0 &&
        contributors.every((c) => c.source_character === 'likely_industrial'),
      baseline_is_low: baseline != null && baseline < LOW_BASELINE_UG,
      candidate_count: contributors.length,
      top_score: contributors.length > 0 ? contributors[0].score : null,
      total_score: contributors.length > 0
        ? Number(contributors.reduce((a, c) => a + c.score, 0).toFixed(4)) : null,
      method_version: meta.get(key)?.method_version ?? null,
      contributors,
    };
  });

  if (!includeUnexplained) data = data.filter((d) => d.explained);

  // -- Caveats -------------------------------------------------------------
  const explained = data.filter((d) => d.explained).length;
  const unexplained = data.length - explained;
  const industrialOnly = data.filter((d) => d.all_industrial).length;

  const caveats: string[] = [
    'Attribution is a HYPOTHESIS carrying its evidence, never an established fact. It ' +
      'looks upwind along the modelled wind vector and weights candidate fires by ' +
      'intensity, distance and alignment. It is not a dispersion model and does not ' +
      'measure smoke.',
    `An "elevated" reading means PM2.5 at ${RATIO_TRIGGER}x the station's own ` +
      `${BASELINE_DAYS}-day median AND at least ${FLOOR_TRIGGER_UG} µg/m³. The ratio is ` +
      'relative to the station because low-cost sensors carry different offsets; the ' +
      'floor stops a 1 to 2.5 µg/m³ rise counting as an event.',
  ];

  const lowBaseline = data.filter((d) => d.baseline_is_low).length;
  if (lowBaseline > 0) {
    caveats.push(
      `${lowBaseline} of ${data.length} rows come from stations whose own 8-day median is ` +
        `below ${LOW_BASELINE_UG} µg/m³, so ratio_to_baseline overstates them — a reading ` +
        'of 20 µg/m³ against a 0.5 µg/m³ median reports as 40x. Lead with the absolute ' +
        'value for these, not the multiple. Measured across all attributions, ' +
        'low-baseline rows average a 16.4x ratio against 3.6x for the rest while their ' +
        'absolute readings are lower (12.1 against 19.1 µg/m³).',
    );
  }
  if (unexplained > 0) {
    caveats.push(
      `${unexplained} of ${data.length} elevated station-hours here have NO attributable ` +
        'fire. That is the expected and correct outcome, not a coverage failure — across ' +
        'the dataset only 20.9% of elevated station-hours (1,015 of 4,858) have a ' +
        'plausible upwind fire. Urban PM2.5 comes from traffic, industry, dust and ' +
        'cooking. Say that nothing explains the reading rather than reaching for the ' +
        'nearest fire.',
    );
  }
  if (industrialOnly > 0) {
    caveats.push(
      `${industrialOnly} station-hour(s) are explained ONLY by industrial sources — ` +
        'refineries, gas flares and similar. These must not be described as wildfire ' +
        'smoke. The elevated reading is real and the source is real; it is simply not a ' +
        'wildfire.',
    );
  }
  if (explained > 0) {
    caveats.push(
      'Travel time is a single-step back-trajectory: the lag is estimated from wind speed ' +
        'at the arrival hour, then fire intensity and wind direction are read at the ' +
        'resulting earlier hour. frp_at_lag is therefore the fire\'s intensity when the ' +
        'smoke would have left, not on arrival.',
      'The pbl_factor is close to its 2.5 cap in most rows because the regional median ' +
        'mixing depth is about 340 m. It discriminates mainly by EXCLUDING deep-mixing ' +
        'afternoons rather than by grading, so it looks more decisive than it is.',
      'alignment_deg is the useful number: 2° is a far stronger claim than 40°, and both ' +
        'would otherwise read simply as "downwind".',
    );
  }

  const computedAt = [...meta.values()][0]?.computed_at ?? null;

  return buildEnvelope<SmokeExplanation>({
    data,
    recordIds: attributionIds,
    // Attribution joins three feeds; naming one would understate the claim.
    sources: await sourceRefs(['openaq', 'firms_viirs', 'openmeteo_wind']),
    eventTimes: data.map((d) => d.event_time),
    ingestTimes: [],
    asOf: time.to,
    knownAsOf: time.knownAsOf,
    knownAsOfApplied: false,
    knownAsOfNote: time.knownAsOfRequested
      ? derivedKnowledgeNote('smoke_attributions', computedAt)
      : null,
    stalenessSeconds: null,
    gaps: null,
    conflicts: null,
    caveats,
  });
}

export const explainSmoke: ToolDefinition<typeof inputSchema, SmokeExplanation> = {
  name: 'explain_smoke',
  description:
    'For elevated air-quality readings, which fires plausibly explain them — with the ' +
    'full evidence for each: distance, wind alignment, travel time, fire intensity at ' +
    'departure and mixing depth. Use for "why is the air bad here", "which fire is ' +
    'responsible", "is this smoke from X". Returns elevated readings that NOTHING ' +
    'explains as first-class results, which is the majority case (79%) and a real answer. ' +
    'Check all_industrial before describing anything as wildfire smoke.',
  inputSchema,
  handler,
};
