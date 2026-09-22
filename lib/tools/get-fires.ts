/**
 * get_fires -- fire clusters, with what they are as well as where.
 *
 * Detections are not fires: 7,431 detections resolve to 617 clusters, and the
 * busiest single complex accounts for ~186 of them. Clustering is what lets the
 * agent name a thing and track it (Decision 3d/3r).
 *
 * The load-bearing field here is `source_character`. FIRMS detects industrial
 * heat as fire -- refineries, gas flares, the Athabasca oil sands -- and those
 * are real emission sources that genuinely raise PM downwind, so they are
 * flagged rather than excluded (Decision 3t). The agent must never call one a
 * wildfire, which is why the field travels with every row and the caveats say
 * so explicitly.
 */

import { z } from 'zod';
import {
  buildEnvelope, derivedKnowledgeNote, recordId,
  type Envelope, type RecordId,
} from './envelope';
import { resolveTime, type TimeParams } from './time';
import { sourceRefs, stalenessFor, tq } from './sql';
import type { ToolDefinition } from './types';

const bboxSchema = z.object({
  min_lat: z.number(), max_lat: z.number(),
  min_lon: z.number(), max_lon: z.number(),
});

const inputSchema = z.object({
  bbox: bboxSchema.optional().describe('Bounding box, typically from resolve_place.'),
  cluster_keys: z.array(z.string()).optional()
    .describe('Specific fire cluster keys, e.g. ["fire:8675ecb6..."].'),
  at: z.string().optional().describe('ISO 8601 instant (event time).'),
  from: z.string().optional().describe('ISO 8601 range start (event time).'),
  to: z.string().optional().describe('ISO 8601 range end (event time).'),
  known_as_of: z.string().optional()
    .describe('Recorded but NOT applied: fire clusters are derived and carry no ingest_time.'),
  min_frp_mw: z.number().optional()
    .describe('Minimum total fire radiative power. Useful for filtering out small burns.'),
  source_character: z.enum(['likely_wildfire', 'likely_industrial', 'indeterminate']).optional()
    .describe('Filter by what the heat source appears to be. Omit to get all three.'),
  include_detections: z.boolean().optional()
    .describe('Also return the underlying satellite detections for each cluster (evidence chain).'),
  limit: z.number().int().min(1).max(500).optional(),
});

export interface FireDetectionRef {
  record_id: RecordId;
  lat: number;
  lon: number;
  event_time: string;
  frp_mw: number | null;
  confidence: string | null;
  satellite: string | null;
  daynight: string | null;
}

export interface FireRow {
  record_id: RecordId;
  cluster_key: string;
  /** Null unless the centroid provably sits inside a named NWS zone. */
  label: string | null;
  label_source: string | null;
  source_character: string;
  lat: number;
  lon: number;
  region: string | null;
  first_event_time: string;
  last_event_time: string;
  seconds_since_detection: number | null;
  detection_count: number;
  detections_24h: number;
  total_frp_mw: number | null;
  max_frp_mw: number | null;
  frp_24h: number | null;
  mean_confidence: number | null;
  low_confidence_share: number | null;
  /** Intensity variability. Wildfires 0.63-2.60; industrial sources 0.30-0.37. */
  frp_cv: number | null;
  footprint_spread_m: number | null;
  duration_days: number | null;
  method_version: string;
  detections?: FireDetectionRef[];
}

interface Raw {
  cluster_id: string; cluster_key: string; label: string | null; label_source: string | null;
  source_character: string; lat: number; lon: number; region: string | null;
  first_event_time: string; last_event_time: string; seconds_since_detection: string | null;
  detection_count: number; detections_24h: string; total_frp_mw: number | null;
  max_frp_mw: number | null; frp_24h: string | null; mean_confidence: number | null;
  low_confidence_share: number | null; frp_cv: number | null;
  footprint_spread_m: number | null; duration_days: number | null;
  method_version: string; computed_at: string;
}

