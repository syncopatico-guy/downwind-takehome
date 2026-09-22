/**
 * OpenAQ v3 client.
 *
 * Shaped by probing the live API:
 *   * Rate limit is 60 requests / 60 seconds (advertised via x-ratelimit-*).
 *     This rules out per-sensor polling for the live path entirely.
 *   * /v3/parameters/{id}/latest is a genuine bulk endpoint -- 21,065 PM2.5
 *     readings globally, 1,000 per page, 22 pages in ~30s. It IGNORES `bbox`
 *     and `coordinates`/`radius`, so spatial filtering happens client-side,
 *     but it DOES honour `datetime_min` (21,065 -> 11,815), which we use to
 *     cut the payload.
 *   * /v3/sensors/{id}/hours returns a whole date range in ONE request
 *     (verified: 168/168 hourly values for 7 days), so backfill is one
 *     request per sensor rather than per hour.
 *   * `isMonitor` separates regulatory monitors from low-cost sensors.
 *   * "latest" includes long-dead sensors -- recency filtering is mandatory.
 */

import { BBOX } from './scope';

const BASE = 'https://api.openaq.org/v3';

/** Verified parameter ids. */
export const PARAM_IDS = { pm10: 1, pm25: 2 } as const;

function apiKey(): string {
  const k = process.env.OPENAQ_API_KEY;
  if (!k) {
    throw new Error(
      'OPENAQ_API_KEY is not set. Register free at https://explore.openaq.org — ' +
        'v2 is retired (HTTP 410), so v3 with a key is the only option.',
    );
  }
  return k;
}

/**
 * Sliding-window limiter.
 *
 * Replaces an earlier version that slept a flat `x-ratelimit-reset + 1`
 * seconds whenever the advertised quota ran low. That was wrong twice over:
 * `x-ratelimit-reset: 60` is the window LENGTH, not the seconds remaining in
 * it, so every near-exhaustion cost a flat 61-second stall; and the 429 retry
 * path slept the same 61s up to four times, so one unlucky request could burn
 * four minutes. At ~59 req/min that fired constantly and wedged a run for
 * twenty minutes with no output.
 *
 * This version tracks actual request timestamps and sleeps only until the
 * oldest one leaves the window -- so a burst runs at full speed and the
 * steady state settles naturally at the limit.
 */
class RateLimiter {
  private times: number[] = [];
  private readonly windowMs = 60_000;
  /** Headroom under the advertised 60/min, in case the server counts differently. */
  private readonly maxInWindow = 54;

