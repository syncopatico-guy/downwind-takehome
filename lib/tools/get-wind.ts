/**
 * get_wind -- the transport half of the question.
 *
 * Wind is what turns a fire into somebody else's air quality problem, so this
 * tool feeds attribution reasoning as much as it answers direct questions.
 *
 * Two things it refuses to do quietly. It never averages wind direction
 * arithmetically -- 350 degrees and 10 degrees average to 180, the exact
 * opposite -- so aggregation uses a vector mean throughout. And it never mixes
 * forecast rows with analysis: a forecast is a claim about what will happen,
 * an analysis is a claim about what did, and collapsing them would destroy the
 * "what we expected versus what happened" comparison that Decision 3q exists
 * to support.
 */

import { z } from 'zod';
import { buildEnvelope, recordId, type Envelope, type RecordId } from './envelope';
import { resolveTime, type TimeParams } from './time';
import { sourceRefs, stalenessFor, tq } from './sql';
import type { ToolDefinition } from './types';

const bboxSchema = z.object({
  min_lat: z.number(), max_lat: z.number(),
  min_lon: z.number(), max_lon: z.number(),
});

const inputSchema = z.object({
  bbox: bboxSchema.optional().describe('Bounding box, typically from resolve_place.'),
  point_ids: z.array(z.string()).optional()
    .describe('Sample point ids, e.g. ["stn:openaq:1194", "fire:...", "grid:..."].'),
  at: z.string().optional().describe('ISO 8601 instant (event time).'),
  from: z.string().optional().describe('ISO 8601 range start (event time).'),
  to: z.string().optional().describe('ISO 8601 range end (event time).'),
  known_as_of: z.string().optional().describe('ISO 8601 knowledge cutoff.'),
  include_forecast: z.boolean().optional()
    .describe('Include forecast hours. They are returned as separate rows flagged is_forecast, never merged with analysis.'),
  aggregate: z.boolean().optional()
    .describe('One row per hour, averaged across points using a VECTOR mean for direction. Default false (one row per point-hour).'),
  limit: z.number().int().min(1).max(2000).optional(),
});

export interface WindRow {
  record_id: RecordId | null;
  point_id: string | null;
  lat: number | null;
  lon: number | null;
  event_time: string;
  ingest_time: string | null;
  is_forecast: boolean;
  wind_dir_deg: number | null;
  /** Plain-language bearing, e.g. "NW". Direction the wind blows FROM. */
  wind_dir_cardinal: string | null;
  wind_speed_kmh: number | null;
  wind_gust_kmh: number | null;
  temp_c: number | null;
  rh_pct: number | null;
  /** Mixing depth. Shallow values trap smoke at the surface. */
  pbl_height_m: number | null;
  /** Only on aggregated rows: how many points contributed. */
  points_averaged?: number;
}

const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                   'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function cardinal(deg: number | null): string | null {
  if (deg == null) return null;
  return CARDINALS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/** Per point-hour, latest known as of the cutoff. */
const SQL_POINTS = `
WITH bounds AS (
  SELECT $1::timestamptz AS t_from, $2::timestamptz AS t_to, $3::timestamptz AS known
),
pts AS (
  SELECT point_id, lat, lon FROM sample_points
   WHERE active
     AND ($4::text[] IS NULL OR point_id = ANY($4))
     AND ($5::float8 IS NULL OR (lat BETWEEN $5 AND $6 AND lon BETWEEN $7 AND $8))
),
w AS (
  SELECT DISTINCT ON (h.point_id, h.event_time, h.is_forecast)
         h.weather_id, h.point_id, h.event_time, h.ingest_time, h.is_forecast,
         h.wind_dir_deg, h.wind_speed_kmh, h.wind_gust_kmh, h.temp_c, h.rh_pct, h.pbl_height_m
    FROM weather_hourly h
    JOIN pts p ON p.point_id = h.point_id
   CROSS JOIN bounds b
   WHERE h.event_time >= b.t_from AND h.event_time <= b.t_to
     AND h.ingest_time <= b.known
     AND ($9::boolean OR NOT h.is_forecast)
   ORDER BY h.point_id, h.event_time, h.is_forecast, h.ingest_time DESC
)
SELECT w.*, p.lat, p.lon
  FROM w JOIN pts p ON p.point_id = w.point_id
 ORDER BY w.event_time DESC, w.point_id
 LIMIT $10`;

