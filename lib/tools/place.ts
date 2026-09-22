/**
 * Turning words into places, and cells back into words.
 *
 * Two jobs, both governed by the same finding. Decision 3u measured what
 * happens when you label a location by the nearest named region: it named a
 * NEIGHBOURING zone rather than the containing one 223 times out of 358,
 * including fires in Mexico and Canada given US place names. So nothing here
 * labels by proximity. A place gets a name when the name provably contains it,
 * and otherwise it is described by coordinates.
 *
 * The gazetteer is deliberately local -- station names and localities, NWS zone
 * names, fire cluster labels. An external geocoder would resolve places we hold
 * no data for, returning a confident coordinate attached to an empty answer,
 * which is worse than saying we do not cover it.
 */

import { cellToLatLng } from 'h3-js';
import { BBOX } from '../scope';
import { tq } from './sql';

export interface BBox {
  min_lat: number;
  max_lat: number;
  min_lon: number;
  max_lon: number;
}

export type PlaceKind = 'nws_zone' | 'station_locality' | 'station' | 'fire_cluster';

export interface PlaceCandidate {
  record_id: string;
  kind: PlaceKind;
  name: string;
  /** Zone id, station id or cluster key -- what the name resolves to upstream. */
  ref_id: string | null;
  lat: number;
  lon: number;
  bbox: BBox;
  region: string | null;
  /** How many air-quality stations we hold for this place. Zero is meaningful. */
  station_count: number;
  match: 'exact' | 'prefix' | 'contains';
  confidence: number;
  evidence: string;
  in_scope: boolean;
}

/** LIKE wildcards in user text would silently widen the match. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function inScope(lat: number, lon: number): boolean {
  return (
    lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon
  );
}

interface RawCandidate {
  kind: PlaceKind;
  name: string;
  ref_id: string | null;
  lat: number;
  lon: number;
  min_lat: number;
  max_lat: number;
  min_lon: number;
  max_lon: number;
  region: string | null;
  station_count: string;
}

/**
 * One round trip over the four naming layers we actually hold.
 *
 * Station-name matching is restricted to selected stations: the roster holds
 * 3,317 stations but only 800 are sampled for wind and model AQ, so resolving
 * to an unselected one would hand back a place with no supporting data.
 */
const GAZETTEER_SQL = `
WITH q AS (SELECT lower(btrim($1::text)) AS norm)
, zone AS (
    SELECT 'nws_zone'::text AS kind, z.name, z.zone_id AS ref_id,
           ST_Y(ST_Centroid(z.geom)::geometry) AS lat,
           ST_X(ST_Centroid(z.geom)::geometry) AS lon,
           ST_YMin(z.geom::geometry) AS min_lat, ST_YMax(z.geom::geometry) AS max_lat,
           ST_XMin(z.geom::geometry) AS min_lon, ST_XMax(z.geom::geometry) AS max_lon,
           z.state AS region,
           (SELECT count(*) FROM aq_stations s
             WHERE s.selected AND ST_Covers(z.geom, s.geom)) AS station_count
      FROM nws_zones z, q
     WHERE z.fetch_status = 'ok' AND z.geom IS NOT NULL
       AND lower(z.name) LIKE '%' || q.norm || '%' ESCAPE '\\'
     LIMIT 25
)
, locality AS (
    SELECT 'station_locality'::text, s.locality, NULL::text,
           avg(s.lat), avg(s.lon),
           min(s.lat), max(s.lat), min(s.lon), max(s.lon),
           NULL::text, count(*)
      FROM aq_stations s, q
     WHERE s.locality IS NOT NULL AND s.locality NOT IN ('N/A', 'AIR')
       AND lower(s.locality) LIKE '%' || q.norm || '%' ESCAPE '\\'
     GROUP BY s.locality
     LIMIT 25
)
, station AS (
    SELECT 'station'::text, s.name, s.station_id,
           s.lat, s.lon, s.lat, s.lat, s.lon, s.lon,
           s.country, 1::bigint
      FROM aq_stations s, q
     WHERE s.selected AND s.name IS NOT NULL
       AND lower(s.name) LIKE '%' || q.norm || '%' ESCAPE '\\'
     LIMIT 25
)
, cluster AS (
    SELECT 'fire_cluster'::text, c.label, c.cluster_key,
           ST_Y(c.centroid::geometry), ST_X(c.centroid::geometry),
           ST_YMin(c.bbox::geometry), ST_YMax(c.bbox::geometry),
           ST_XMin(c.bbox::geometry), ST_XMax(c.bbox::geometry),
           c.region, 0::bigint
      FROM fire_clusters c, q
     WHERE c.label IS NOT NULL AND c.is_active
       AND lower(c.label) LIKE '%' || q.norm || '%' ESCAPE '\\'
     LIMIT 25
)
SELECT kind, name, ref_id, lat, lon, min_lat, max_lat, min_lon, max_lon, region, station_count
  FROM (
    SELECT * FROM zone
    UNION ALL SELECT * FROM locality
    UNION ALL SELECT * FROM station
    UNION ALL SELECT * FROM cluster
  ) all_matches
 WHERE lat IS NOT NULL AND lon IS NOT NULL`;

/** Kind precedence when scores tie: a polygon beats a point. */
const KIND_WEIGHT: Record<PlaceKind, number> = {
  nws_zone: 0.12,
  station_locality: 0.08,
  fire_cluster: 0.04,
  station: 0.0,
};

/**
 * Natural language brings filler with it. "the Sierra" matched nothing against
 * zone names containing "Sierra", because a substring search is literal about
 * the article. Stripping leading articles and, failing that, retrying on the
 * longest significant word turns "near Yosemite" and "the Sierra" into hits
 * without loosening the match rule itself.
 */