  async wait(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.times = this.times.filter((t) => now - t < this.windowMs);
      if (this.times.length < this.maxInWindow) {
        this.times.push(now);
        return;
      }
      const sleepMs = this.windowMs - (now - this.times[0]) + 60;
      stats.rateLimitWaits++;
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  /** Server-advertised state, used only for observability. */
  observe(headers: Headers): void {
    const rem = Number(headers.get('x-ratelimit-remaining'));
    if (Number.isFinite(rem)) stats.lastRemaining = rem;
  }
}

const limiter = new RateLimiter();

export interface FetchStats {
  requests: number; retries: number; rateLimitWaits: number;
  rateLimit429s: number; lastRemaining: number | null;
}
export const stats: FetchStats = {
  requests: 0, retries: 0, rateLimitWaits: 0, rateLimit429s: 0, lastRemaining: null,
};

/**
 * Wall-clock budget. A long job must fail loudly rather than crawl: twenty
 * minutes of silence being indistinguishable from a hang was itself a bug.
 */
let deadline: number | null = null;
export function setBudget(minutes: number): void {
  deadline = Date.now() + minutes * 60_000;
}
export function clearBudget(): void { deadline = null; }
function checkBudget(): void {
  if (deadline !== null && Date.now() > deadline) {
    throw new Error(
      `wall-clock budget exhausted after ${stats.requests} requests ` +
      `(${stats.rateLimitWaits} rate-limit waits, ${stats.rateLimit429s} 429s)`,
    );
  }
}

async function get<T = Record<string, unknown>>(
  path: string, params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    checkBudget();
    await limiter.wait();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'X-API-Key': apiKey(), Accept: 'application/json' },
      });
      stats.requests++;
      limiter.observe(res.headers);

      if (res.status === 429) {
        // Should be rare now that the limiter paces properly. Honour
        // retry-after but cap it, so a bad header cannot stall the run.
        stats.rateLimit429s++;
        const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 30, 65);
        console.warn(`    [openaq] 429 — waiting ${retryAfter}s (attempt ${attempt + 1}/4)`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url.pathname}: ${text.slice(0, 200)}`);
      return JSON.parse(text) as T;
    } catch (err) {
      stats.retries++;
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`exhausted retries for ${url.pathname}`);
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

export interface OpenAqSensor { sensorId: number; parameter: string; units: string | null }

export interface OpenAqStation {
  upstreamId: number;
  name: string | null;
  locality: string | null;
  lat: number;
  lon: number;
  country: string | null;
  provider: string | null;
  ownerName: string | null;
  isMonitor: boolean | null;
  isMobile: boolean | null;
  instruments: string[];
  datetimeFirst: Date | null;
  datetimeLast: Date | null;
  sensors: OpenAqSensor[];
}

/**
 * `isMonitor` is the tier discriminator, corroborated by provider: AirNow
 * (regulatory) against Clarity / community networks. Averaging the two tiers
 * together would destroy exactly the disagreement this product exists to show.
 */
function tierOf(isMonitor: boolean | null): 'reference' | 'low_cost' | 'unknown' {
  if (isMonitor === true) return 'reference';
  if (isMonitor === false) return 'low_cost';
  return 'unknown';
}
export { tierOf };

function parseUtc(v: unknown): Date | null {
  const s = (v as Record<string, unknown> | undefined)?.utc;
  if (typeof s !== 'string') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseStation(r: Record<string, unknown>): OpenAqStation | null {
  const c = (r.coordinates ?? {}) as Record<string, unknown>;
  const lat = Number(c.latitude);
  const lon = Number(c.longitude);
  const id = Number(r.id);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(id)) return null;

  const sensors = (Array.isArray(r.sensors) ? r.sensors : [])
    .map((s) => {
      const sr = s as Record<string, unknown>;
      const p = (sr.parameter ?? {}) as Record<string, unknown>;
      const sid = Number(sr.id);
      const pname = typeof p.name === 'string' ? p.name : null;
      if (!Number.isFinite(sid) || !pname) return null;
      return { sensorId: sid, parameter: pname, units: typeof p.units === 'string' ? p.units : null };
    })
    .filter((s): s is OpenAqSensor => s !== null);

  return {
    upstreamId: id,
    name: typeof r.name === 'string' ? r.name : null,
    locality: typeof r.locality === 'string' ? r.locality : null,
    lat, lon,
    country: ((r.country ?? {}) as Record<string, unknown>).code as string ?? null,
    provider: ((r.provider ?? {}) as Record<string, unknown>).name as string ?? null,
    ownerName: ((r.owner ?? {}) as Record<string, unknown>).name as string ?? null,
    isMonitor: typeof r.isMonitor === 'boolean' ? r.isMonitor : null,
    isMobile: typeof r.isMobile === 'boolean' ? r.isMobile : null,
    instruments: (Array.isArray(r.instruments) ? r.instruments : [])
      .map((i) => (i as Record<string, unknown>).name)
      .filter((n): n is string => typeof n === 'string'),
    datetimeFirst: parseUtc(r.datetimeFirst),
    datetimeLast: parseUtc(r.datetimeLast),
    sensors,
  };
}

/** All fixed stations inside the scope bbox. Paginated; bbox IS honoured here. */
export async function fetchStationsInBbox(
  maxPages = 20,
): Promise<{ stations: OpenAqStation[]; pages: number; truncated: boolean }> {
  const bbox = `${BBOX.minLon},${BBOX.minLat},${BBOX.maxLon},${BBOX.maxLat}`;
  const stations: OpenAqStation[] = [];
  let page = 1;

  for (; page <= maxPages; page++) {
    const body = await get<{ results?: Record<string, unknown>[] }>('/locations', {
      bbox, limit: 1000, page,
    });
    const rows = body.results ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      const s = parseStation(r);
      if (s) stations.push(s);
    }
    if (rows.length < 1000) { page++; break; }
  }
  return { stations, pages: page - 1, truncated: page > maxPages };
}

/**
 * One station by upstream id.
 *
 * Needed because OpenAQ's endpoints disagree with each other: ~314 sensors
 * reporting fresh values in /parameters/{id}/latest are absent from the
 * /locations?bbox roster (most likely their /locations record omits the PM
 * sensor the latest feed reports). Rather than discard a fifth of live
 * coverage, unknown locations are fetched individually and added.
 */
export async function fetchStationById(upstreamId: number): Promise<OpenAqStation | null> {
  const body = await get<{ results?: Record<string, unknown>[] }>(`/locations/${upstreamId}`);
  const row = (body.results ?? [])[0];
  return row ? parseStation(row) : null;
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

export interface LatestReading {
  sensorId: number;
  locationId: number;
  value: number;
  eventTime: Date;
  lat: number;
  lon: number;
}

/**
 * Bulk latest readings for one parameter. The only viable live path under a
 * 60/min limit. `datetimeMin` is honoured server-side and roughly halves the
 * payload; `bbox` is NOT, so callers filter spatially themselves.
 */
export async function fetchLatestForParameter(
  parameterId: number, datetimeMin?: Date, maxPages = 40,
  onPage?: (page: number, rows: number, total: number) => void,
): Promise<{ readings: LatestReading[]; pages: number; truncated: boolean }> {
  const readings: LatestReading[] = [];
  let page = 1;

  for (; page <= maxPages; page++) {
    const body = await get<{ results?: Record<string, unknown>[] }>(
      `/parameters/${parameterId}/latest`,
      { limit: 1000, page, datetime_min: datetimeMin?.toISOString() },
    );
    const rows = body.results ?? [];
    if (rows.length === 0) break;
    onPage?.(page, rows.length, readings.length);

    for (const r of rows) {
      const c = (r.coordinates ?? {}) as Record<string, unknown>;
      const lat = Number(c.latitude), lon = Number(c.longitude);
      const value = Number(r.value);
      const eventTime = parseUtc(r.datetime);
      const sensorId = Number(r.sensorsId), locationId = Number(r.locationsId);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(value) ||
          !eventTime || !Number.isFinite(sensorId)) continue;
      readings.push({ sensorId, locationId, value, eventTime, lat, lon });
    }
    if (rows.length < 1000) { page++; break; }
  }
  return { readings, pages: page - 1, truncated: page > maxPages };
}

export interface HourlyReading {
  eventTime: Date;
  value: number;
  /** OpenAQ's own suspect-data flag. Available ONLY on this endpoint, not on
   *  the bulk latest one -- an asymmetry the schema records honestly as null. */
  hasFlags: boolean | null;
}

/** Hourly history for one sensor. One request covers the whole range. */
export async function fetchSensorHours(
  sensorId: number, from: Date, to: Date,
): Promise<HourlyReading[]> {
  const body = await get<{ results?: Record<string, unknown>[] }>(
    `/sensors/${sensorId}/hours`,
    {
      datetime_from: from.toISOString(),
      datetime_to: to.toISOString(),
      limit: 1000,
    },
  );
  const out: HourlyReading[] = [];
  for (const r of body.results ?? []) {
    const period = (r.period ?? {}) as Record<string, unknown>;
    const eventTime = parseUtc(period.datetimeFrom);
    const value = Number(r.value);
    if (!eventTime || !Number.isFinite(value)) continue;
    const flag = (r.flagInfo ?? {}) as Record<string, unknown>;
    out.push({
      eventTime, value,
      hasFlags: typeof flag.hasFlags === 'boolean' ? flag.hasFlags : null,
    });
  }
  return out;
}
