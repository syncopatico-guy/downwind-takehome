/**
 * rank_places -- where is it worst right now, and how confident can we be.
 *
 * Two rules from earlier findings shape this one entirely.
 *
 * It ranks H3 r4 cells rather than stations, because Decision 4i established
 * that a maximum over a region is not a regional condition: the first timeline
 * view plotted max(us_aqi) across 3 million km² and sat flat at "Hazardous"
 * every hour while the regional median was 39. Every row therefore carries
 * station_count and both the mean and the worst station in the cell, so a
 * single hot sensor cannot pose as a region.
 *
 * And cells are named only by a zone that provably contains them (Decision
 * 3u). Measured, that names 264 of 1,111 cells; the rest are described by
 * coordinates. Nearest-zone naming was wrong 223 times out of 358.
 */

import { z } from 'zod';
import {
  buildEnvelope, derivedKnowledgeNote, recordId,
  type Envelope, type RecordId,
} from './envelope';
import { resolveTime, type TimeParams } from './time';
import { sourceRefs, tq } from './sql';
import { labelCells } from './place';
import type { ToolDefinition } from './types';

/** Metric -> the frame column it ranks on, and whether it needs a station. */
const METRICS = {
  pm25_obs_mean:        { column: 'pm25_obs_mean',        needsStation: true },
  pm25_obs_max:         { column: 'pm25_obs_max',         needsStation: true },
  us_aqi_max:           { column: 'us_aqi_max',           needsStation: true },
  pm25_model_mean:      { column: 'pm25_model_mean',      needsStation: false },
  total_frp_mw:         { column: 'total_frp_mw',         needsStation: false },
  fire_count:           { column: 'fire_count',           needsStation: false },
  top_attribution_score:{ column: 'top_attribution_score',needsStation: false },
} as const;

type MetricName = keyof typeof METRICS;

const bboxSchema = z.object({
  min_lat: z.number(), max_lat: z.number(),
  min_lon: z.number(), max_lon: z.number(),
});

const inputSchema = z.object({
  metric: z.enum(Object.keys(METRICS) as [MetricName, ...MetricName[]]).optional()
    .describe('What to rank by. Default pm25_obs_mean — the measured regional condition rather than the worst single sensor.'),
  at: z.string().optional()
    .describe('ISO 8601 instant. Snaps to the most recent frame at or before this that carries the metric.'),
  bbox: bboxSchema.optional().describe('Restrict to a bounding box.'),
  known_as_of: z.string().optional()
    .describe('Recorded but NOT applied: frames are derived and carry no ingest_time.'),
  min_station_count: z.number().int().min(0).optional()
    .describe('Require at least this many stations in a cell. Useful to exclude single-sensor cells.'),
  limit: z.number().int().min(1).max(200).optional(),
});

export interface RankedPlace {
  record_id: RecordId;
  rank: number;
  h3_r4: string;
  /** Null unless an NWS zone provably contains the cell centre. */
  label: string | null;
  description: string;
  state: string | null;
  lat: number;
  lon: number;
  frame_time: string;
  metric: string;
  value: number;
  /** How many stations reported in this cell. 1 means the "regional" value is one sensor. */
  station_count: number;
  pm25_obs_mean: number | null;
  pm25_obs_max: number | null;
  pm25_model_mean: number | null;
  us_aqi_max: number | null;
  fire_count: number;
  total_frp_mw: number | null;
  top_attribution_score: number | null;
  wind_dir_deg: number | null;
  wind_speed_kmh: number | null;
  alert_event_type: string | null;
  is_partial: boolean;
  missing_sources: string[] | null;
}

