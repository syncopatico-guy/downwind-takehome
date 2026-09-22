# Downwind — Build Plan

Companion to `ARCHITECTURE_DECISIONS.md`. That document records *why*; this one
records *what*, in order, and what is done.

**Deadline:** 3 days. **Scope:** five real-time feeds, a grounded NL agent, an
interactive replay timeline, deployed publicly.

---

## Status

| Step | Work | State |
|---|---|---|
| 1 | Config, database layer, migration runner | **done** |
| 2 | FIRMS fire-detection ingester | **done** |
| 3 | NWS alerts ingester + zone geometry | **done** |
| 4 | OpenAQ stations and measurements | **done** |
| 5 | Open-Meteo wind + CAMS model AQ | **done** |
| 6 | GitHub Actions cron | **done** — 5 workflows, 173 runs/day, all paths tested |
| 7 | Fire clustering | **done** — 617 clusters, identity verified stable |
| 8 | Smoke attribution | **done** — 1,270 attributions, 20.9% of elevated hours explained |
| 9 | `hourly_frames` rollup | **done** — 179,847 frames, 26 MB |
| 10 | September 2020 seed backfill | **skipped deliberately** — live data has a real attributable event |
| 11 | Query layer — the nine agent tools | **done** — 9 tools, registry, HTTP routes, 73 verification checks passing |
| 12 | The agent | **done** — two-phase, enforced citations, effort routing |
| 13 | Parquet export + DuckDB-WASM scrub | **cut for time** — server-query fallback shipped |
| 14 | Interface | **done** — map, timeline, chat, evidence drawer, freshness strip |
| 15 | Deploy | **done** — https://downwind-takehome.vercel.app/ |
| 16 | Golden-question eval set | **cut for time** — stretch, first in the agreed cut order |

**All four technical requirements and both deliverable requirements are met.**
Steps 13 and 16 were the two items in the pre-agreed cut order and both were
cut, in that order. Step 10 was skipped deliberately and earlier, for different
reasons (see below).

**Verified state after Step 11:** nine tools in `lib/tools/`, each returning
the provenance envelope; `npm run verify:tools` runs 73 behavioural checks
against live data, all passing. HTTP surface at `/api/tools` and
`/api/tools/:tool`. Tool inputs are Zod schemas, and the Anthropic tool
definitions are derived from them via `z.toJSONSchema`, so the schema the model
sees and the schema that validates the call cannot drift.

**Verified state after Step 12:** gather via `toolRunner({stream:true})`,
compose via `messages.parse()` + `zodOutputFormat(ClaimsSchema)`, every
citation validated against record ids the tools actually returned. Effort is
routed from the question's shape (22/22 cases). Two limits guard the public
endpoint: 12 questions per caller per hour, and a **global** $2.00 rolling-day
ceiling — a hundred callers asking one question each defeats any per-caller
limit.

**Verified state after Step 14:** one `Chat` instance repositioned by CSS
rather than two with separate state; the scrub position drives the agent's time
context. Three interface faults were found only by using it, not by reading it.

**Verified state after Step 15 (deployed, smoke-tested 2026-09-22):**

| Check | Result |
|---|---|
| MapLibre worker MIME type | `application/javascript`, 19,007 B — `prebuild` generated the gitignored dir on Vercel's builder |
| Function region | `x-vercel-id: yul1::cle1::…` — us-east-2, beside Neon |
| Route latency | 92 ms record · 93 ms tools · 140 ms map · 313 ms timeline |
| Agent end-to-end | 32.2 s, effort `low`, `compose_attempts: 1`, 26/26 citations verified, 0 invented |
| Model in production | `claude-opus-5` |
| Timeline scrub | live → 17 Sep: 0 → 225 fires, worst 40.5 → 140 µg/m³, alert polygons appear |

**Closed since Step 11:** the derived layer now rebuilds on a schedule
(`derive` job in the hourly workflow, `needs: ingest` + `if: always()`), so
`hourly_frames` no longer sits ~12 hours behind the raw measurements.

**Verified state after Step 4** *(historical snapshot — see the Storage watch
above for current figures)*: 7,431 fire detections over 8 days; 890 alerts,
all with resolvable geometry; 429 zones cached; 134,652 AQ measurements across
1,193 stations, with 434–438 H3 r4 cells covered on every day of the seven-day
window. Database **337 MB** of a 500 MB ceiling. Three of five feeds live.

