/**
 * compare_time -- what changed between two moments.
 *
 * The timeline asks "replay change over time"; this is the question form of
 * the same thing, so the agent can answer it without scrubbing.
 *
 * The one thing it will not do is treat absence as zero. `hourly_frames` is
 * written sparsely -- a row exists only where something was observed -- so a
 * cell present at one hour and missing at the next has no observation, which
 * is a different statement from "it fell to nothing". Both sides are joined
 * with a FULL OUTER JOIN and each row says whether it was present before,
 * after, or both.
 *
 * Regional comparison uses percentiles rather than maxima, for the reason
 * recorded in Decision 4i: max() over 3 million km² is always extreme
 * somewhere and reported "Hazardous" every hour while the median AQI was 39.
 */

import { z } from 'zod';
import {
  buildEnvelope, derivedKnowledgeNote, recordId,
  type Envelope, type RecordId,
} from './envelope';
import { TimeParamError } from './time';
import { sourceRefs, tq } from './sql';
import { labelCells } from './place';
import type { ToolDefinition } from './types';

const CELL_METRICS = {
  pm25_obs_mean: 'pm25_obs_mean',
  pm25_obs_max: 'pm25_obs_max',
  pm25_model_mean: 'pm25_model_mean',
  us_aqi_max: 'us_aqi_max',
  total_frp_mw: 'total_frp_mw',
  fire_count: 'fire_count',
  top_attribution_score: 'top_attribution_score',
} as const;

type CellMetric = keyof typeof CELL_METRICS;

const bboxSchema = z.object({
  min_lat: z.number(), max_lat: z.number(),
  min_lon: z.number(), max_lon: z.number(),
});

const inputSchema = z.object({
  from: z.string().describe('ISO 8601 — the earlier moment.'),
  to: z.string().describe('ISO 8601 — the later moment.'),
  granularity: z.enum(['region', 'cell']).optional()
    .describe('"region" (default) gives one summary row of regional percentiles. "cell" gives per-area change, ranked by how much the metric moved.'),
  metric: z.enum(Object.keys(CELL_METRICS) as [CellMetric, ...CellMetric[]]).optional()
    .describe('For granularity=cell: which metric to rank change by. Default pm25_obs_mean.'),
  bbox: bboxSchema.optional().describe('Restrict cell comparison to a bounding box.'),
  known_as_of: z.string().optional()
    .describe('Recorded but NOT applied: frames are derived and carry no ingest_time.'),
  limit: z.number().int().min(1).max(200).optional(),
});

export interface MetricChange {
  before: number | null;
  after: number | null;
  delta: number | null;
  pct_change: number | null;
}

export interface ComparisonRow {
  scope: 'region' | 'cell';
  record_id_before: RecordId | null;
  record_id_after: RecordId | null;
  h3_r4: string | null;
  description: string | null;
  label: string | null;
  lat: number | null;
  lon: number | null;
  frame_time_before: string;
  frame_time_after: string;
  /** False means no observation at that moment — NOT a value of zero. */
  present_before: boolean;
  present_after: boolean;
  station_count_before: number | null;
  station_count_after: number | null;
  metrics: Record<string, MetricChange>;
}

const n = (v: unknown): number | null => (v == null ? null : Number(v));

function change(before: unknown, after: unknown): MetricChange {
  const b = n(before);
  const a = n(after);
  const delta = b != null && a != null ? Number((a - b).toFixed(3)) : null;
  // Percent change is undefined against a zero or absent baseline, and
  // reporting a large number there would be an artefact rather than a finding.
  const pct = b != null && a != null && Math.abs(b) > 0.01
    ? Number((((a - b) / Math.abs(b)) * 100).toFixed(1)) : null;
  return { before: b, after: a, delta, pct_change: pct };
}

/** Snap to the most recent frame at or before a moment. */
async function snapFrame(when: Date): Promise<Date | null> {
  const r = await tq<{ frame_time: string }>(
    `SELECT max(frame_time) AS frame_time FROM hourly_frames WHERE frame_time <= $1::timestamptz`,
    [when.toISOString()],
  );
  return r[0]?.frame_time ? new Date(r[0].frame_time) : null;
}

const REGION_COLS = [
  'fire_count', 'fire_count_confident', 'total_frp_mw', 'station_count',
  'pm25_p50', 'pm25_p90', 'pm25_p99', 'pm25_worst_cell', 'pm25_model_p50',
  'us_aqi_p50', 'us_aqi_p90', 'us_aqi_worst_cell',
  'top_attribution_score', 'cells_with_attribution', 'cells', 'partial_cells',
];

