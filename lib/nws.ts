/**
 * NWS alerts: parsing, pagination, and lazy zone-geometry resolution.
 *
 * Shaped by inspection of a real 200-feature payload:
 *   - 62% carry a `Polygon` (NOT MultiPolygon -- coerced with ST_Multi on insert)
 *   - 38% carry NULL geometry and are zone-coded, and EVERY air-quality or
 *     fire-weather alert sampled was in that group
 *   - `id` is unique per MESSAGE; amendments arrive as new messages with
 *     `references` to the prior one
 *   - `status` may be 'Test' (5 of 200) -- retained, filtered at query time
 *   - responses are always paginated via `pagination.next`
 */

import type { PoolClient } from 'pg';

const NWS_BASE = 'https://api.weather.gov';

function userAgent(): string {
  const ua = process.env.NWS_USER_AGENT;
  if (!ua || ua.includes('your-email')) {
    throw new Error(
      'NWS_USER_AGENT must be set to a self-identifying string — NWS rejects ' +
        'generic clients. Example: (downwind, you@example.com)',
    );
  }
  return ua;
}

export interface AlertRow {
  alertId: string;
  eventType: string;
  severity: string | null;
  urgency: string | null;
  certainty: string | null;
  status: string | null;
  messageType: string | null;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  areaDesc: string | null;
  ugcCodes: string[];
  sameCodes: string[];
  referencesIds: string[];
  /** GeoJSON geometry as published, or null when the alert is zone-coded. */
  geometry: unknown | null;
  sent: Date;
  effective: Date | null;
  onset: Date | null;
  ends: Date | null;
  expires: Date | null;
  sourceUrl: string | null;
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || v === '') return null;
  const d = new Date(v);              // ISO-8601 with offset; JS handles the TZ
  return Number.isNaN(d.getTime()) ? null : d;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function parseAlertFeature(feature: Record<string, unknown>): AlertRow | null {
  const p = feature.properties as Record<string, unknown> | undefined;
  if (!p) return null;

  const alertId = typeof p.id === 'string' ? p.id : null;
  const eventType = typeof p.event === 'string' ? p.event : null;
  const sent = parseDate(p.sent);
  // Without an id, an event type or a send time the record cannot be
  // identified, classified or placed on the timeline.
  if (!alertId || !eventType || !sent) return null;

  const geocode = (p.geocode ?? {}) as Record<string, unknown>;
  const refs = Array.isArray(p.references) ? p.references : [];

  return {
    alertId,
    eventType,
    severity: typeof p.severity === 'string' ? p.severity : null,
    urgency: typeof p.urgency === 'string' ? p.urgency : null,
    certainty: typeof p.certainty === 'string' ? p.certainty : null,
    status: typeof p.status === 'string' ? p.status : null,
    messageType: typeof p.messageType === 'string' ? p.messageType : null,
    headline: typeof p.headline === 'string' ? p.headline : null,
    description: typeof p.description === 'string' ? p.description : null,
    instruction: typeof p.instruction === 'string' ? p.instruction : null,
    areaDesc: typeof p.areaDesc === 'string' ? p.areaDesc : null,
    ugcCodes: strArray(geocode.UGC),
    sameCodes: strArray(geocode.SAME),
    referencesIds: refs
      .map((r) => (r as Record<string, unknown>)?.identifier)
      .filter((x): x is string => typeof x === 'string'),
    geometry: feature.geometry ?? null,
    sent,
    effective: parseDate(p.effective),
    onset: parseDate(p.onset),
    ends: parseDate(p.ends),
    expires: parseDate(p.expires),
    sourceUrl:
      typeof p['@id'] === 'string' ? (p['@id'] as string)
      : typeof p.web === 'string' ? (p.web as string)
      : null,
  };
}

async function getJson(url: string, timeoutMs = 45_000): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': userAgent(), Accept: 'application/geo+json' },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Follow `pagination.next` to exhaustion. Every observed response carried a
 * next link, so a single un-paginated request would silently truncate.
 */
export async function fetchAlertsPaged(
  firstUrl: string,
  maxPages = 25,
): Promise<{ features: Record<string, unknown>[]; pages: number; truncated: boolean }> {
  const features: Record<string, unknown>[] = [];
  let url: string | null = firstUrl;
  let pages = 0;

  while (url && pages < maxPages) {
    const body = await getJson(url);
    const batch = Array.isArray(body.features)
      ? (body.features as Record<string, unknown>[]) : [];
    features.push(...batch);
    pages++;

    const next = (body.pagination as Record<string, unknown> | undefined)?.next;
    // An empty page with a next cursor means the window is exhausted; NWS
    // keeps offering a cursor regardless, so stop on an empty batch.
    url = typeof next === 'string' && batch.length > 0 ? next : null;
  }

  return { features, pages, truncated: url !== null };
}

// ---------------------------------------------------------------------------
// Zone geometry, resolved lazily and cached forever
// ---------------------------------------------------------------------------