**Storage watch — the live constraint throughout.** **396 MB of 500 MB** as of
2026-09-22 18:40 UTC, after reclaiming 24 MB. Neon Free blocks *inserts,
updates and deletes* at the 0.5 GB ceiling, so running out is not a degraded
mode — it is a stop.

| Table | Size |
|---|---|
| `model_aq_hourly` | 134 MB |
| `weather_hourly` | 121 MB |
| `aq_measurements` | 66 MB |
| `hourly_frames` | 26 MB (was 50 MB before `VACUUM FULL`) |

Two things measured while clearing headroom for the deploy. `hourly_frames` had
**zero dead tuples** before the vacuum — the `--vacuum` in `build:frames` works;
plain `VACUUM` simply cannot return free pages to the OS, and the 24 MB was
in-page free space that will drift back as upserts continue. The other three
tables also show zero dead tuples: they are append-only with `ON CONFLICT DO
NOTHING`, so their size is genuine data and no reclaim is available there.

Levers remaining, in order: prune superseded forecast revisions older than 3
days; drop the CAMS grid; pay for a Neon tier.

**Cron note for Step 6:** Open-Meteo weights requests by cost and returned a 429
after 3 large calls. The hourly run must use `past_days=1`, not 7.

---

## Completed

### Step 1 — Configuration and database layer

- `db/migrations/001_init.sql` — bitemporal schema, 13 tables, 52 indexes, two
  health views
- `db/migrations/002_seed_sources.sql` — five source rows with declared
  staleness contracts
- `lib/scope.ts` — bbox, H3 resolutions, six FIRMS endpoints, seed window,
  smoke-relevant alert types
- `lib/db.ts` — pool, transactions, `withIngestRun` (provenance invariant)
- `scripts/migrate.ts` — ordered, checksummed, per-file transactional
- `scripts/verify-schema.ts` — re-runnable sanity check

Caught: `proc_version` was nullable inside a UNIQUE constraint, which would
have re-inserted every detection on every cron run forever.

### Step 2 — FIRMS ingester

- `lib/firms.ts` — CSV parsing, header-indexed columns, validated dedupe key
- `scripts/ingest-firms.ts` — six endpoints tracked independently, bbox filter
  with `--no-scope-filter` escape hatch, `--window=24h|48h|7d`, `--dry-run`

Caught: FIRMS' USA region overlaps the Canada file; the dedupe key absorbed
2,559 would-be double counts.

### Step 3 — NWS alerts ingester

- `lib/nws.ts` — alert parsing, cursor pagination, lazy zone resolution with a
  zone-type fallback chain
- `scripts/ingest-nws.ts` — active mode for cron, `--days=N` backfill,
  `--resolve-zones` re-resolution pass
- `db/migrations/003_alerts_zones.sql` — `references_ids`, `same_codes`,
  `effective`, `nws_zones`, `v_alert_geometry`

Caught: Z-prefixed zone ids may be public *or* fire-weather zones on different
API paths. Red Flag Warnings use fire zones, so a single guessed type silently
unmapped the most smoke-relevant alerts in the feed.

---

## Step detail, as originally planned

These were written forward, before each step was built, and are kept as the
record of intent. **The Status table above is authoritative for what actually
happened** — everything here through Step 15 is built except Steps 10, 13 and
16. Where the plan below was wrong, the correction lives in
`ARCHITECTURE_DECISIONS.md` rather than being edited out here.

### Step 4 — OpenAQ  (ground measurements)

The only feed providing a named physical station, which is what "follow
evidence to its source" concretely means.

- Probe the API to settle the measurement-fetch strategy — **bulk endpoint or
  one request per sensor?** ~1,000 stations x 2 parameters would be ~2,000
  requests per run, which is unworkable on a cron
- `lib/openaq.ts`, `scripts/ingest-openaq.ts`
- Stations → `aq_stations` **and** `sample_points` (kind `station`)
- Measurements → `aq_measurements`, PM2.5 and PM10
- Classify `instrument_tier` (reference / low_cost) — the conflict lever, since
  regulatory monitors and low-cost sensors disagree systematically

### Step 5 — Open-Meteo  (wind + CAMS)

Depends on Step 4: samples are taken at `sample_points`.