async function handler(input: z.infer<typeof inputSchema>): Promise<Envelope<ComparisonRow>> {
  const t1 = new Date(input.from);
  const t2 = new Date(input.to);
  if (Number.isNaN(t1.getTime()) || Number.isNaN(t2.getTime())) {
    throw new TimeParamError('`from` and `to` must both be valid ISO 8601 timestamps.');
  }
  if (t1 >= t2) {
    throw new TimeParamError('`from` must be earlier than `to`.');
  }

  const granularity = input.granularity ?? 'region';
  const metric = (input.metric ?? 'pm25_obs_mean') as CellMetric;
  const knownAsOf = input.known_as_of ? new Date(input.known_as_of) : new Date();

  const [f1, f2] = await Promise.all([snapFrame(t1), snapFrame(t2)]);
  const caveats: string[] = [];

  if (f1 === null || f2 === null) {
    return buildEnvelope<ComparisonRow>({
      data: [], recordIds: [],
      sources: await sourceRefs(['openaq', 'firms_viirs']),
      asOf: t2, knownAsOf, knownAsOfApplied: false,
      stalenessSeconds: null, gaps: null, conflicts: null,
      caveats: [
        'No frame exists at or before one of the requested moments. Frames cover ' +
          '2026-09-14T07:00Z onwards; earlier moments predate the recorded history.',
      ],
    });
  }
  if (f1.getTime() === f2.getTime()) {
    caveats.push(
      `Both moments snapped to the same frame (${f1.toISOString()}), so there is nothing ` +
        'to compare. Frames are hourly; choose moments at least an hour apart.',
    );
  }

  for (const [label, requested, snapped] of [
    ['from', t1, f1], ['to', t2, f2],
  ] as [string, Date, Date][]) {
    const lag = Math.round((requested.getTime() - snapped.getTime()) / 60000);
    if (lag > 60) {
      caveats.push(
        `\`${label}\` snapped back ${lag} minutes to the nearest frame ` +
          `(${snapped.toISOString()}); frames are hourly and the most recent hours are ` +
          'often written before the feeds have reported for them.',
      );
    }
  }

  let data: ComparisonRow[] = [];
  let recordIds: RecordId[] = [];

  if (granularity === 'region') {
    const rows = await tq<Record<string, unknown>>(
      `SELECT * FROM v_timeline_series WHERE frame_time = ANY($1::timestamptz[])`,
      [[f1.toISOString(), f2.toISOString()]],
    );
    const before = rows.find((r) => new Date(r.frame_time as string).getTime() === f1.getTime());
    const after = rows.find((r) => new Date(r.frame_time as string).getTime() === f2.getTime());

    const metrics: Record<string, MetricChange> = {};
    for (const col of REGION_COLS) metrics[col] = change(before?.[col], after?.[col]);

    data = [{
      scope: 'region',
      record_id_before: null, record_id_after: null,
      h3_r4: null, description: 'Western North America (all cells)', label: null,
      lat: null, lon: null,
      frame_time_before: f1.toISOString(), frame_time_after: f2.toISOString(),
      present_before: before != null, present_after: after != null,
      station_count_before: n(before?.station_count),
      station_count_after: n(after?.station_count),
      metrics,
    }];

    caveats.push(
      'Regional values are PERCENTILES across cells, not maxima. pm25_worst_cell and ' +
        'us_aqi_worst_cell are named that way deliberately: a maximum over 3 million km² ' +
        'is always extreme somewhere, and reporting it as the regional condition made an ' +
        'early timeline read "Hazardous" every hour while the median AQI was 39.',
    );
  } else {
    const col = CELL_METRICS[metric];
    const rows = await tq<Record<string, unknown>>(
      `WITH a AS (SELECT * FROM hourly_frames WHERE frame_time = $1::timestamptz),
            b AS (SELECT * FROM hourly_frames WHERE frame_time = $2::timestamptz)
       SELECT COALESCE(a.h3_r4, b.h3_r4) AS h3_r4,
              a.h3_r4 IS NOT NULL AS present_before,
              b.h3_r4 IS NOT NULL AS present_after,
              a.station_count AS station_count_before,
              b.station_count AS station_count_after,
              a.pm25_obs_mean AS pm25_obs_mean_b, b.pm25_obs_mean AS pm25_obs_mean_a,
              a.pm25_obs_max  AS pm25_obs_max_b,  b.pm25_obs_max  AS pm25_obs_max_a,
              a.pm25_model_mean AS pm25_model_mean_b, b.pm25_model_mean AS pm25_model_mean_a,
              a.us_aqi_max AS us_aqi_max_b, b.us_aqi_max AS us_aqi_max_a,
              a.total_frp_mw AS total_frp_mw_b, b.total_frp_mw AS total_frp_mw_a,
              a.fire_count AS fire_count_b, b.fire_count AS fire_count_a,
              a.top_attribution_score AS top_attribution_score_b,
              b.top_attribution_score AS top_attribution_score_a
         FROM a FULL OUTER JOIN b ON a.h3_r4 = b.h3_r4
        -- At least one side must carry the ranked metric. Without this, a
        -- comparison on total_frp_mw at an hour with no satellite overpass
        -- returned cells whose FRP was null on both sides, tied at a change of
        -- zero -- technically correct and entirely useless.
        WHERE COALESCE(a.${col}, b.${col}) IS NOT NULL
        -- Ranked by how much the metric MOVED. Rows missing on either side sort
        -- last rather than counting as an infinite change.
        ORDER BY abs(COALESCE(b.${col}, 0) - COALESCE(a.${col}, 0)) DESC NULLS LAST
        LIMIT $3`,
      [f1.toISOString(), f2.toISOString(), input.limit ?? 25],
    );

    const labels = await labelCells(rows.map((r) => r.h3_r4 as string));

    data = rows.map((r) => {
      const cell = r.h3_r4 as string;
      const l = labels.get(cell)!;
      const metrics: Record<string, MetricChange> = {};
      for (const m of Object.keys(CELL_METRICS)) {
        metrics[m] = change(r[`${m}_b`], r[`${m}_a`]);
      }
      return {
        scope: 'cell' as const,
        record_id_before: r.present_before ? recordId('frame', f1.toISOString(), cell) : null,
        record_id_after: r.present_after ? recordId('frame', f2.toISOString(), cell) : null,
        h3_r4: cell,
        description: l.description,
        label: l.zone_name,
        lat: l.lat, lon: l.lon,
        frame_time_before: f1.toISOString(), frame_time_after: f2.toISOString(),
        present_before: Boolean(r.present_before),
        present_after: Boolean(r.present_after),
        station_count_before: n(r.station_count_before),
        station_count_after: n(r.station_count_after),
        metrics,
      };
    });

    if (input.bbox) {
      const bb = input.bbox;
      data = data.filter((d) => d.lat != null && d.lon != null &&
        d.lat >= bb.min_lat && d.lat <= bb.max_lat &&
        d.lon >= bb.min_lon && d.lon <= bb.max_lon);
    }

    recordIds = data.flatMap((d) =>
      [d.record_id_before, d.record_id_after].filter((x): x is RecordId => x !== null));

    if (data.length === 0) {
      const isFireMetric = metric === 'total_frp_mw' || metric === 'fire_count';
      caveats.push(
        `No cell carries ${metric} at either moment. ` +
          (isFireMetric
            ? 'For fire metrics this usually means no satellite overpass covered that ' +
              'hour — three VIIRS satellites give about six passes a day, so most hours ' +
              'have none. It is a gap in observation, not an absence of fire.'
            : 'Frames are written sparsely, and the most recent hours are often written ' +
              'before the feeds have reported for them. This is missing observation, not ' +
              'a value of zero.'),
      );
    }
    const unchanged = data.filter((d) => d.metrics[metric].delta === 0).length;
    if (data.length > 0 && unchanged === data.length) {
      caveats.push(`${metric} is unchanged in every cell returned between these moments.`);
    }
    const appeared = data.filter((d) => !d.present_before && d.present_after).length;
    const vanished = data.filter((d) => d.present_before && !d.present_after).length;
    if (appeared > 0 || vanished > 0) {
      caveats.push(
        `${appeared} cell(s) have no frame at the earlier moment and ${vanished} have none ` +
          'at the later one. Frames are written only where something was observed, so ' +
          'these are missing observations, NOT values of zero. present_before and ' +
          'present_after distinguish the two.',
      );
    }
    // A frame row can exist while the metric itself is null -- the cell was
    // observed for something, just not for this. That is the more common shape
    // of absence and it is invisible in present_before/present_after, so it is
    // counted separately. `delta` is null for these rather than a fabricated
    // drop to zero.
    const lostMetric = data.filter(
      (d) => d.metrics[metric].before != null && d.metrics[metric].after == null).length;
    const gainedMetric = data.filter(
      (d) => d.metrics[metric].before == null && d.metrics[metric].after != null).length;
    if (lostMetric > 0 || gainedMetric > 0) {
      caveats.push(
        `${metric} is present at one moment but absent at the other in ` +
          `${lostMetric + gainedMetric} cell(s) — ${lostMetric} lost it, ${gainedMetric} ` +
          'gained it. Their delta is null rather than a change to zero: the station simply ' +
          'did not report that hour. Do not describe these as improvements or ' +
          'deteriorations.',
      );
    }
    const single = data.filter((d) =>
      (d.station_count_before === 1 || d.station_count_after === 1)).length;
    if (single > 0) {
      caveats.push(
        `${single} cell(s) have exactly one reporting station on at least one side, so the ` +
          'change reflects that sensor rather than an area.',
      );
    }
  }

  return buildEnvelope<ComparisonRow>({
    data,
    recordIds,
    sources: await sourceRefs(['openaq', 'firms_viirs', 'openmeteo_cams_aq']),
    eventTimes: [f1.toISOString(), f2.toISOString()],
    ingestTimes: [],
    asOf: f2,
    knownAsOf,
    knownAsOfApplied: false,
    knownAsOfNote: input.known_as_of
      ? derivedKnowledgeNote('hourly_frames', null) : null,
    stalenessSeconds: null,
    gaps: null,
    conflicts: null,
    caveats,
  });
}

export const compareTime: ToolDefinition<typeof inputSchema, ComparisonRow> = {
  name: 'compare_time',
  description:
    'What changed between two moments — regionally, or per area. Use for "is it getting ' +
    'worse", "how does today compare to yesterday", "where did it improve". Regional ' +
    'figures are percentiles across areas, never maxima. Per-cell comparison distinguishes ' +
    'a cell that had no observation from one that fell to zero, which are different facts.',
  inputSchema,
  handler,
};