/**
 * Aggregated per hour. The direction is a vector mean: atan2 of the mean sine
 * and mean cosine. Averaging the degrees themselves would produce plausible
 * numbers that are systematically wrong, and attribution depends on direction.
 */
const SQL_AGG = `
WITH bounds AS (
  SELECT $1::timestamptz AS t_from, $2::timestamptz AS t_to, $3::timestamptz AS known
),
pts AS (
  SELECT point_id FROM sample_points
   WHERE active
     AND ($4::text[] IS NULL OR point_id = ANY($4))
     AND ($5::float8 IS NULL OR (lat BETWEEN $5 AND $6 AND lon BETWEEN $7 AND $8))
),
w AS (
  SELECT DISTINCT ON (h.point_id, h.event_time, h.is_forecast)
         h.point_id, h.event_time, h.ingest_time, h.is_forecast,
         h.wind_dir_deg, h.wind_speed_kmh, h.wind_gust_kmh, h.temp_c, h.rh_pct, h.pbl_height_m
    FROM weather_hourly h
    JOIN pts p ON p.point_id = h.point_id
   CROSS JOIN bounds b
   WHERE h.event_time >= b.t_from AND h.event_time <= b.t_to
     AND h.ingest_time <= b.known
     AND ($9::boolean OR NOT h.is_forecast)
   ORDER BY h.point_id, h.event_time, h.is_forecast, h.ingest_time DESC
)
SELECT event_time, is_forecast, max(ingest_time) AS ingest_time,
       count(*) AS points_averaged,
       mod(degrees(atan2(avg(sin(radians(wind_dir_deg))),
                         avg(cos(radians(wind_dir_deg)))))::numeric + 360, 360) AS wind_dir_deg,
       avg(wind_speed_kmh) AS wind_speed_kmh,
       avg(wind_gust_kmh)  AS wind_gust_kmh,
       avg(temp_c)         AS temp_c,
       avg(rh_pct)         AS rh_pct,
       avg(pbl_height_m)   AS pbl_height_m
  FROM w
 WHERE wind_dir_deg IS NOT NULL
 GROUP BY event_time, is_forecast
 ORDER BY event_time DESC
 LIMIT $10`;

const num = (v: unknown): number | null =>
  v == null ? null : Number(Number(v).toFixed(2));

