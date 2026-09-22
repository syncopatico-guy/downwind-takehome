/**
 * get_air_quality -- what was measured, what the model said, and where they
 * disagree.
 *
 * This is the tool the conflict story runs through. Decision 3 put model
 * estimates in a separate table from instrument readings precisely so they
 * could never be quietly averaged together, and this returns them side by side
 * with the disagreement made explicit rather than resolved.
 *
 * Two conflict axes ship, and they do different jobs. Model-versus-measurement
 * says two numbers disagree; it cannot say which is wrong, because CAMS is a
 * weak arbiter by our own measurement (42% high, r=0.118 over 112,917 paired
 * station-hours). Neighbour corroboration is a strong arbiter. Together they
 * separate "the model is biased" from "this sensor is broken" from "this is
 * real smoke" -- and only the third supports a confident claim.
 */

import { z } from 'zod';
import { buildEnvelope, recordId, type Conflict, type Envelope, type RecordId } from './envelope';
import { resolveTime, knowledgeCutoffCaveat, type TimeParams } from './time';
import { sourceRefs, stalenessFor, tq } from './sql';
import type { ToolDefinition } from './types';

/**
 * Measured thresholds, not chosen ones. Over 113,192 paired station-hours:
 * this rule fires on 10.6%. A 5 µg/m³ floor fires on 28% (too noisy to carry
 * meaning); a flat 15 µg/m³ absolute difference fires on 4.1%.
 */
const CONFLICT_RATIO = 2;
const CONFLICT_ABS_UG = 10;

/** A station reading this many times its neighbours' median is the outlier. */
const NEIGHBOUR_RATIO = 3;

/** `v_reading_corroboration` only covers readings at or above this value. */
const CORROBORATION_FLOOR = 100;

const bboxSchema = z.object({
  min_lat: z.number(), max_lat: z.number(),
  min_lon: z.number(), max_lon: z.number(),
});

const inputSchema = z.object({
  station_ids: z.array(z.string()).optional()
    .describe('Specific station ids, e.g. ["openaq:1194"].'),
  bbox: bboxSchema.optional()
    .describe('Bounding box, typically taken from resolve_place.'),
  parameter: z.enum(['pm25', 'pm10']).optional()
    .describe('Default pm25. PM10 reports at only ~20 of 239 sensors, so pm10 is often empty.'),
  at: z.string().optional().describe('ISO 8601 instant (event time).'),
  from: z.string().optional().describe('ISO 8601 range start (event time).'),
  to: z.string().optional().describe('ISO 8601 range end (event time).'),
  known_as_of: z.string().optional()
    .describe('ISO 8601 knowledge cutoff: ignore anything ingested after this.'),
  latest_only: z.boolean().optional()
    .describe('One row per station (the newest). Defaults true unless from/to is given.'),
  limit: z.number().int().min(1).max(2000).optional(),
});

export interface Corroboration {
  neighbours_reporting: number;
  neighbour_median_pm25: number | null;
  /** Reading divided by the neighbour median. Null when there are no neighbours. */
  ratio: number | null;
}

export interface AirQualityRow {
  record_id: RecordId;
  station_record_id: RecordId;
  model_record_id: RecordId | null;
  station_id: string;
  station_name: string | null;
  locality: string | null;
  provider: string | null;
  instrument_tier: string;
  /** 'locations_api' or 'bulk_feed_synthesized' -- synthesized rows have no tier. */
  metadata_source: string | null;
  lat: number;
  lon: number;
  parameter: string;
  event_time: string;
  ingest_time: string;
  observed_value: number | null;
  observed_unit: string | null;
  has_flags: boolean;
  source_url: string | null;
  modelled_pm25: number | null;
  modelled_us_aqi: number | null;
  model_event_time: string | null;
  /** Present only for readings at or above 100 µg/m³. */
  corroboration: Corroboration | null;
}

interface Raw {
  measurement_id: string; station_id: string; parameter: string;
  event_time: string; ingest_time: string; value: number | null; unit: string | null;
  has_flags: boolean; source_url: string | null;
  name: string | null; locality: string | null; provider: string | null;
  instrument_tier: string; metadata_source: string | null;
  lat: number; lon: number;
  model_aq_id: string | null; model_pm25: number | null; model_us_aqi: number | null;
  model_event_time: string | null;
}

