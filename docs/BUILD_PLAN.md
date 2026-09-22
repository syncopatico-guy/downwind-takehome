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
| 9 | `hourly_frames` rollup | **done** — 165k frames, 28 MB |
| 10 | September 2020 seed backfill | **skipped deliberately** — live data has a real attributable event |
| 11 | Query layer — the nine agent tools | **in progress** — envelope, time, sql, place, `get_data_health`, `resolve_place` done |
| 12 | The agent | |
| 13 | Parquet export + DuckDB-WASM scrub | |
| 14 | Interface | |
| 15 | Deploy | |
| 16 | Golden-question eval set | stretch |

**Verified state after Step 4:** 7,431 fire detections over 8 days; 890 alerts,
all with resolvable geometry; 429 zones cached; 134,652 AQ measurements across
1,193 stations, with 434–438 H3 r4 cells covered on every day of the seven-day
window. Database **337 MB** of a 500 MB ceiling. Three of five feeds live.

**Storage watch — now the live constraint.** 267 MB of 500 MB used. Remaining
~233 MB covers the 2020 seed, attribution and frames; a 5–6 day seed would cost
roughly 125 MB at observed density. Levers in order: narrow the seed window,
drop the CAMS grid for the seed only, reduce seed scope to OR/WA.

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

## Remaining

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

## Schedule risk

Steps 11–14 are the largest block and all land on day 3. That is the
compression point.

**Agreed cut order:** eval set first, then DuckDB-WASM (falling back to server
queries, so the timeline still scrubs).

**If day 2 slips,** the first lever is narrowing the 2020 seed (Step 10), not
cutting anything in 11–14 — the seed is demo insurance, whereas 11–14 are the
graded deliverables.
