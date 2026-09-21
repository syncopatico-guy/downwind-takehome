/**
 * Geographic and temporal scope for Downwind.
 *
 * Single source of truth. Every ingester, every query and the map all import
 * from here -- a scope mismatch between the ingester and the UI would show up
 * as mysteriously absent data, so it is deliberately not duplicated anywhere.
 */

export const SCOPE_NAME = 'Western North America';

/**
 * Covers CA, OR, WA, NV, ID, MT, UT, AZ plus British Columbia and Alberta.
 * East edge at -103 to include Montana's border (-104.04); west edge at -128
 * to take in coastal waters and offshore detections.
 */
export const BBOX = {
  minLat: 31.0,
  maxLat: 60.0,
  minLon: -128.0,
  maxLon: -103.0,
} as const;

/**
 * H3 resolutions, chosen so each layer is indexed at the granularity it is
 * actually queried at:
 *   r6 (~36 km2)    detections -- fine enough to separate adjacent fires
 *   r5 (~253 km2)   sample points and fire clusters
 *   r4 (~1,770 km2) timeline frames -- coarse enough that a week of hourly
 *                   frames stays a small Parquet file for the browser
 */
export const H3_RES = {
  detection: 6,
  samplePoint: 5,
  frame: 4,
} as const;

/** US states and Canadian provinces in scope. NWS alerts cover the US only. */
export const REGIONS = [
  { code: 'CA', name: 'California',       country: 'US' },
  { code: 'OR', name: 'Oregon',           country: 'US' },
  { code: 'WA', name: 'Washington',       country: 'US' },
  { code: 'NV', name: 'Nevada',           country: 'US' },
  { code: 'ID', name: 'Idaho',            country: 'US' },
  { code: 'MT', name: 'Montana',          country: 'US' },
  { code: 'UT', name: 'Utah',             country: 'US' },
  { code: 'AZ', name: 'Arizona',          country: 'US' },
  { code: 'BC', name: 'British Columbia', country: 'CA' },
  { code: 'AB', name: 'Alberta',          country: 'CA' },
] as const;

/** Comma-joined state list for the NWS /alerts/active?area= parameter. */
export const NWS_AREAS = REGIONS.filter((r) => r.country === 'US')
  .map((r) => r.code)
  .join(',');

/**
 * The six keyless FIRMS endpoints behind the single `firms_viirs` source.
 * All verified HTTP 200 with an identical CSV schema, so one parser serves
 * all of them. Each is tracked independently as an ingest_runs.feed_variant,
 * because one satellite's feed can die while the others keep working.
 */
export const FIRMS_SATELLITES = [
  { key: 'viirs_snpp',   slug: 'suomi-npp-viirs-c2', prefix: 'SUOMI_VIIRS_C2', instrument: 'VIIRS', platform: 'Suomi NPP' },
  { key: 'viirs_noaa20', slug: 'noaa-20-viirs-c2',   prefix: 'J1_VIIRS_C2',    instrument: 'VIIRS', platform: 'NOAA-20'   },
  { key: 'viirs_noaa21', slug: 'noaa-21-viirs-c2',   prefix: 'J2_VIIRS_C2',    instrument: 'VIIRS', platform: 'NOAA-21'   },
] as const;

export const FIRMS_REGIONS = [
  { key: 'usa',    path: 'USA_contiguous_and_Hawaii' },
  { key: 'canada', path: 'Canada' },
] as const;

export type FirmsWindow = '24h' | '48h' | '7d';

/** Build a keyless FIRMS CSV URL. `7d` is our day-one archive window. */
export function firmsCsvUrl(
  satelliteSlug: string,
  satellitePrefix: string,
  regionPath: string,
  window: FirmsWindow = '24h',
): string {
  return (
    'https://firms.modaps.eosdis.nasa.gov/data/active_fire/' +
    `${satelliteSlug}/csv/${satellitePrefix}_${regionPath}_${window}.csv`
  );
}

/** Every (satellite x region) pair, with its variant key and URL. */
export function firmsFeedVariants(window: FirmsWindow = '24h') {
  return FIRMS_SATELLITES.flatMap((sat) =>
    FIRMS_REGIONS.map((reg) => ({
      feedVariant: `${sat.key}:${reg.key}`,
      instrument: sat.instrument,
      platform: sat.platform,
      url: firmsCsvUrl(sat.slug, sat.prefix, reg.path, window),
    })),
  );
}

/**
 * The seeded historical episode: the September 2020 West Coast smoke event.
 *
 * Why this window: the Labor Day windstorm of 7-8 Sept 2020 caused explosive
 * fire growth, and the resulting smoke peaked over the Willamette Valley
 * around 11-14 Sept, when Oregon and Washington PM2.5 exceeded 500 ug/m3 --
 * past the top of the AQI scale. The window below deliberately spans BOTH the
 * fire growth and the downwind smoke arrival, because the causal chain is what
 * the attribution engine has to prove it can reconstruct.
 *
 * Tunable: this is a one-off backfill, not accumulating data, so the window
 * can be narrowed after inspecting what the archives actually return. Storage
 * budget assumed ~5 days.
 */
export const SEED_EPISODE = {
  id: 'westcoast_2020_09',
  label: 'September 2020 West Coast smoke event',
  start: new Date('2020-09-09T00:00:00Z'),
  end: new Date('2020-09-15T00:00:00Z'),
  /** Where the record readings occurred; the fallback scope if storage gets tight. */
  focusRegions: ['OR', 'WA', 'CA'] as const,
} as const;

/** Pollutants we ingest. PM10 is kept because the PM10/PM2.5 ratio
 *  discriminates coarse blowing dust from fine combustion smoke -- letting the
 *  agent say "that is dust, not smoke" instead of conflating them. */
export const AQ_PARAMETERS = ['pm25', 'pm10'] as const;
export type AqParameter = (typeof AQ_PARAMETERS)[number];

export function inScope(lat: number, lon: number): boolean {
  return (
    lat >= BBOX.minLat && lat <= BBOX.maxLat &&
    lon >= BBOX.minLon && lon <= BBOX.maxLon
  );
}

/** Truncate to the top of the UTC hour: the common grain across all feeds. */
export function floorToHourUtc(d: Date): Date {
  const out = new Date(d);
  out.setUTCMinutes(0, 0, 0);
  return out;
}

/**
 * Alert types this product treats as smoke- or fire-relevant.
 *
 * Deliberately a QUERY-TIME concept rather than a schema column: relevance is
 * a product judgement that may change, whereas the stored alert is a faithful
 * record of what NWS published. All event types are ingested; this list drives
 * emphasis in the UI and the agent's default focus.
 *
 * Dust types are included because the PM10/PM2.5 ratio distinguishes coarse
 * blowing dust from fine combustion smoke -- an active dust advisory is
 * corroborating evidence when the agent judges which of the two it is seeing.
 */
export const SMOKE_RELEVANT_EVENTS = [
  'Air Quality Alert',
  'Dense Smoke Advisory',
  'Air Stagnation Advisory',
  'Red Flag Warning',
  'Fire Weather Watch',
  'Extreme Fire Danger',
  'Fire Warning',
  'Blowing Dust Advisory',
  'Blowing Dust Warning',
  'Dust Advisory',
  'Dust Storm Warning',
] as const;

export function isSmokeRelevantEvent(event: string): boolean {
  return (SMOKE_RELEVANT_EVENTS as readonly string[]).includes(event);
}
