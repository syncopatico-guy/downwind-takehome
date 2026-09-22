/**
 * Open-Meteo client: wind/boundary-layer and CAMS air quality.
 *
 * Verified against the live API:
 *   * Multi-location batching works by passing comma-separated coordinate
 *     lists. 200 per request is safe, 400 works, 800 returns HTTP 414 -- the
 *     limit is URL length, not a documented cap.
 *   * `past_days` and `forecast_days` combine in ONE call: past_days=7 plus
 *     forecast_days=2 returns 216 hours.
 *   * A multi-location response is a JSON ARRAY, in request order; a
 *     single-location response is a bare object.
 *   * All variables used here returned 216/216 non-null, including
 *     boundary_layer_height -- the mixing depth that decides whether smoke
 *     stays aloft or sits in the valley people breathe.
 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

/** 200 keeps the URL comfortably under the length that produced HTTP 414. */
export const BATCH_SIZE = 200;

export const WEATHER_VARS = [
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
  'boundary_layer_height', 'temperature_2m', 'relative_humidity_2m', 'precipitation',
] as const;

export const CAMS_VARS = [
  'pm2_5', 'pm10', 'us_aqi', 'aerosol_optical_depth', 'dust', 'carbon_monoxide',
] as const;

export interface FetchStats {
  requests: number; retries: number; locations: number;
  rateLimit429s: number; rateLimitWaitMs: number;
}
export const stats: FetchStats = {
  requests: 0, retries: 0, locations: 0, rateLimit429s: 0, rateLimitWaitMs: 0,
};

export interface SamplePoint { pointId: string; lat: number; lon: number }

export interface HourlySeries {
  pointId: string;
  times: Date[];
  values: Record<string, (number | null)[]>;
}

async function getJson(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      stats.requests++;
      const text = await res.text();
      if (res.status === 429) {
        // Open-Meteo weights requests by cost rather than counting them: a
        // 200-location, 7-variable, 9-day call consumes far more than one
        // unit. So a 429 is possible after only a handful of requests, and it
        // must be visible rather than showing up as unexplained latency.
        stats.rateLimit429s++;
        const waitMs = Math.min(Number(res.headers.get('retry-after') || 30) * 1000, 60_000);
        stats.rateLimitWaitMs += waitMs;
        console.warn(`    [open-meteo] 429 after ${stats.requests} request(s) — waiting ${waitMs / 1000}s`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (err) {
      stats.retries++;
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('exhausted retries');
}

function parseSeries(
  raw: unknown, batch: SamplePoint[], vars: readonly string[],
): HourlySeries[] {
  // Single-location responses are a bare object; batched ones are an array.
  const list = Array.isArray(raw) ? raw : [raw];
  const out: HourlySeries[] = [];

  for (let i = 0; i < batch.length; i++) {
    const entry = list[i] as Record<string, unknown> | undefined;
    if (!entry) continue;
    const hourly = entry.hourly as Record<string, unknown> | undefined;
    if (!hourly) continue;

    const times = (hourly.time as string[] | undefined ?? []).map((t) =>
      // Open-Meteo returns naive ISO strings when timezone=UTC; make that explicit.
      new Date(t.endsWith('Z') ? t : `${t}Z`));

    const values: Record<string, (number | null)[]> = {};
    for (const v of vars) {
      const arr = hourly[v] as (number | null)[] | undefined;
      values[v] = arr ?? times.map(() => null);
    }
    out.push({ pointId: batch[i].pointId, times, values });
  }
  return out;
}

async function fetchBatched(
  baseUrl: string, points: SamplePoint[], vars: readonly string[],
  pastDays: number, forecastDays: number,
  onBatch?: (done: number, total: number) => void,
): Promise<HourlySeries[]> {
  const out: HourlySeries[] = [];

  for (let i = 0; i < points.length; i += BATCH_SIZE) {
    const batch = points.slice(i, i + BATCH_SIZE);
    const url =
      `${baseUrl}?latitude=${batch.map((p) => p.lat.toFixed(4)).join(',')}` +
      `&longitude=${batch.map((p) => p.lon.toFixed(4)).join(',')}` +
      `&hourly=${vars.join(',')}` +
      `&past_days=${pastDays}&forecast_days=${forecastDays}&timezone=UTC`;

    const raw = await getJson(url);
    out.push(...parseSeries(raw, batch, vars));
    stats.locations += batch.length;
    onBatch?.(Math.min(i + BATCH_SIZE, points.length), points.length);
  }
  return out;
}

export function fetchWeather(
  points: SamplePoint[], pastDays = 7, forecastDays = 2,
  onBatch?: (done: number, total: number) => void,
): Promise<HourlySeries[]> {
  return fetchBatched(FORECAST_URL, points, WEATHER_VARS, pastDays, forecastDays, onBatch);
}

export function fetchCams(
  points: SamplePoint[], pastDays = 7, forecastDays = 2,
  onBatch?: (done: number, total: number) => void,
): Promise<HourlySeries[]> {
  return fetchBatched(AIR_QUALITY_URL, points, CAMS_VARS, pastDays, forecastDays, onBatch);
}