/**
 * Candidate zone types to try, in order, for a given zone id.
 *
 * A single type cannot be inferred from the id. The third character narrows it
 * ('Z' = zone, 'C' = county) but a Z-prefixed id may be a PUBLIC forecast zone
 * OR a FIRE WEATHER zone, served on different paths -- and fire zones are a
 * different geography entirely (BLM districts, National Forests: 'Burns BLM',
 * 'Northern Boise National Forest').
 *
 * This matters disproportionately here: Red Flag Warnings and Fire Weather
 * Watches -- the most smoke-relevant products in the feed -- are issued
 * against FIRE zones. Trying only 'forecast' silently loses geometry for
 * exactly the alerts this system exists to reason about.
 *
 * The API exposes five types: public (1058), fire (950), county (674),
 * coastal (240), offshore (78). 'forecast' is a path alias for 'public'.
 */
export function zoneTypeCandidates(zoneId: string): string[] {
  switch (zoneId.charAt(2)) {
    case 'Z': return ['forecast', 'fire', 'coastal', 'offshore'];
    case 'C': return ['county'];
    default:  return ['forecast', 'fire', 'county'];
  }
}

export interface ZoneResolution {
  requested: number;
  alreadyCached: number;
  fetched: number;
  notFound: number;
  errored: number;
}

/**
 * Ensure every given zone id has a cached geometry, fetching only the unknown
 * ones. A zone that cannot be resolved is recorded with fetch_status so it is
 * not retried on every subsequent run, and so the resulting map gap is
 * explainable rather than mysterious.
 */
export async function ensureZonesCached(
  client: PoolClient,
  zoneIds: string[],
  opts: { simplifyMetres?: number; maxFetch?: number; retryFailed?: boolean } = {},
): Promise<ZoneResolution> {
  const simplify = opts.simplifyMetres ?? 300;
  const maxFetch = opts.maxFetch ?? 400;
  const unique = [...new Set(zoneIds.filter((z) => z && z.length >= 3))];

  const res: ZoneResolution = {
    requested: unique.length, alreadyCached: 0, fetched: 0, notFound: 0, errored: 0,
  };
  if (unique.length === 0) return res;

  // Only zones already resolved OK count as known. Previously-failed zones are
  // retried when retryFailed is set, which is how the fire-zone fix backfills.
  const known = await client.query<{ zone_id: string }>(
    opts.retryFailed
      ? `SELECT zone_id FROM nws_zones WHERE zone_id = ANY($1) AND fetch_status = 'ok'`
      : `SELECT zone_id FROM nws_zones WHERE zone_id = ANY($1)`,
    [unique],
  );
  const knownSet = new Set(known.rows.map((r) => r.zone_id));
  res.alreadyCached = knownSet.size;

  const missing = unique.filter((z) => !knownSet.has(z)).slice(0, maxFetch);

  for (const zoneId of missing) {
    const candidates = zoneTypeCandidates(zoneId);
    let stored = false;
    const attempts: string[] = [];

    for (const zoneType of candidates) {
      try {
        const z = await getJson(`${NWS_BASE}/zones/${zoneType}/${zoneId}`);
        const geom = z.geometry;
        const props = (z.properties ?? {}) as Record<string, unknown>;

        if (!geom) {
          attempts.push(`${zoneType}: 200 but no geometry`);
          continue;
        }

        await client.query(
          `INSERT INTO nws_zones
             (zone_id, zone_type, name, state, geom, geom_simple, point_count, fetch_status)
           VALUES (
             $1,$2,$3,$4,
             ST_Multi(ST_GeomFromGeoJSON($5))::geography,
             ST_Multi(ST_SimplifyPreserveTopology(ST_GeomFromGeoJSON($5), $6))::geography,
             ST_NPoints(ST_GeomFromGeoJSON($5)),
             'ok')
           ON CONFLICT (zone_id) DO UPDATE SET
             zone_type = EXCLUDED.zone_type, name = EXCLUDED.name, state = EXCLUDED.state,
             geom = EXCLUDED.geom, geom_simple = EXCLUDED.geom_simple,
             point_count = EXCLUDED.point_count, fetch_status = 'ok',
             fetch_error = NULL, fetched_at = now()`,
          [zoneId, zoneType, props.name ?? null, props.state ?? null,
           JSON.stringify(geom), simplify / 111_320],   // metres -> approx degrees
        );
        res.fetched++;
        stored = true;
        break;
      } catch (err) {
        // A 404 just means "not this type" -- keep walking the chain.
        attempts.push(`${zoneType}: ${(err instanceof Error ? err.message : String(err)).slice(0, 60)}`);
      }
    }

    if (!stored) {
      // Genuinely unresolvable (e.g. BCZ* -- British Columbia zones that NWS
      // references for border coordination but does not serve geometry for).
      // Recorded so it is not retried every run AND so the map gap is explainable.
      res.notFound++;
      await client.query(
        `INSERT INTO nws_zones (zone_id, zone_type, fetch_status, fetch_error)
         VALUES ($1,'unknown','not_found',$2)
         ON CONFLICT (zone_id) DO UPDATE SET
           fetch_status='not_found', fetch_error=EXCLUDED.fetch_error, fetched_at=now()`,
        [zoneId, attempts.join(' | ').slice(0, 500)],
      );
    }
  }

  return res;
}

export { NWS_BASE };