- `lib/openmeteo.ts`, `scripts/ingest-openmeteo.ts`
- Wind, gusts, RH, PBL height → `weather_hourly`
- CAMS PM2.5 / PM10 / US AQI / AOD → `model_aq_hourly`
- Multi-location batching (comma-separated coordinates, already verified)
- A coarse background grid for the map's wind field

### Step 6 — GitHub Actions cron

- Per-feed cadences: NWS ~5 min, FIRMS ~30 min, OpenAQ and Open-Meteo hourly
- Repository secrets
- Ingestion becomes autonomous at this point

### Step 7 — Fire clustering

- Spatio-temporal clustering of detections into `fire_clusters`
- **Stable `cluster_key` across runs** as fires grow and merge — the hard part
- Assign `cluster_id` back onto detections

### Step 8 — Smoke attribution

The core feature. Upwind cone weighted by fire radiative power and distance.

- Each row carries its own evidence: contributing fires, wind alignment,
  distance, intensity, travel time
- `method_version` so the method can be revised without discarding history
- Presented always as a hypothesis with evidence, never as established fact

### Step 9 — `hourly_frames` rollup

- One indexed read per scrub position
- `is_partial` and `missing_sources` so gaps render as visible holes rather
  than being interpolated over

### Step 10 — September 2020 seed

- FIRMS archive API (needs `MAP_KEY`; archive depth still to be verified)
- OpenAQ historical measurements, Open-Meteo archive
- **No NWS** — provider retains only ~7–14 days; surfaced as a labelled gap
- Re-run steps 7–9 across the seeded window

### Step 11 — Query layer

First application code, so the `AGENTS.md` requirement to read
`node_modules/next/dist/docs/` applies here. Done: Next 16.3.5, and
`npx next typegen` resolves the `LayoutProps` error outright.

- The nine tools, each returning the provenance envelope
  (`data` / `provenance` / `quality`)
- **Two** time parameters, not one: event time (`at` / `from` / `to`) drives
  the scrub; `known_as_of` is a separate optional knowledge cutoff. The
  original single-`as_of`-on-`ingest_time` design was disproved by measurement
  — it returns zero rows beyond ~5 hours back. See 5c in the decision record.
- Conflicts shipping: model-vs-measurement and sensor-vs-neighbours. Advisory
  conflict and computed `gaps` deferred, returning `null` with
  `computed: false` rather than an empty array.

### Step 12 — The agent

- Gather with `toolRunner({ stream: true })`, streaming per-tool progress
- Compose with `client.messages.parse()` + `zodOutputFormat(ClaimsSchema)`
- Validate every citation against record ids the tools actually returned;
  retry the compose step alone on failure
- `claude-opus-5`, effort routing, prompt caching, refusal fallbacks

### Step 13 — Parquet + DuckDB-WASM

The new-technology deliverable. Timeboxed with a server-query fallback.

- Node DuckDB bindings export `hourly_frames` to Parquet
- DuckDB-WASM queries it client-side: zero-latency scrubbing

### Step 14 — Interface

- MapLibre GL, map-dominant with docked chat and a permanently visible timeline
- Evidence drawer: claim → record → upstream API
- Per-feed freshness strip
- Scrub position drives the agent's `as_of`

### Step 15 — Deploy

- Vercel, environment variables, cold-open seeded state with example questions

### Step 16 — Golden-question eval set  *(stretch)*

~20 questions covering expected tool calls, groundedness, and expected
**refusals** for questions the data cannot answer.

---

## Schedule risk — how it actually resolved

The prediction was that Steps 11–14 were the largest block, all landing on day
3, and that this was the compression point. **That was correct.** The agreed cut
order was: eval set first, then DuckDB-WASM, falling back to server queries so
the timeline still scrubs.

**Both cuts were taken, in exactly that order,** and nothing outside the cut
order was sacrificed to make room. The fallback behaved as designed: the
timeline scrubs over a 59 KB series fetched in one call, with map redraws
costing a 140 ms round trip instead of being instant.

The other lever — narrowing the 2020 seed rather than cutting anything in 11–14
— was never needed, because Step 10 was dropped entirely and earlier, on the
grounds that the live data already contained a real attributable event. That
decision returned roughly a day to the compressed block and is the single
largest reason 11, 12, 14 and 15 all landed.

**What the cuts cost:** the timeline is not zero-latency, and the honesty
behaviours in the agent are demonstrated rather than continuously verified.
Neither is a missing requirement; both are described in
`docs/ARCHITECTURE_SUMMARY.html`.
