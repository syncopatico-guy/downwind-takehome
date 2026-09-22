/**
 * resolve_place -- turn a phrase into coordinates, or say we cannot.
 *
 * Returns ranked candidates and never silently picks between them. "Vancouver"
 * is Vancouver WA and Vancouver BC, 420 km apart; choosing one and saying
 * nothing would produce a confident answer about the wrong city. The agent
 * gets both, with the evidence for each, and either asks or states its choice.
 */

import { z } from 'zod';
import { buildEnvelope, type Envelope } from './envelope';
import { resolvePlaceCandidates, type PlaceCandidate } from './place';
import type { ToolDefinition } from './types';

const inputSchema = z.object({
  query: z.string().min(1).describe('A place name or phrase, e.g. "Portland", "near Yosemite", "the Sierra".'),
  limit: z.number().int().min(1).max(10).optional().describe('Maximum candidates to return (default 5).'),
});

/** Two candidates this far apart are different places, not a fuzzy one. */
const AMBIGUITY_KM = 100;

/**
 * A rival only needs to be a real name match, not a close scorer.
 *
 * The first rule required a rival within 0.2 of the top score, and it missed
 * the case it was written for: "Vancouver" matches a station named exactly
 * "Vancouver" in BC at 0.91 and Portland-Vancouver-Beaverton at 0.64, so the
 * rival fell outside the window and no ambiguity was reported for two places
 * 395 km apart. That score gap is an artefact of exact-versus-substring
 * matching, not evidence about which the user meant. 0.5 is the base score for
 * a substring match, so this admits any genuine name match and errs toward
 * flagging -- the safer direction for a tool whose job is not to pick silently.
 */
const AMBIGUITY_MIN_CONFIDENCE = 0.5;

function haversineKm(a: PlaceCandidate, b: PlaceCandidate): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function handler(input: z.infer<typeof inputSchema>): Promise<Envelope<PlaceCandidate>> {
  const limit = input.limit ?? 5;
  const now = new Date();

  // Ambiguity is detected over a WIDER set than is returned, then the result is
  // truncated. Checking the truncated list meant a low limit could hide the
  // very thing this tool exists to surface: "Vancouver" with limit 2 returned
  // an exact station-name match plus one rival and reported no ambiguity, while
  // Vancouver BC sat just outside the cut, 420 km away.
  const AMBIGUITY_SCAN = 10;
  const scanned = await resolvePlaceCandidates(input.query, Math.max(limit, AMBIGUITY_SCAN));
  const candidates = scanned.slice(0, limit);

  const caveats: string[] = [
    'Places are resolved only against data we hold: NWS zone names, air-quality ' +
      'station names and localities, and fire cluster labels. There is no external ' +
      'geocoder, so a place we cannot resolve is usually a place we have no data for.',
  ];

  if (candidates.length === 0) {
    caveats.push(
      `Nothing in our gazetteer matches "${input.query}". Do not substitute a nearby ` +
        'named place: say the location could not be resolved.',
    );
  } else {
    const [top] = scanned;
    const rivals = scanned
      .slice(1)
      .filter((c) => haversineKm(top, c) > AMBIGUITY_KM
                   && c.confidence >= AMBIGUITY_MIN_CONFIDENCE);
    if (rivals.length > 0) {
      const hidden = rivals.filter((r) => !candidates.some((c) => c.record_id === r.record_id));
      caveats.push(
        `"${input.query}" is ambiguous: ${[top, ...rivals]
          .map((c) => `${c.name} (${c.lat.toFixed(2)}, ${c.lon.toFixed(2)})`)
          .join(' and ')} are more than ${AMBIGUITY_KM} km apart. State which one you used, ` +
          'or ask which was meant.' +
          (hidden.length > 0
            ? ` ${hidden.length} of these fall outside the requested limit and are not in ` +
              'the returned rows — raise limit to see them.'
            : ''),
      );
    }
    if (top.station_count === 0) {
      caveats.push(
        `The best match has no selected air-quality station inside it, so any air-quality ` +
          'answer for this place rests on modelled values or on stations some distance away.',
      );
    }
    const outOfScope = candidates.filter((c) => !c.in_scope);
    if (outOfScope.length > 0) {
      caveats.push(
        `${outOfScope.length} candidate(s) fall outside the ingestion scope ` +
          '(31-60N, 128-103W) and will have no data.',
      );
    }
  }

  return buildEnvelope<PlaceCandidate>({
    data: candidates,
    recordIds: candidates.map((c) => c.record_id),
    // The gazetteer is assembled from three feeds' metadata rather than read
    // from one, so provenance names all three rather than picking a winner.
    sources: [
      { source_id: 'openaq', source_url: 'https://docs.openaq.org/' },
      { source_id: 'nws_alerts', source_url: 'https://www.weather.gov/documentation/services-web-api' },
      { source_id: 'firms_viirs', source_url: 'https://firms.modaps.eosdis.nasa.gov/api/area/' },
    ],
    eventTimes: [],
    ingestTimes: [],
    asOf: now,
    knownAsOf: now,
    knownAsOfApplied: false,
    knownAsOfNote:
      'Place names come from slowly-changing metadata (zone names, station names, cluster ' +
      'labels) rather than from observations, so they are not replayed to a knowledge cutoff.',
    stalenessSeconds: null,
    gaps: null,
    conflicts: null,
    caveats,
  });
}

export const resolvePlace: ToolDefinition<typeof inputSchema, PlaceCandidate> = {
  name: 'resolve_place',
  description:
    'Resolve a place name or phrase to coordinates and a bounding box, using only names ' +
    'present in our own data. Returns ranked candidates with the evidence for each and ' +
    'flags ambiguity (e.g. Vancouver WA vs BC) rather than choosing. Call this first when ' +
    'a question names a location, then pass the resulting bbox or coordinates to other tools.',
  inputSchema,
  handler,
};