const SQL = `
WITH bounds AS (
  SELECT $1::timestamptz AS t_from, $2::timestamptz AS t_to, $3::timestamptz AS known
),
stns AS (
  SELECT station_id, name, locality, provider, instrument_tier, lat, lon, metadata_source
    FROM aq_stations
   WHERE selected
     AND ($4::text[] IS NULL OR station_id = ANY($4))
     AND ($5::float8 IS NULL OR (lat BETWEEN $5 AND $6 AND lon BETWEEN $7 AND $8))
),
obs AS (
  -- DISTINCT ON ... ORDER BY ingest_time DESC is the bitemporal read: the
  -- LATEST value known as of the cutoff, not the first one we ever saw.
  -- Raw tables are append-only, so a corrected reading is a second row.
  SELECT DISTINCT ON (m.station_id, m.event_time)
         m.measurement_id, m.station_id, m.parameter, m.event_time, m.ingest_time,
         m.value, m.unit, m.has_flags, m.source_url
    FROM aq_measurements m
    JOIN stns s ON s.station_id = m.station_id
   CROSS JOIN bounds b
   WHERE m.parameter = $9
     AND m.event_time >= b.t_from AND m.event_time <= b.t_to
     AND m.ingest_time <= b.known
   ORDER BY m.station_id, m.event_time, m.ingest_time DESC
),
ranked AS (
  SELECT o.*, row_number() OVER (PARTITION BY o.station_id ORDER BY o.event_time DESC) AS rn
    FROM obs o
),
picked AS (
  -- Selection, ordering AND the limit all happen here, before the model join.
  -- They used to sit outside it, which let the LATERAL below run once per row
  -- in the whole window rather than once per returned row: a region-wide
  -- 7-day call evaluated ~113,000 lookups instead of 2,000 and took 10
  -- seconds. Same rows, same plan shape, two orders of magnitude less work.
  SELECT r.* FROM ranked r
   WHERE NOT $10::boolean OR r.rn = 1
   ORDER BY r.event_time DESC, r.station_id
   LIMIT $11
)
SELECT p.measurement_id, p.station_id, p.parameter, p.event_time, p.ingest_time,
       p.value, p.unit, p.has_flags, p.source_url,
       s.name, s.locality, s.provider, s.instrument_tier, s.metadata_source, s.lat, s.lon,
       mo.model_aq_id, mo.pm25 AS model_pm25, mo.us_aqi AS model_us_aqi,
       mo.event_time AS model_event_time
  FROM picked p
  JOIN stns s ON s.station_id = p.station_id
 CROSS JOIN bounds b
  LEFT JOIN LATERAL (
    -- Same bitemporal rule for the model side, and analysis only: a forecast
    -- is not an estimate of what was measured, it is a guess about later.
    SELECT m2.model_aq_id, m2.pm25, m2.us_aqi, m2.event_time
      FROM model_aq_hourly m2
     WHERE m2.point_id = 'stn:' || p.station_id
       AND m2.event_time = date_trunc('hour', p.event_time)
       AND NOT m2.is_forecast
       AND m2.ingest_time <= b.known
     ORDER BY m2.ingest_time DESC
     LIMIT 1
  ) mo ON true
 ORDER BY p.event_time DESC, p.station_id`;

/** Low-cost sensors report negatives and zeros; every ratio needs a floor. */
const safe = (v: number | null): number => Math.max(v ?? 0, 0);