const SQL = `
SELECT cluster_id, cluster_key, label, label_source, source_character,
       ST_Y(centroid::geometry) AS lat, ST_X(centroid::geometry) AS lon,
       region, first_event_time, last_event_time, seconds_since_detection,
       detection_count, detections_24h, total_frp_mw, max_frp_mw, frp_24h,
       mean_confidence, low_confidence_share, frp_cv, footprint_spread_m,
       duration_days, method_version, computed_at
  FROM v_fire_clusters_active
 WHERE ($1::text[] IS NULL OR cluster_key = ANY($1))
   -- Overlap, not containment: a fire burning across the window boundary is
   -- still burning during the window.
   AND last_event_time >= $2::timestamptz
   AND first_event_time <= $3::timestamptz
   AND ($4::float8 IS NULL OR (lat_c BETWEEN $4 AND $5 AND lon_c BETWEEN $6 AND $7))
   AND ($8::float8 IS NULL OR total_frp_mw >= $8)
   AND ($9::text IS NULL OR source_character = $9)
 ORDER BY total_frp_mw DESC NULLS LAST
 LIMIT $10`;

async function handler(input: z.infer<typeof inputSchema>): Promise<Envelope<FireRow>> {
  const params: TimeParams = {
    at: input.at, from: input.from, to: input.to, known_as_of: input.known_as_of,
  };
  // 48h: the clustering rule already treats a 48-hour silence as a separate
  // fire (Decision 3r), so it is the natural unit of "currently burning".
  const time = resolveTime(params, { defaultWindowHours: 48, instantWindowHours: 12 });
  const bbox = input.bbox ?? null;

  // The view exposes the centroid as geography; lat/lon are derived per row, so
  // the bbox test is wrapped rather than applied to a bare column.
  const sql = SQL.replace('lat_c', 'ST_Y(centroid::geometry)')
                 .replace('lon_c', 'ST_X(centroid::geometry)');

  const rows = await tq<Raw>(sql, [
    input.cluster_keys ?? null,
    time.from.toISOString(), time.to.toISOString(),
    bbox?.min_lat ?? null, bbox?.max_lat ?? null, bbox?.min_lon ?? null, bbox?.max_lon ?? null,
    input.min_frp_mw ?? null,
    input.source_character ?? null,
    input.limit ?? 100,
  ]);

  const data: FireRow[] = rows.map((r) => ({
    record_id: recordId('fire_cluster', r.cluster_id),
    cluster_key: r.cluster_key,
    label: r.label,
    label_source: r.label_source,
    source_character: r.source_character,
    lat: Number(r.lat), lon: Number(r.lon),
    region: r.region,
    first_event_time: new Date(r.first_event_time).toISOString(),
    last_event_time: new Date(r.last_event_time).toISOString(),
    seconds_since_detection: r.seconds_since_detection == null ? null : Number(r.seconds_since_detection),
    detection_count: Number(r.detection_count),
    detections_24h: Number(r.detections_24h),
    total_frp_mw: r.total_frp_mw,
    max_frp_mw: r.max_frp_mw,
    frp_24h: r.frp_24h == null ? null : Number(r.frp_24h),
    mean_confidence: r.mean_confidence,
    low_confidence_share: r.low_confidence_share,
    frp_cv: r.frp_cv,
    footprint_spread_m: r.footprint_spread_m,
    duration_days: r.duration_days,
    method_version: r.method_version,
  }));

  // Optional evidence chain: cluster -> the satellite detections behind it.
  const detectionIds: RecordId[] = [];
  if (input.include_detections && rows.length > 0) {
    const dets = await tq<{
      cluster_id: string; detection_id: string; lat: number; lon: number;
      event_time: string; frp_mw: number | null; confidence: string | null;
      satellite: string | null; daynight: string | null;
    }>(
      `SELECT cluster_id, detection_id, lat, lon, event_time, frp_mw, confidence,
              satellite, daynight
         FROM fire_detections
        WHERE cluster_id = ANY($1::bigint[])
          AND event_time >= $2::timestamptz AND event_time <= $3::timestamptz
        ORDER BY cluster_id, event_time DESC`,
      [rows.map((r) => r.cluster_id), time.from.toISOString(), time.to.toISOString()],
    );
    const byCluster = new Map<string, FireDetectionRef[]>();
    for (const d of dets) {
      const id = recordId('fire_detection', d.detection_id);
      detectionIds.push(id);
      const list = byCluster.get(d.cluster_id) ?? [];
      list.push({
        record_id: id, lat: Number(d.lat), lon: Number(d.lon),
        event_time: new Date(d.event_time).toISOString(),
        frp_mw: d.frp_mw, confidence: d.confidence,
        satellite: d.satellite, daynight: d.daynight,
      });
      byCluster.set(d.cluster_id, list);
    }
    data.forEach((row, i) => { row.detections = byCluster.get(rows[i].cluster_id) ?? []; });
  }

  // -- Caveats -------------------------------------------------------------
  const caveats: string[] = [];
  const industrial = data.filter((d) => d.source_character === 'likely_industrial').length;
  const indeterminate = data.filter((d) => d.source_character === 'indeterminate').length;

  if (industrial > 0) {
    caveats.push(
      `${industrial} of ${data.length} clusters are flagged likely_industrial — refineries, ` +
        'gas flares and similar fixed thermal sources such as the Athabasca oil sands. ' +
        'They are real emission sources and are deliberately not excluded, because a ' +
        'station downwind of a refinery genuinely reads elevated PM. They must never be ' +
        'described as wildfires.',
    );
  }
  if (indeterminate > 0) {
    caveats.push(
      `${indeterminate} cluster(s) are "indeterminate": fewer than 10 detections, too few ` +
        'to characterise as wildfire or industrial either way. Saying so is better than ' +
        'guessing — these carry about 13.6% of total fire radiative power between them.',
    );
  }
  const unlabelled = data.filter((d) => d.label === null).length;
  if (unlabelled > 0) {
    caveats.push(
      `${unlabelled} of ${data.length} clusters have no place name. Labels are attached only ` +
        'where the fire centroid provably falls inside a named NWS zone; naming by nearest ' +
        'zone instead was measured to pick a neighbouring region 223 times out of 358. ' +
        'Describe these by coordinates.',
    );
  }
  caveats.push(
    'A gap between detections means no satellite passed over, not that the fire stopped. ' +
      'Three VIIRS satellites give roughly six overpasses a day, so a fire burning ' +
      'continuously is observed intermittently.',
  );
  if (data.some((d) => d.frp_cv != null)) {
    caveats.push(
      'frp_cv (intensity variability) separates the two source types in one direction ' +
        'only. Measured across all 617 clusters: industrial 0.21-0.59 (median 0.37), ' +
        'wildfire 0.20-2.60 (median 0.66). No industrial cluster exceeds 0.63, so a HIGH ' +
        'value is strong evidence of a wildfire — but 36 of 88 wildfires sit below 0.63 ' +
        'too, so a LOW value does not imply industrial. Footprint spread is the other ' +
        'signal (industrial median 475 m, wildfire 884 m).',
    );
  }
  const lowConf = data.filter((d) => (d.low_confidence_share ?? 0) > 0.3).length;
  if (lowConf > 0) {
    caveats.push(
      `${lowConf} cluster(s) draw more than 30% of their detections from low-confidence ` +
        'pixels, which are more likely to be false positives.',
    );
  }

  return buildEnvelope<FireRow>({
    data,
    recordIds: [...data.map((d) => d.record_id), ...detectionIds],
    sources: await sourceRefs(['firms_viirs']),
    eventTimes: data.map((d) => d.last_event_time),
    ingestTimes: [],
    asOf: time.to,
    knownAsOf: time.knownAsOf,
    knownAsOfApplied: false,
    knownAsOfNote: time.knownAsOfRequested
      ? derivedKnowledgeNote('fire_clusters', rows[0]?.computed_at ?? null)
      : null,
    stalenessSeconds: await stalenessFor('firms_viirs'),
    gaps: null,
    conflicts: null,
    caveats,
  });
}

export const getFires: ToolDefinition<typeof inputSchema, FireRow> = {
  name: 'get_fires',
  description:
    'Active fire clusters with location, intensity (fire radiative power), duration and ' +
    'what the heat source appears to be. Use for "what is burning near X", "how big is ' +
    'the fire", or to find candidate sources for smoke. Always check source_character: ' +
    'clusters flagged likely_industrial are refineries and gas flares, not wildfires. ' +
    'Set include_detections to follow a cluster back to the individual satellite pixels.',
  inputSchema,
  handler,
};
