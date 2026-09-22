/**
 * GET /api/record/:id -- one cited record, with a link to where it came from.
 *
 * This is the end of the evidence chain the brief asks for: a claim carries
 * record ids, each id resolves here to the actual stored row, and the row
 * carries the upstream URL it was read from. Claim -> record -> source, with
 * nothing taken on trust in between.
 *
 * Ids are shaped `<entity>:<primary key>` (lib/tools/envelope.ts). The entity
 * decides the query, so an unknown prefix is a 404 rather than a guess.
 */

import type { NextRequest } from 'next/server';
import { tq1 } from '@/lib/tools/sql';

export const maxDuration = 30;

interface Resolver {
  sql: string;
  /** Where this record came from upstream, when the row does not carry it. */
  fallbackUrl?: string;
}

const FIRMS_DOCS = 'https://firms.modaps.eosdis.nasa.gov/api/area/';
const OPENAQ_DOCS = 'https://docs.openaq.org/';
const NWS_DOCS = 'https://www.weather.gov/documentation/services-web-api';
const METEO_DOCS = 'https://open-meteo.com/en/docs';

const RESOLVERS: Record<string, Resolver> = {
  aq_measurement: {
    sql: `SELECT m.*, s.name AS station_name, s.provider, s.instrument_tier,
                 s.lat, s.lon, s.metadata_source
            FROM aq_measurements m
            JOIN aq_stations s ON s.station_id = m.station_id
           WHERE m.measurement_id = $1::bigint`,
    fallbackUrl: OPENAQ_DOCS,
  },
  aq_station: {
    sql: `SELECT * FROM aq_stations WHERE station_id = $1`,
    fallbackUrl: OPENAQ_DOCS,
  },
  model_aq: {
    sql: `SELECT * FROM model_aq_hourly WHERE model_aq_id = $1::bigint`,
    fallbackUrl: 'https://open-meteo.com/en/docs/air-quality-api',
  },
  weather: {
    sql: `SELECT * FROM weather_hourly WHERE weather_id = $1::bigint`,
    fallbackUrl: METEO_DOCS,
  },
  fire_detection: {
    sql: `SELECT detection_id, source_id, observation_key, lat, lon, event_time,
                 ingest_time, frp_mw, brightness_ti4, brightness_ti5, confidence,
                 satellite, instrument, daynight, proc_version, cluster_id
            FROM fire_detections WHERE detection_id = $1::bigint`,
    fallbackUrl: FIRMS_DOCS,
  },
  fire_cluster: {
    sql: `SELECT cluster_id, cluster_key, label, label_source, source_character,
                 first_event_time, last_event_time, detection_count, total_frp_mw,
                 max_frp_mw, mean_confidence, low_confidence_share, frp_cv,
                 footprint_spread_m, duration_days, region, method_version, computed_at,
                 ST_Y(centroid::geometry) AS lat, ST_X(centroid::geometry) AS lon
            FROM fire_clusters WHERE cluster_id = $1::bigint`,
    fallbackUrl: FIRMS_DOCS,
  },
  alert: {
    sql: `SELECT alert_row_id, alert_id, event_type, severity, urgency, certainty,
                 status, message_type, headline, description, instruction, area_desc,
                 ugc_codes, same_codes, sent, onset, effective, ends, expires,
                 ingest_time, source_url, references_ids
            FROM alerts WHERE alert_row_id = $1::bigint`,
    fallbackUrl: NWS_DOCS,
  },
  smoke_attribution: {
    sql: `SELECT a.*, c.cluster_key, c.label AS cluster_label
            FROM smoke_attributions a
            JOIN fire_clusters c ON c.cluster_id = a.cluster_id
           WHERE a.attribution_id = $1::bigint`,
    fallbackUrl: FIRMS_DOCS,
  },
  nws_zone: {
    sql: `SELECT zone_id, zone_type, name, state, point_count, fetch_status, fetched_at
            FROM nws_zones WHERE zone_id = $1`,
    fallbackUrl: NWS_DOCS,
  },
  source: {
    sql: `SELECT * FROM sources WHERE source_id = $1`,
  },
};

export async function GET(_req: NextRequest, ctx: RouteContext<'/api/record/[id]'>) {
  const { id } = await ctx.params;
  const decoded = decodeURIComponent(id);
  const sep = decoded.indexOf(':');
  if (sep < 0) {
    return Response.json({ error: 'Record ids are shaped "<entity>:<key>".' }, { status: 400 });
  }

  const entity = decoded.slice(0, sep);
  const key = decoded.slice(sep + 1);

  // Frames are keyed by (time, cell) rather than a single column, and are
  // derived rather than observed -- so they resolve to the rollup row, which
  // is honest about being computed.
  if (entity === 'frame') {
    const lastColon = key.lastIndexOf(':');
    const frameTime = key.slice(0, lastColon);
    const cell = key.slice(lastColon + 1);
    const row = await tq1(
      `SELECT * FROM hourly_frames WHERE frame_time = $1::timestamptz AND h3_r4 = $2`,
      [frameTime, cell],
    );
    if (!row) return Response.json({ error: `No frame ${decoded}.` }, { status: 404 });
    return Response.json({
      record_id: decoded, entity, record: row,
      note: 'A derived rollup, recomputed from raw observations rather than observed directly.',
    });
  }

  // Places are resolved from metadata at query time, not stored as rows.
  if (entity === 'place') {
    return Response.json({
      record_id: decoded, entity, record: { resolved_from: key },
      note: 'Places are resolved from station, zone and cluster names at query time; there is no stored place record.',
    });
  }

  const resolver = RESOLVERS[entity];
  if (!resolver) {
    return Response.json(
      { error: `Unknown record type "${entity}".`, known: Object.keys(RESOLVERS) },
      { status: 404 },
    );
  }

  const record = await tq1<Record<string, unknown>>(resolver.sql, [key]);
  if (!record) {
    return Response.json({ error: `No ${entity} with key "${key}".` }, { status: 404 });
  }

  return Response.json({
    record_id: decoded,
    entity,
    record,
    upstream_url: (record.source_url as string) ?? resolver.fallbackUrl ?? null,
  });
}
