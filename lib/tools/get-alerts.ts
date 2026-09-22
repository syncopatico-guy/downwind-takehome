/**
 * get_alerts -- what officials actually declared.
 *
 * This is the advisory leg of the observation / model / advisory axis, and the
 * only feed carrying human judgement. It can disagree with both of the others,
 * which is the point of including it.
 *
 * Two things this tool takes seriously. Alerts are queried as active AT A
 * REQUESTED INSTANT rather than only now -- with 1 alert currently active
 * against 901 historical, "now" would make the feed look empty and the
 * timeline would have nothing to replay. And an alert that was CANCELLED is
 * distinguished from one that merely expired: Decision 3j added the amendment
 * chain precisely because, without it, a warning lifted early looks identical
 * to one that ran its course, which is a timeline correctness problem.
 */

import { z } from 'zod';
import { buildEnvelope, recordId, type Envelope, type RecordId } from './envelope';
import { resolveTime, type TimeParams } from './time';
import { sourceRefs, stalenessFor, tq } from './sql';
import { isSmokeRelevantEvent, SMOKE_RELEVANT_EVENTS } from '../scope';
import type { ToolDefinition } from './types';

const bboxSchema = z.object({
  min_lat: z.number(), max_lat: z.number(),
  min_lon: z.number(), max_lon: z.number(),
});

const inputSchema = z.object({
  bbox: bboxSchema.optional().describe('Bounding box, typically from resolve_place.'),
  at: z.string().optional()
    .describe('ISO 8601 instant. Returns alerts in force AT that moment. Defaults to now.'),
  from: z.string().optional().describe('ISO 8601 range start.'),
  to: z.string().optional().describe('ISO 8601 range end.'),
  known_as_of: z.string().optional().describe('ISO 8601 knowledge cutoff.'),
  active_only: z.boolean().optional()
    .describe('Only alerts in force at the requested instant. Default true for an instant, false for a range.'),
  event_types: z.array(z.string()).optional()
    .describe('Filter by event type, e.g. ["Red Flag Warning", "Air Quality Alert"].'),
  smoke_relevant_only: z.boolean().optional()
    .describe('Restrict to the smoke/fire/dust event types this system reasons about.'),
  include_geometry: z.boolean().optional()
    .describe('Also return a representative lat/lon per alert. Off by default because resolving alert shapes is expensive; a bbox query turns it on automatically.'),
  limit: z.number().int().min(1).max(500).optional(),
});

export interface AlertRow {
  record_id: RecordId;
  alert_id: string;
  event_type: string;
  severity: string | null;
  message_type: string | null;
  headline: string | null;
  area_desc: string | null;
  sent: string;
  onset: string | null;
  ends: string | null;
  expires: string | null;
  ingest_time: string;
  source_url: string | null;
  /** 'polygon' when the product carried one, 'zones' when built from zone geometry. */
  geometry_origin: string;
  has_geometry: boolean;
  zones_resolved: number;
  zones_referenced: number;
  ugc_codes: string[] | null;
  lat: number | null;
  lon: number | null;
  smoke_relevant: boolean;
  /** True when a later Cancel message references this alert: lifted, not expired. */
  cancelled: boolean;
  active_at_requested_time: boolean;
}

interface Raw {
  alert_row_id: string; alert_id: string; event_type: string; severity: string | null;
  message_type: string | null; headline: string | null; area_desc: string | null;
  sent: string; onset: string | null; ends: string | null; expires: string | null;
  ingest_time: string; source_url: string | null; geometry_origin: string;
  zones_resolved: string; zones_referenced: number; ugc_codes: string[] | null;
  lat: number | null; lon: number | null; has_geometry: boolean;
  active_now: boolean;
}

/**
 * Filtering happens on the base table; geometry is resolved only for the rows
 * that survive.
 *
 * `v_alert_geometry` builds each row's shape with a correlated ST_Union over
 * cached zone polygons, so selecting from it and filtering afterwards paid that
 * cost for every candidate row -- a bbox query over the retained window took
 * 7.8 seconds. Restricting first and joining the view second computes the union
 * only for rows that will actually be returned.
 */
