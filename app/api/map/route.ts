/**
 * GET /api/map?at=<iso> -- every layer the map draws, for one moment.
 *
 * One route rather than three because the map redraws as a unit when the
 * timeline moves: three requests would tear, showing fires from one moment
 * beside stations from another, and on a scrub that is worse than being slow.
 *
 * Distinct from /api/tools/* on purpose. Those return the provenance envelope
 * for the agent and the evidence drawer; this returns geometry for rendering.
 * Same database, different job -- a map layer does not need caveats attached
 * to every point, and the agent does not need simplified polygons.
 */

import type { NextRequest } from 'next/server';
import { tq } from '@/lib/tools/sql';

export const maxDuration = 30;

interface FirePoint {
  cluster_key: string;
  record_id: string;
  label: string | null;
  source_character: string;
  lat: number;
  lon: number;
  total_frp_mw: number | null;
  frp_24h: number | null;
  detection_count: number;
  last_event_time: string;
}

interface StationPoint {
  station_id: string;
  record_id: string;
  name: string | null;
  lat: number;
  lon: number;
  instrument_tier: string;
  pm25: number | null;
  event_time: string;
  /** Hours between the reading and the requested moment. */
  age_hours: number;
}

export async function GET(req: NextRequest) {
  const atParam = req.nextUrl.searchParams.get('at');
  const at = atParam ? new Date(atParam) : new Date();
  if (Number.isNaN(at.getTime())) {
    return Response.json({ error: '`at` must be ISO 8601.' }, { status: 400 });
  }
  const iso = at.toISOString();
  const started = Date.now();

  const [fires, stations, alerts] = await Promise.all([
    // Burning at the moment, not merely known now: a fire that ignited later
    // must not appear when the timeline is scrubbed back before it started.
    tq<FirePoint>(
      `SELECT cluster_key, 'fire_cluster:' || cluster_id AS record_id, label,
              source_character,
              ST_Y(centroid::geometry) AS lat, ST_X(centroid::geometry) AS lon,
              total_frp_mw, frp_24h, detection_count,
              last_event_time
         FROM v_fire_clusters_active
        WHERE first_event_time <= $1::timestamptz
          AND last_event_time >= $1::timestamptz - interval '48 hours'
        ORDER BY total_frp_mw DESC NULLS LAST
        LIMIT 400`,
      [iso],
    ),

    // Latest reading per station at or before the moment. DISTINCT ON over
    // ingest_time honours the append-only revision model rather than showing
    // a value that was later corrected.
    tq<StationPoint>(
      `WITH latest AS (
         SELECT DISTINCT ON (m.station_id)
                m.station_id, m.value, m.event_time
           FROM aq_measurements m
          WHERE m.parameter = 'pm25'
            AND m.event_time <= $1::timestamptz
            AND m.event_time > $1::timestamptz - interval '12 hours'
          ORDER BY m.station_id, m.event_time DESC, m.ingest_time DESC
       )
       SELECT l.station_id, 'aq_station:' || l.station_id AS record_id,
              s.name, s.lat, s.lon, s.instrument_tier,
              l.value AS pm25, l.event_time,
              round(extract(epoch FROM ($1::timestamptz - l.event_time)) / 3600.0, 1) AS age_hours
         FROM latest l
         JOIN aq_stations s ON s.station_id = l.station_id
        WHERE s.selected AND s.lat IS NOT NULL`,
      [iso],
    ),

    // Simplified geometry: full-fidelity zone polygons total 672,000 points
    // across the cache, which is a map that will not pan. 0.01 degrees is
    // roughly a kilometre -- invisible at the zoom this renders at.
    tq<{ record_id: string; event_type: string; severity: string | null; headline: string | null; geojson: string }>(
      `SELECT 'alert:' || v.alert_row_id AS record_id, v.event_type, v.severity, v.headline,
              ST_AsGeoJSON(ST_SimplifyPreserveTopology(v.geom::geometry, 0.01)) AS geojson
         FROM v_alert_geometry v
        WHERE v.status = 'Actual'
          AND v.geom IS NOT NULL
          AND COALESCE(v.onset, v.sent) <= $1::timestamptz
          AND COALESCE(v.expires, v.ends, v.sent + interval '6 hours') > $1::timestamptz
        LIMIT 200`,
      [iso],
    ),
  ]);

  return Response.json(
    {
      at: iso,
      fires: fires.map((f) => ({ ...f, lat: Number(f.lat), lon: Number(f.lon) })),
      stations: stations.map((s) => ({
        ...s, lat: Number(s.lat), lon: Number(s.lon),
        pm25: s.pm25 == null ? null : Number(s.pm25),
        age_hours: Number(s.age_hours),
      })),
      alerts: alerts.map((a) => ({
        record_id: a.record_id, event_type: a.event_type,
        severity: a.severity, headline: a.headline,
        geometry: JSON.parse(a.geojson) as unknown,
      })),
      counts: { fires: fires.length, stations: stations.length, alerts: alerts.length },
      elapsed_ms: Date.now() - started,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