async function handler(input: z.infer<typeof inputSchema>): Promise<Envelope<AirQualityRow>> {
  const params: TimeParams = {
    at: input.at, from: input.from, to: input.to, known_as_of: input.known_as_of,
  };
  // 24h rather than something tighter: live capture is currently ~2.6 readings
  // per station per day (see 4n), so a narrow default window would report
  // stations as silent when they are merely sparse.
  const time = resolveTime(params, { defaultWindowHours: 24, instantWindowHours: 1 });
  const latestOnly = input.latest_only ?? (input.from == null && input.to == null);
  const parameter = input.parameter ?? 'pm25';
  const bbox = input.bbox ?? null;

  const rows = await tq<Raw>(SQL, [
    time.from.toISOString(), time.to.toISOString(), time.knownAsOf.toISOString(),
    input.station_ids ?? null,
    bbox?.min_lat ?? null, bbox?.max_lat ?? null, bbox?.min_lon ?? null, bbox?.max_lon ?? null,
    parameter, latestOnly, input.limit ?? 500,
  ]);

  // Corroboration is only defined at or above 100 µg/m³, so it is fetched only
  // when something in the result qualifies -- most calls skip it entirely.
  const extreme = rows.filter((r) => (r.value ?? 0) >= CORROBORATION_FLOOR);
  const corrMap = new Map<string, Corroboration>();
  if (extreme.length > 0) {
    const corr = await tq<{
      station_id: string; event_time: string; value: number;
      neighbours_reporting: string; neighbour_median_pm25: string | null;
    }>(
      `SELECT station_id, event_time, value, neighbours_reporting, neighbour_median_pm25
         FROM v_reading_corroboration
        WHERE station_id = ANY($1::text[]) AND event_time = ANY($2::timestamptz[])`,
      [extreme.map((r) => r.station_id), extreme.map((r) => r.event_time)],
    );
    for (const c of corr) {
      const median = c.neighbour_median_pm25 == null ? null : Number(c.neighbour_median_pm25);
      corrMap.set(`${c.station_id}|${new Date(c.event_time).toISOString()}`, {
        neighbours_reporting: Number(c.neighbours_reporting),
        neighbour_median_pm25: median,
        ratio: median != null && median > 0 ? Number((c.value / median).toFixed(1)) : null,
      });
    }
  }

  const data: AirQualityRow[] = rows.map((r) => {
    const eventIso = new Date(r.event_time).toISOString();
    return {
      record_id: recordId('aq_measurement', r.measurement_id),
      station_record_id: recordId('aq_station', r.station_id),
      model_record_id: r.model_aq_id ? recordId('model_aq', r.model_aq_id) : null,
      station_id: r.station_id,
      station_name: r.name,
      locality: r.locality,
      provider: r.provider,
      instrument_tier: r.instrument_tier,
      metadata_source: r.metadata_source,
      lat: Number(r.lat),
      lon: Number(r.lon),
      parameter: r.parameter,
      event_time: eventIso,
      ingest_time: new Date(r.ingest_time).toISOString(),
      observed_value: r.value,
      observed_unit: r.unit,
      has_flags: r.has_flags,
      source_url: r.source_url,
      modelled_pm25: r.model_pm25,
      modelled_us_aqi: r.model_us_aqi,
      model_event_time: r.model_event_time ? new Date(r.model_event_time).toISOString() : null,
      corroboration: corrMap.get(`${r.station_id}|${eventIso}`) ?? null,
    };
  });

  // -- Conflicts -----------------------------------------------------------
  const conflicts: Conflict[] = [];

  for (const d of data) {
    if (d.observed_value != null && d.modelled_pm25 != null && d.parameter === 'pm25') {
      const obs = safe(d.observed_value);
      const mod = safe(d.modelled_pm25);
      const diff = Math.abs(mod - obs);
      const ratio = (Math.max(mod, obs) + 1) / (Math.min(mod, obs) + 1);
      if (ratio > CONFLICT_RATIO && diff > CONFLICT_ABS_UG) {
        conflicts.push({
          kind: 'model_vs_observed',
          record_id: d.record_id,
          station_id: d.station_id,
          event_time: d.event_time,
          detail:
            `Measured ${obs.toFixed(1)} µg/m³ at ${d.station_name ?? d.station_id}, ` +
            `modelled ${mod.toFixed(1)} µg/m³ for the same hour — ` +
            `${ratio.toFixed(1)}x apart. CAMS runs 42% high against sensors overall ` +
            `(r=0.118), so the model is the weaker witness here.`,
          values: {
            observed: Number(obs.toFixed(1)),
            modelled: Number(mod.toFixed(1)),
            ratio: Number(ratio.toFixed(2)),
            absolute_difference: Number(diff.toFixed(1)),
            model_record_id: d.model_record_id,
          },
        });
      }
    }

    const c = d.corroboration;
    if (c && c.ratio != null && c.ratio >= NEIGHBOUR_RATIO) {
      conflicts.push({
        kind: 'sensor_vs_neighbours',
        record_id: d.record_id,
        station_id: d.station_id,
        event_time: d.event_time,
        detail:
          `${d.station_name ?? d.station_id} reads ${d.observed_value} µg/m³ while ` +
          `${c.neighbours_reporting} station(s) within 25 km report a median of ` +
          `${c.neighbour_median_pm25} — a ${c.ratio}x outlier. A sensor fault or a very ` +
          `local source is more likely than regional smoke. Instrument tier is ` +
          `${d.instrument_tier}, which is not a guarantee either way.`,
        values: {
          value: d.observed_value,
          neighbours_reporting: c.neighbours_reporting,
          neighbour_median: c.neighbour_median_pm25,
          ratio: c.ratio,
          instrument_tier: d.instrument_tier,
        },
      });
    }
  }

  // -- Caveats -------------------------------------------------------------
  const caveats: string[] = [];
  const withModel = data.filter((d) => d.modelled_pm25 != null).length;
  if (withModel > 0) {
    caveats.push(
      'Modelled and measured values are never interchangeable. Across 112,917 paired ' +
        'station-hours CAMS averaged 42% higher than co-located sensors with a ' +
        'correlation of 0.118, so an answer resting on the model where no sensor exists ' +
        'is a materially weaker claim than one resting on a measurement.',
    );
  }
  const unknownTier = data.filter((d) => d.instrument_tier === 'unknown').length;
  if (unknownTier > 0) {
    caveats.push(
      `${unknownTier} of ${data.length} returned readings come from stations with ` +
        'instrument_tier "unknown" — synthesized from the measurement feed, so no ' +
        'provider or tier metadata exists for them. They are probably low-cost, but ' +
        '"probably" is not citable.',
    );
  }
  if (extreme.length > 0) {
    const uncorroborable = data.filter(
      (d) => d.corroboration != null && d.corroboration.neighbours_reporting === 0,
    ).length;
    caveats.push(
      `Neighbour corroboration is only computed for readings at or above ` +
        `${CORROBORATION_FLOOR} µg/m³; below that no comparison is made.` +
        (uncorroborable > 0
          ? ` ${uncorroborable} extreme reading(s) here have no neighbour within 25 km ` +
            'and cannot be corroborated at all — report that rather than implying either way.'
          : ''),
    );
  }
  if (data.some((d) => (d.observed_value ?? 0) <= 0)) {
    caveats.push(
      'Some readings are zero or negative. Low-cost sensors report both (1,339 negative ' +
        'and 9,040 zero values across the dataset); they are noise, not clean air.',
    );
  }
  if (parameter === 'pm10') {
    caveats.push(
      'PM10 reports at only ~20 of 239 equipped sensors, so PM10 coverage is specific to ' +
        'particular stations rather than general. Dust-versus-smoke discrimination via the ' +
        'PM10/PM2.5 ratio is available only where both are present.',
    );
  }
  const cutoffNote = knowledgeCutoffCaveat(time.knownAsOf, null, time.knownAsOfRequested);
  if (cutoffNote) caveats.push(cutoffNote);

  const recordIds = data.flatMap((d) =>
    [d.record_id, d.station_record_id, d.model_record_id].filter((x): x is RecordId => x !== null));

  return buildEnvelope<AirQualityRow>({
    data,
    recordIds,
    sources: await sourceRefs(
      withModel > 0 ? ['openaq', 'openmeteo_cams_aq'] : ['openaq'],
    ),
    eventTimes: data.map((d) => d.event_time),
    ingestTimes: data.map((d) => d.ingest_time),
    asOf: time.to,
    knownAsOf: time.knownAsOf,
    knownAsOfApplied: true,
    stalenessSeconds: await stalenessFor('openaq'),
    gaps: null,
    conflicts,
    caveats,
  });
}

export const getAirQuality: ToolDefinition<typeof inputSchema, AirQualityRow> = {
  name: 'get_air_quality',
  description:
    'Ground-sensor air quality readings with the co-located CAMS model estimate for the ' +
    'same hour, side by side. Flags where the two disagree, and where an extreme reading ' +
    'disagrees with its neighbours. Use for "what is the air quality in X", "how bad is ' +
    'it", or any question about measured pollution. Returns an empty result rather than ' +
    'an error when no station reported — that is an answer, not a failure.',
  inputSchema,
  handler,
};