const SQL = `
WITH bounds AS (
  SELECT $1::timestamptz AS t_from, $2::timestamptz AS t_to,
         $3::timestamptz AS known, $4::timestamptz AS instant
),
candidates AS (
  SELECT a.alert_row_id, a.sent
    FROM alerts a
   CROSS JOIN bounds b
   WHERE a.status = 'Actual'
     AND a.ingest_time <= b.known
     AND COALESCE(a.onset, a.sent) <= b.t_to
     AND COALESCE(a.expires, a.ends, a.sent + interval '6 hours') >= b.t_from
     AND ($5::text[] IS NULL OR a.event_type = ANY($5))
     -- Active-at-instant is applied here rather than after the fact, so a
     -- still-running alert sent days ago cannot be cut by the row limit.
     AND (NOT $6::boolean OR (
           COALESCE(a.onset, a.sent) <= b.instant
           AND COALESCE(a.expires, a.ends, a.sent + interval '6 hours') > b.instant))
     -- The spatial test runs against the BASE tables, both of which carry a
     -- GiST index, rather than against the view's per-row zone union. Same
     -- answer, and it never materialises a shape: 7.7 s to 0.2 s.
     AND ($8::float8 IS NULL OR (
           CASE WHEN a.geom IS NOT NULL
                -- Precedence matters and must match the view's COALESCE: when a
                -- product ships its own polygon that IS its area, and the zone
                -- codes are only the coding. Testing polygon OR zones instead
                -- returned 41 rows where the view returns 38 -- three alerts
                -- whose polygon sits outside the box but whose coarser zones
                -- clip it. Over-inclusive, and inconsistent with what the map
                -- would draw.
                THEN ST_Intersects(
                       a.geom, ST_MakeEnvelope($10, $8, $11, $9, 4326)::geography)
                ELSE EXISTS (SELECT 1 FROM nws_zones z
                              WHERE z.zone_id = ANY(a.ugc_codes) AND z.geom IS NOT NULL
                                AND ST_Intersects(
                                      z.geom, ST_MakeEnvelope($10, $8, $11, $9, 4326)::geography))
           END))
   ORDER BY a.sent DESC
   LIMIT $7
)
SELECT v.alert_row_id, v.alert_id, v.event_type, v.severity, v.message_type,
       v.headline, v.area_desc, v.sent, v.onset, v.ends, v.expires, v.ingest_time,
       v.source_url, v.geometry_origin, v.zones_resolved, v.zones_referenced, v.ugc_codes,
       v.zones_resolved > 0 OR v.geometry_origin = 'polygon' AS has_geometry,
       -- Guarded by a flag because reading v.geom forces the view's correlated
       -- ST_Union over cached zone polygons to materialise. Measured over 400
       -- alerts: 38 ms without the centroid, 2,255 ms with it. Postgres skips
       -- the union entirely when the column is never read.
       CASE WHEN $13::boolean THEN ST_Y(ST_Centroid(v.geom)::geometry) END AS lat,
       CASE WHEN $13::boolean THEN ST_X(ST_Centroid(v.geom)::geometry) END AS lon,
       -- "In force at the instant", not "in force now". onset is preferred over
       -- sent because some products are issued ahead of when they take effect.
       (COALESCE(v.onset, v.sent) <= b.instant
        AND COALESCE(v.expires, v.ends, v.sent + interval '6 hours') > b.instant) AS active_now
  FROM candidates c
  JOIN v_alert_geometry v ON v.alert_row_id = c.alert_row_id
 CROSS JOIN bounds b
 ORDER BY v.sent DESC
 LIMIT $12`;

