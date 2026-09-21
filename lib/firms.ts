/**
 * NASA FIRMS active-fire CSV parsing.
 *
 * Six keyless endpoints (3 VIIRS satellites x 2 regions) share one identical
 * schema, so this single parser serves all of them.
 *
 * Verified CSV column order:
 *   0 latitude   1 longitude  2 bright_ti4  3 scan     4 track
 *   5 acq_date   6 acq_time   7 satellite   8 confidence
 *   9 version   10 bright_ti5 11 frp       12 daynight
 */

import { createHash } from 'node:crypto';
import { latLngToCell } from 'h3-js';
import { H3_RES, inScope } from './scope';

export interface FirmsDetection {
  observationKey: string;
  lat: number;
  lon: number;
  h3r6: string;
  eventTime: Date;
  frpMw: number | null;
  brightnessTi4: number | null;
  brightnessTi5: number | null;
  confidence: 'low' | 'nominal' | 'high' | null;
  /** Authoritative platform, taken from the endpoint we fetched -- not from the
   *  CSV's terse satellite code, which is only verified for Suomi NPP. */
  satellite: string;
  instrument: string;
  daynight: 'D' | 'N' | null;
  procVersion: string;
  inScope: boolean;
}

export interface FirmsParseResult {
  detections: FirmsDetection[];
  rowsFetched: number;
  /** Rows that could not be parsed at all. These mark a run 'partial'. */
  rowsRejected: number;
  rejectSamples: string[];
  inScopeCount: number;
  outOfScopeCount: number;
  /** Non-fatal oddities worth surfacing without failing the run. */
  anomalies: Record<string, number>;
}

/** Minimal quote-aware CSV line splitter. FIRMS emits plain numerics, but a
 *  naive split would break silently if that ever changed. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function num(raw: string | undefined): number | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (t === '' || t.toLowerCase() === 'nan') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/**
 * Compose the detection identity from the RAW PUBLISHED STRINGS.
 *
 * Empirically validated: all 1,932 keys from the 24h feed appear byte-identical
 * in the 7-day feed, with zero duplicates within either. Coordinate precision in
 * the source is ragged (5dp for most rows, but also 4, 3 and 2), so parsing and
 * re-rounding would add risk for no benefit. The published string IS the identity.
 */
function observationKey(
  latRaw: string, lonRaw: string, dateRaw: string, timeRaw: string, satRaw: string,
): string {
  return createHash('sha256')
    .update([latRaw, lonRaw, dateRaw, timeRaw, satRaw].map((s) => s.trim()).join('|'))
    .digest('hex')
    .slice(0, 32);
}

/** acq_date (YYYY-MM-DD) + acq_time (HHMM, verified uniformly 4 chars) -> UTC. */
function parseAcqTime(dateRaw: string, timeRaw: string): Date | null {
  const d = dateRaw.trim();
  const t = timeRaw.trim().padStart(4, '0');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{4}$/.test(t)) return null;
  const iso = `${d}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseFirmsCsv(
  csv: string,
  opts: { satellite: string; instrument: string },
): FirmsParseResult {
  const lines = csv.split('\n');
  const detections: FirmsDetection[] = [];
  const rejectSamples: string[] = [];
  const anomalies: Record<string, number> = {};
  let rowsFetched = 0;
  let rowsRejected = 0;
  let inScopeCount = 0;

  const bump = (k: string) => { anomalies[k] = (anomalies[k] ?? 0) + 1; };

  // Locate columns by header name rather than fixed position, so a column
  // reordering upstream degrades loudly instead of corrupting data silently.
  const header = splitCsvLine(lines[0] ?? '').map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iLat = col('latitude'), iLon = col('longitude');
  const iDate = col('acq_date'), iTime = col('acq_time'), iSat = col('satellite');
  if (iLat < 0 || iLon < 0 || iDate < 0 || iTime < 0 || iSat < 0) {
    throw new Error(`FIRMS CSV header missing required columns: got [${header.join(', ')}]`);
  }
  const iTi4 = col('bright_ti4'), iTi5 = col('bright_ti5');
  const iConf = col('confidence'), iVer = col('version'), iFrp = col('frp');
  const iDn = col('daynight');

  for (let n = 1; n < lines.length; n++) {
    const line = lines[n];
    if (!line || line.trim() === '') continue;
    rowsFetched++;

    const f = splitCsvLine(line);
    const lat = num(f[iLat]);
    const lon = num(f[iLon]);
    const eventTime = parseAcqTime(f[iDate] ?? '', f[iTime] ?? '');

    // A row without position or time cannot be placed in space or replayed in
    // time, so it is genuinely unusable -- unlike the soft problems below.
    if (lat === null || lon === null || eventTime === null ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      rowsRejected++;
      if (rejectSamples.length < 5) rejectSamples.push(line.slice(0, 160));
      continue;
    }

    const confRaw = (f[iConf] ?? '').trim().toLowerCase();
    let confidence: FirmsDetection['confidence'] = null;
    if (confRaw === 'low' || confRaw === 'nominal' || confRaw === 'high') {
      confidence = confRaw;
    } else if (confRaw !== '') {
      bump('unrecognised_confidence');
    }

    const dnRaw = (f[iDn] ?? '').trim().toUpperCase();
    const daynight = dnRaw === 'D' || dnRaw === 'N' ? (dnRaw as 'D' | 'N') : null;
    if (dnRaw !== '' && daynight === null) bump('unrecognised_daynight');

    const frpMw = num(f[iFrp]);
    if (frpMw === null) bump('missing_frp');

    const within = inScope(lat, lon);
    if (within) inScopeCount++;

    detections.push({
      observationKey: observationKey(
        f[iLat] ?? '', f[iLon] ?? '', f[iDate] ?? '', f[iTime] ?? '', f[iSat] ?? '',
      ),
      lat,
      lon,
      h3r6: latLngToCell(lat, lon, H3_RES.detection),
      eventTime,
      frpMw,
      brightnessTi4: num(f[iTi4]),
      brightnessTi5: num(f[iTi5]),
      confidence,
      satellite: opts.satellite,
      instrument: opts.instrument,
      daynight,
      procVersion: (f[iVer] ?? '').trim() || 'unknown',
      inScope: within,
    });
  }

  return {
    detections,
    rowsFetched,
    rowsRejected,
    rejectSamples,
    inScopeCount,
    outOfScopeCount: detections.length - inScopeCount,
    anomalies,
  };
}