const FILLER = /^(the|a|an|near|around|in|at|by)\s+/i;

export function normaliseQuery(raw: string): string {
  let s = raw.trim().toLowerCase();
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(FILLER, '').trim();
  }
  return s;
}

function longestToken(s: string): string | null {
  const tokens = s.split(/[^a-z0-9]+/i).filter((t) => t.length > 3);
  if (tokens.length === 0) return null;
  return tokens.reduce((a, b) => (b.length > a.length ? b : a));
}

export async function resolvePlaceCandidates(
  queryText: string,
  limit: number,
): Promise<PlaceCandidate[]> {
  const norm = normaliseQuery(queryText);
  if (norm.length === 0) return [];

  let rows = await tq<RawCandidate>(GAZETTEER_SQL, [escapeLike(norm)]);
  let matchedOn = norm;

  // Only widen when the phrase itself found nothing -- a fallback that always
  // ran would let a weak token match outrank a good phrase match.
  if (rows.length === 0) {
    const token = longestToken(norm);
    if (token && token !== norm) {
      rows = await tq<RawCandidate>(GAZETTEER_SQL, [escapeLike(token)]);
      matchedOn = token;
    }
  }

  const scored = rows.map((r): PlaceCandidate => {
    const name = r.name ?? '';
    const lower = name.toLowerCase();
    const match: PlaceCandidate['match'] =
      lower === matchedOn ? 'exact' : lower.startsWith(matchedOn) ? 'prefix' : 'contains';

    const base = match === 'exact' ? 0.9 : match === 'prefix' ? 0.7 : 0.5;
    const stations = Number(r.station_count);
    // More supporting stations means more of the answer is measured rather
    // than modelled, so it is a tiebreak on usefulness, not on correctness.
    const support = Math.min(0.1, stations * 0.01);
    const lat = Number(r.lat);
    const lon = Number(r.lon);

    // A one-station bbox is a point; give it enough extent to be queryable.
    const pad = r.kind === 'station' ? 0.15 : 0;

    return {
      record_id: `place:${r.kind}:${r.ref_id ?? name}`,
      kind: r.kind,
      name,
      ref_id: r.ref_id,
      lat,
      lon,
      bbox: {
        min_lat: Number(r.min_lat) - pad,
        max_lat: Number(r.max_lat) + pad,
        min_lon: Number(r.min_lon) - pad,
        max_lon: Number(r.max_lon) + pad,
      },
      region: r.region,
      station_count: stations,
      match,
      confidence: Math.min(1, base + support + KIND_WEIGHT[r.kind]),
      evidence:
        `${match} match on ${r.kind.replace('_', ' ')} name "${name}"` +
        (stations > 0 ? `; ${stations} selected air-quality station(s) here` : '; no stations here'),
      in_scope: inScope(lat, lon),
    };
  });

  scored.sort((a, b) => b.confidence - a.confidence || b.station_count - a.station_count);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Cells back to words
// ---------------------------------------------------------------------------

export interface CellLabel {
  h3_r4: string;
  lat: number;
  lon: number;
  /** Null when no zone contains the cell centre. Never a nearest-neighbour guess. */
  zone_name: string | null;
  zone_id: string | null;
  state: string | null;
  /** Always present: what to say when there is no name. */
  description: string;
}

/**
 * Label cells by the zone that CONTAINS them, or not at all.
 *
 * Coverage is bounded by the zone cache -- 429 zones, being those an alert
 * happened to reference -- so most cells come back unnamed. That is the
 * intended trade: Decision 3u took correct labels over broad ones.
 */
export async function labelCells(cells: string[]): Promise<Map<string, CellLabel>> {
  const out = new Map<string, CellLabel>();
  if (cells.length === 0) return out;

  const centres = cells.map((c) => {
    const [lat, lon] = cellToLatLng(c);
    return { c, lat, lon };
  });

  // One LATERAL rather than three correlated subqueries: the first version ran
  // the same containment search three times per cell, which cost 2.0 s over the
  // 1,111 cells the frames use. This is the same answer in a third of the work.
  const rows = await tq<{
    h3: string;
    zone_name: string | null;
    zone_id: string | null;
    state: string | null;
  }>(
    `WITH pts AS (
       SELECT c.h3, ST_SetSRID(ST_MakePoint(c.lon, c.lat), 4326)::geography AS g
         FROM unnest($1::text[], $2::float8[], $3::float8[]) AS c(h3, lat, lon)
     )
     SELECT p.h3, z.name AS zone_name, z.zone_id, z.state
       FROM pts p
       LEFT JOIN LATERAL (
         SELECT zz.name, zz.zone_id, zz.state
           FROM nws_zones zz
          WHERE zz.fetch_status = 'ok' AND zz.geom IS NOT NULL
            AND ST_Covers(zz.geom, p.g)
          ORDER BY zz.zone_type = 'public' DESC
          LIMIT 1
       ) z ON true`,
    [centres.map((x) => x.c), centres.map((x) => x.lat), centres.map((x) => x.lon)],
  );

  const byCell = new Map(rows.map((r) => [r.h3, r]));
  for (const { c, lat, lon } of centres) {
    const hit = byCell.get(c);
    const zone = hit?.zone_name ?? null;
    out.set(c, {
      h3_r4: c,
      lat,
      lon,
      zone_name: zone,
      zone_id: hit?.zone_id ?? null,
      state: hit?.state ?? null,
      description: zone
        ? `${zone}${hit?.state ? ` (${hit.state})` : ''}`
        : `unnamed area near ${lat.toFixed(2)}, ${lon.toFixed(2)}`,
    });
  }
  return out;
}