async function handler(input: z.infer<typeof inputSchema>): Promise<Envelope<RankedPlace>> {
  const params: TimeParams = { at: input.at, known_as_of: input.known_as_of };
  const time = resolveTime(params, { defaultWindowHours: 1, instantWindowHours: 1 });
  const requested = input.at ? new Date(input.at) : time.to;
  const metric = (input.metric ?? 'pm25_obs_mean') as MetricName;
  const spec = METRICS[metric];
  const bbox = input.bbox ?? null;
  const limit = input.limit ?? 20;
  const minStations = input.min_station_count ?? (spec.needsStation ? 1 : 0);

  // Snap back to the most recent frame that actually carries this metric.
  // The newest one or two frame hours are routinely written before the feeds
  // have reported for them -- the latest frame had 456 cells and zero
  // stations -- so using the newest frame unconditionally would report an
  // empty region as a clean one.
  const snap = await tq<{ frame_time: string }>(
    `SELECT frame_time FROM hourly_frames
      WHERE frame_time <= $1::timestamptz
        AND ${spec.column} IS NOT NULL
        AND ($2::int = 0 OR station_count >= $2)
      GROUP BY frame_time
      ORDER BY frame_time DESC
      LIMIT 1`,
    [requested.toISOString(), minStations],
  );

  if (snap.length === 0) {
    return buildEnvelope<RankedPlace>({
      data: [], recordIds: [],
      sources: await sourceRefs(['openaq', 'firms_viirs']),
      asOf: requested, knownAsOf: time.knownAsOf,
      knownAsOfApplied: false,
      stalenessSeconds: null, gaps: null, conflicts: null,
      caveats: [
        `No frame at or before ${requested.toISOString()} carries ${metric}. The frame ` +
          'table is written sparsely — only cell-hours where something was observed — so ' +
          'this means no observation, not a value of zero.',
      ],
    });
  }
  const frameTime = new Date(snap[0].frame_time);

  const rows = await tq<Record<string, unknown>>(
    `SELECT frame_time, h3_r4, station_count, pm25_obs_mean, pm25_obs_max, pm25_model_mean,
            us_aqi_max, fire_count, total_frp_mw, top_attribution_score,
            wind_dir_deg, wind_speed_kmh, alert_event_type, is_partial, missing_sources,
            ${spec.column} AS metric_value
       FROM hourly_frames
      WHERE frame_time = $1::timestamptz
        AND ${spec.column} IS NOT NULL
        AND ($2::int = 0 OR station_count >= $2)
      ORDER BY ${spec.column} DESC NULLS LAST
      LIMIT $3`,
    [frameTime.toISOString(), minStations, limit],
  );

  // Labels are resolved only for the cells actually returned.
  const labels = await labelCells(rows.map((r) => r.h3_r4 as string));

  const n = (v: unknown): number | null => (v == null ? null : Number(v));

  let data: RankedPlace[] = rows.map((r, i) => {
    const cell = r.h3_r4 as string;
    const l = labels.get(cell)!;
    return {
      record_id: recordId('frame', frameTime.toISOString(), cell),
      rank: i + 1,
      h3_r4: cell,
      label: l.zone_name,
      description: l.description,
      state: l.state,
      lat: l.lat, lon: l.lon,
      frame_time: frameTime.toISOString(),
      metric,
      value: Number(Number(r.metric_value).toFixed(2)),
      station_count: Number(r.station_count ?? 0),
      pm25_obs_mean: n(r.pm25_obs_mean), pm25_obs_max: n(r.pm25_obs_max),
      pm25_model_mean: n(r.pm25_model_mean), us_aqi_max: n(r.us_aqi_max),
      fire_count: Number(r.fire_count ?? 0), total_frp_mw: n(r.total_frp_mw),
      top_attribution_score: n(r.top_attribution_score),
      wind_dir_deg: n(r.wind_dir_deg), wind_speed_kmh: n(r.wind_speed_kmh),
      alert_event_type: (r.alert_event_type as string) ?? null,
      is_partial: Boolean(r.is_partial),
      missing_sources: (r.missing_sources as string[]) ?? null,
    };
  });

  if (bbox) {
    data = data
      .filter((d) => d.lat >= bbox.min_lat && d.lat <= bbox.max_lat &&
                     d.lon >= bbox.min_lon && d.lon <= bbox.max_lon)
      .map((d, i) => ({ ...d, rank: i + 1 }));
  }

  // -- Caveats -------------------------------------------------------------
  const caveats: string[] = [];
  const lagMin = Math.round((requested.getTime() - frameTime.getTime()) / 60000);
  if (lagMin > 60) {
    caveats.push(
      `Ranked on the frame at ${frameTime.toISOString()}, which is ${lagMin} minutes ` +
        `before the requested time — later frames carry no ${metric}. Frames are written ` +
        'sparsely, and the most recent hours are routinely written before the feeds have ' +
        'reported for them.',
    );
  }
  const single = data.filter((d) => d.station_count === 1).length;
  if (single > 0 && spec.needsStation) {
    caveats.push(
      `${single} of ${data.length} ranked cells contain exactly ONE reporting station, so ` +
        'their value is that sensor rather than an area condition. A cell is roughly ' +
        '1,770 km².',
    );
  }
  if (metric === 'pm25_obs_max' || metric === 'us_aqi_max') {
    caveats.push(
      `${metric} is the WORST station in each cell, not the cell's condition. Reporting a ` +
        'maximum as though it described a region is the error that made an early timeline ' +
        'read "Hazardous" every hour while the regional median was 39. Use pm25_obs_mean ' +
        'for the area condition and quote the max as the worst point within it.',
    );
  }
  const unlabelled = data.filter((d) => d.label === null).length;
  if (unlabelled > 0) {
    caveats.push(
      `${unlabelled} of ${data.length} cells have no place name and are given by ` +
        'coordinates. Names are attached only where an NWS zone provably contains the ' +
        'cell centre — about 24% of cells — because naming by nearest zone instead was ' +
        'measured wrong 223 times out of 358.',
    );
  }
  const partial = data.filter((d) => d.is_partial).length;
  if (partial > 0) {
    caveats.push(
      `${partial} ranked cell(s) are marked partial: a feed that normally covers them ` +
        'reported nothing this hour. Check missing_sources — the gap is real, not zero.',
    );
  }
  if (metric === 'pm25_model_mean') {
    caveats.push(
      'This ranks MODELLED values, not measurements. CAMS runs 42% high against sensors ' +
        'with a correlation of 0.118, so this ranks where the model thinks it is worst.',
    );
  }

  return buildEnvelope<RankedPlace>({
    data,
    recordIds: data.map((d) => d.record_id),
    sources: await sourceRefs(
      spec.needsStation ? ['openaq'] : metric === 'pm25_model_mean'
        ? ['openmeteo_cams_aq'] : ['firms_viirs'],
    ),
    eventTimes: data.map((d) => d.frame_time),
    ingestTimes: [],
    asOf: frameTime,
    knownAsOf: time.knownAsOf,
    knownAsOfApplied: false,
    knownAsOfNote: time.knownAsOfRequested
      ? derivedKnowledgeNote('hourly_frames', null) : null,
    stalenessSeconds: null,
    gaps: null,
    conflicts: null,
    caveats,
  });
}

export const rankPlaces: ToolDefinition<typeof inputSchema, RankedPlace> = {
  name: 'rank_places',
  description:
    'Rank areas by air quality, fire activity or attribution strength at a moment in ' +
    'time. Use for "where is the air worst", "where is burning hardest", "which areas ' +
    'are affected". Ranks ~1,770 km² cells rather than individual stations, and returns ' +
    'station_count with every row so a single hot sensor is never mistaken for a regional ' +
    'condition. Cells are named only where a zone provably contains them; the rest are ' +
    'given by coordinates.',
  inputSchema,
  handler,
};