async function handler(input: z.infer<typeof inputSchema>): Promise<Envelope<AlertRow>> {
  const params: TimeParams = {
    at: input.at, from: input.from, to: input.to, known_as_of: input.known_as_of,
  };
  // 7 days: NWS retains only ~7-14 days upstream, so a wider default would
  // promise history the provider does not have.
  const time = resolveTime(params, { defaultWindowHours: 168, instantWindowHours: 12 });
  const instant = time.at ?? time.to;
  const activeOnly = input.active_only ?? (input.from == null && input.to == null);
  const bbox = input.bbox ?? null;

  const limit = input.limit ?? 200;
  // Every filter, spatial included, now runs in the candidates CTE, so the
  // candidate set and the returned set are the same rows. No over-fetching,
  // and geometry is resolved only for what comes back.
  const candidateLimit = limit;

  const rows = await tq<Raw>(SQL, [
    time.from.toISOString(), time.to.toISOString(), time.knownAsOf.toISOString(),
    instant.toISOString(),
    input.event_types ?? null,
    activeOnly,
    candidateLimit,
    bbox?.min_lat ?? null, bbox?.max_lat ?? null, bbox?.min_lon ?? null, bbox?.max_lon ?? null,
    limit,
    // A bbox already pays for geometry, so returning the centroid is then free.
    input.include_geometry ?? bbox !== null,
  ]);

  // Which of these were CANCELLED rather than left to expire? The amendment
  // chain lives on alerts.references_ids, which the geometry view does not
  // carry, so it is a second lookup rather than a guess.
  const cancelled = new Set<string>();
  if (rows.length > 0) {
    const chain = await tq<{ referenced: string }>(
      `SELECT DISTINCT unnest(references_ids) AS referenced
         FROM alerts
        WHERE message_type = 'Cancel' AND status = 'Actual'
          AND references_ids && $1::text[]`,
      [rows.map((r) => r.alert_id)],
    );
    for (const c of chain) cancelled.add(c.referenced);
  }

  let data: AlertRow[] = rows.map((r) => ({
    record_id: recordId('alert', r.alert_row_id),
    alert_id: r.alert_id,
    event_type: r.event_type,
    severity: r.severity,
    message_type: r.message_type,
    headline: r.headline,
    area_desc: r.area_desc,
    sent: new Date(r.sent).toISOString(),
    onset: r.onset ? new Date(r.onset).toISOString() : null,
    ends: r.ends ? new Date(r.ends).toISOString() : null,
    expires: r.expires ? new Date(r.expires).toISOString() : null,
    ingest_time: new Date(r.ingest_time).toISOString(),
    source_url: r.source_url,
    geometry_origin: r.geometry_origin,
    has_geometry: r.has_geometry,
    zones_resolved: Number(r.zones_resolved),
    zones_referenced: r.zones_referenced,
    ugc_codes: r.ugc_codes,
    lat: r.lat == null ? null : Number(Number(r.lat).toFixed(4)),
    lon: r.lon == null ? null : Number(Number(r.lon).toFixed(4)),
    smoke_relevant: isSmokeRelevantEvent(r.event_type),
    cancelled: cancelled.has(r.alert_id),
    active_at_requested_time: r.active_now,
  }));

  if (input.smoke_relevant_only) data = data.filter((d) => d.smoke_relevant);

  // -- Caveats -------------------------------------------------------------
  const caveats: string[] = [
    'NWS alerts cover the United States only. The Canadian portion of scope ' +
      '(British Columbia, Alberta) has no advisory feed at all, so an absence of alerts ' +
      'there means no coverage, not no hazard.',
    'The provider retains roughly 7-14 days of alert history and then the data is gone ' +
      'upstream. This is the one feed that decays, so older periods cannot be recovered.',
  ];
  if (!(input.include_geometry ?? bbox !== null)) {
    caveats.push(
      'Alert coordinates were not resolved for this call (include_geometry was off), so ' +
        'lat/lon are null. The alert areas are described by area_desc and ugc_codes; ' +
        'request geometry explicitly if a location is needed.',
    );
  }
  const cancelledCount = data.filter((d) => d.cancelled).length;
  if (cancelledCount > 0) {
    caveats.push(
      `${cancelledCount} alert(s) here were CANCELLED by a later message rather than ` +
        'allowed to expire — they were lifted early. Do not describe their listed expiry ' +
        'as when the hazard ended.',
    );
  }
  const partial = data.filter((d) => d.zones_referenced > 0 && d.zones_resolved < d.zones_referenced);
  if (partial.length > 0) {
    caveats.push(
      `${partial.length} alert(s) are only partially mapped: some referenced zones have no ` +
        'cached geometry, so the rendered area is smaller than the real one.',
    );
  }
  const zoneBuilt = data.filter((d) => d.geometry_origin === 'zones').length;
  if (zoneBuilt > 0) {
    caveats.push(
      `${zoneBuilt} alert(s) carried no polygon and are mapped from their zone codes ` +
        'instead. Zone boundaries are coarser than a product polygon would be.',
    );
  }
  if (activeOnly) {
    caveats.push(
      `Filtered to alerts in force at ${instant.toISOString()}. Very few alerts are ` +
        'active at any given moment in this region — across the retained window there ' +
        'are 901 actual alerts but typically only a handful in force at once, so an ' +
        'empty result is normal rather than a data problem.',
    );
  }

  return buildEnvelope<AlertRow>({
    data,
    recordIds: data.map((d) => d.record_id),
    sources: await sourceRefs(['nws_alerts']),
    eventTimes: data.map((d) => d.sent),
    ingestTimes: data.map((d) => d.ingest_time),
    asOf: time.to,
    knownAsOf: time.knownAsOf,
    knownAsOfApplied: true,
    stalenessSeconds: await stalenessFor('nws_alerts'),
    gaps: null,
    conflicts: null,
    caveats,
  });
}

export const getAlerts: ToolDefinition<typeof inputSchema, AlertRow> = {
  name: 'get_alerts',
  description:
    'Official NWS alerts, warnings and advisories — the only feed carrying human ' +
    'judgement, and one that can disagree with both sensors and the model. Queries what ' +
    'was in force at a requested moment, not only now, which is what makes it useful over ' +
    'the timeline. Distinguishes alerts that were cancelled early from those that expired. ' +
    `Smoke-relevant event types include: ${SMOKE_RELEVANT_EVENTS.slice(0, 6).join(', ')}. ` +
    'US only: there is no Canadian equivalent.',
  inputSchema,
  handler,
};