async function handler(input: z.infer<typeof inputSchema>): Promise<Envelope<WindRow>> {
  const params: TimeParams = {
    at: input.at, from: input.from, to: input.to, known_as_of: input.known_as_of,
  };
  const time = resolveTime(params, { defaultWindowHours: 12, instantWindowHours: 1 });
  const bbox = input.bbox ?? null;
  const aggregate = input.aggregate ?? false;
  const includeForecast = input.include_forecast ?? false;

  const args = [
    time.from.toISOString(), time.to.toISOString(), time.knownAsOf.toISOString(),
    input.point_ids ?? null,
    bbox?.min_lat ?? null, bbox?.max_lat ?? null, bbox?.min_lon ?? null, bbox?.max_lon ?? null,
    includeForecast,
    input.limit ?? (aggregate ? 200 : 500),
  ];

  let data: WindRow[];
  let recordIds: RecordId[] = [];

  if (aggregate) {
    const rows = await tq<Record<string, unknown>>(SQL_AGG, args);
    data = rows.map((r) => {
      const dir = num(r.wind_dir_deg);
      return {
        // Aggregated rows are computed, not stored, so they are not citable as
        // records. The agent cites the per-point rows behind them instead.
        record_id: null,
        point_id: null, lat: null, lon: null,
        event_time: new Date(r.event_time as string).toISOString(),
        ingest_time: r.ingest_time ? new Date(r.ingest_time as string).toISOString() : null,
        is_forecast: Boolean(r.is_forecast),
        wind_dir_deg: dir,
        wind_dir_cardinal: cardinal(dir),
        wind_speed_kmh: num(r.wind_speed_kmh),
        wind_gust_kmh: num(r.wind_gust_kmh),
        temp_c: num(r.temp_c),
        rh_pct: num(r.rh_pct),
        pbl_height_m: num(r.pbl_height_m),
        points_averaged: Number(r.points_averaged),
      };
    });
  } else {
    const rows = await tq<Record<string, unknown>>(SQL_POINTS, args);
    data = rows.map((r) => {
      const dir = num(r.wind_dir_deg);
      return {
        record_id: recordId('weather', r.weather_id as string),
        point_id: r.point_id as string,
        lat: num(r.lat), lon: num(r.lon),
        event_time: new Date(r.event_time as string).toISOString(),
        ingest_time: new Date(r.ingest_time as string).toISOString(),
        is_forecast: Boolean(r.is_forecast),
        wind_dir_deg: dir,
        wind_dir_cardinal: cardinal(dir),
        wind_speed_kmh: num(r.wind_speed_kmh),
        wind_gust_kmh: num(r.wind_gust_kmh),
        temp_c: num(r.temp_c),
        rh_pct: num(r.rh_pct),
        pbl_height_m: num(r.pbl_height_m),
      };
    });
    recordIds = data.map((d) => d.record_id!).filter(Boolean);
  }

  // -- Caveats -------------------------------------------------------------
  const caveats: string[] = [
    'Wind direction is the direction the wind blows FROM, following meteorological ' +
      'convention. Smoke travels in the opposite direction.',
    'This is a model (Open-Meteo, ~9-11 km resolution), not an observation. It resolves ' +
      'regional flow well and will miss terrain channelling at valley scale.',
  ];
  if (aggregate) {
    caveats.push(
      'Direction here is a VECTOR mean across points (atan2 of mean sine and mean cosine), ' +
        'not an arithmetic average of degrees — averaging 350 and 10 arithmetically gives ' +
        '180, the exact opposite. Aggregated rows are computed rather than stored, so they ' +
        'carry no record id; cite the per-point rows instead.',
    );
    const spread = data.filter((d) => (d.points_averaged ?? 0) > 1).length;
    if (spread > 0) {
      caveats.push(
        'An averaged direction over a wide area can be meaningless if the flow is not ' +
          'coherent — check points_averaged and consider querying per point where ' +
          'direction matters, such as for attribution.',
      );
    }
  }
  const forecastRows = data.filter((d) => d.is_forecast).length;
  if (forecastRows > 0) {
    caveats.push(
      `${forecastRows} of ${data.length} rows are FORECAST, not analysis. They are flagged ` +
        'is_forecast and must be described as expectation rather than as what happened. ' +
        'Forecast values are revised as the model re-runs; each revision is stored as a ' +
        'new row, so what we expected and what occurred remain separable.',
    );
  }
  const shallow = data.filter((d) => (d.pbl_height_m ?? 9999) < 300).length;
  if (shallow > 0) {
    caveats.push(
      `${shallow} row(s) report a boundary layer below 300 m. Shallow mixing concentrates ` +
        'smoke at the surface, so a moderate fire can produce hazardous readings. Regional ' +
        'median mixing depth is about 340 m, and elevated readings cluster at night and ' +
        'early morning for this reason.',
    );
  }

  return buildEnvelope<WindRow>({
    data,
    recordIds,
    sources: await sourceRefs(['openmeteo_wind']),
    eventTimes: data.map((d) => d.event_time),
    ingestTimes: data.map((d) => d.ingest_time),
    asOf: time.to,
    knownAsOf: time.knownAsOf,
    knownAsOfApplied: true,
    stalenessSeconds: await stalenessFor('openmeteo_wind'),
    gaps: null,
    conflicts: null,
    caveats,
  });
}

export const getWind: ToolDefinition<typeof inputSchema, WindRow> = {
  name: 'get_wind',
  description:
    'Wind direction, speed, gusts and boundary-layer height at sampled points. Direction ' +
    'is the direction wind blows FROM. Use for "which way is the smoke heading", "was the ' +
    'wind blowing from the fire", or to reason about transport. Set aggregate for a ' +
    'regional hourly series (vector-mean direction), or leave it off for per-point detail, ' +
    'which is what attribution-style reasoning needs. Forecast rows are flagged, never ' +
    'merged with analysis.',
  inputSchema,
  handler,
};
