# Downwind — Session State / Handoff

**Read this first.** Companion to `ARCHITECTURE_DECISIONS.md` (why things are
the way they are) and `BUILD_PLAN.md` (what's done and what's next).

---

## Project

| | |
|---|---|
| Path | `/Users/Jesse/Development/downwind` |
| Repo | `syncopatico-guy/downwind-takehome` (**public**, so Actions minutes are unlimited) |
| Started | 2026-09-21 · **3-day deadline** |
| Question | *Where is wildfire smoke degrading air quality right now, which fires are responsible, and where is it heading next?* |
| Scope | Western North America — lat 31→60, lon −128→−103 |

## How the user wants to work

- **Plan each step, then execute it.** Not several steps at once.
- **Every real decision goes to the user.** If a decision is needed
  mid-implementation, stop and ask — do not guess. Batch coupled decisions.
- Keep `ARCHITECTURE_DECISIONS.md` current: each decision, the alternatives,
  and the reasoning. It will become a .docx used to defend the architecture,
  so it is written to be read by someone who was not here.
- Verify with measurement rather than assertion. Several planning assumptions
  were disproved by probing; the record keeps those corrections.

---

## Status: Steps 1–9 done · Step 10 **deliberately skipped** · Step 11 **in progress**

| Step | State |
|---|---|
| 1 Config, DB layer, migrations | done |
| 2 FIRMS ingester | done |
| 3 NWS alerts + zone geometry | done |
| 4 OpenAQ (stations, latest, backfill) | done |
| 5 Open-Meteo wind + CAMS | done |
| 6 GitHub Actions cron (5 workflows) | done, verified in CI |
| 7 Fire clustering | done — 617 clusters, identity stable |
| 8 Smoke attribution | done — 1,270 attributions |
| 9 `hourly_frames` | done — 165k frames |
| **10 Sept 2020 seed** | **SKIPPED** — see below |
| **11 Query layer (9 tools)** | **IN PROGRESS** — see below |
| 12 The agent | |
| 14 Interface (13 folded in) | |
| 15 Deploy | |
| 16 Golden-question eval set | stretch, first to cut |

**Why 10 was skipped:** it was insurance against a flat demo, but the live data
already contains a real attributable event — the Yosemite complex at 37,709 MW,
attributions at 8.15× station baseline with 7° wind alignment, and a station at
AQI 378 / PM2.5 306.8 / CO 2,708 µg/m³. Two of four technical requirements and
both deliverable requirements were still unbuilt, and all of that value lives in
11–15. Revisit only if we land early.

---

## Data state

| Table | Rows | Size |
|---|---|---|
| `model_aq_hourly` | 290,736 | 102 MB |
| `weather_hourly` | 249,736 | 95 MB |
| `aq_measurements` | ~135,000 | 65 MB |
| `hourly_frames` | 165,012 | 28 MB |
| `nws_zones` | 429 | 13 MB |
| `fire_detections` | 7,719 | 7 MB |
| `alerts` | 890 | 2 MB |
| `fire_clusters` | 617 | small |
| `smoke_attributions` | 1,270 | 784 kB |
| **Database total** | | **337 MB / 500 MB** |

**Storage is the binding constraint.** The hourly cron adds genuine forecast
revisions (~37 MB/day at a 24h horizon). Levers, in order: narrow any seed;
prune superseded rows older than 3 days; drop the CAMS grid.

**Cron status (2026-09-22):** for the first two hours after registration
GitHub fired **zero** scheduled runs across all five workflows, while manual
dispatches of the same files succeeded. Configuration was verified correct
throughout. All five cron expressions were moved off the contended
`:00/:15/:30/:45` boundaries (cadences unchanged) and all five workflows were
dispatched manually in two batches — batched so the two Open-Meteo callers and
the two OpenAQ callers never ran concurrently. All five succeeded; every source
now reports `fresh`. **Whether the offsets actually fix scheduling is unproven
— check `gh run list --event schedule` early next session.**

Coverage: 5 feeds, **7+ days of history on every one**. 800 selected AQ
stations covering 438 H3 r4 cells. 617 fire clusters (88 `likely_wildfire`,
34 `likely_industrial`, 495 `indeterminate`).

---

## Credentials

`.env.local` (gitignored — verified not in git history):

| Var | State |
|---|---|
| `DATABASE_URL` | set (Neon pooled, quoted in file — dotenv strips quotes) |
| `OPENAQ_API_KEY` | set |
| `FIRMS_MAP_KEY` | set (only needed for archive backfill; live CSVs are keyless) |
| `NWS_USER_AGENT` | set |
| `ANTHROPIC_API_KEY` | **EMPTY — blocks Step 12** |

GitHub repo secrets: `DATABASE_URL`, `OPENAQ_API_KEY`, `NWS_USER_AGENT`.
**Never paste secret values into GitHub with surrounding quotes** — they are
stored literally, and a quoted URL fails with `getaddrinfo ENOTFOUND base`.

`gh` CLI **is installed and authenticated** (2.101.0, account
`syncopatico-guy`, scopes `gist read:org repo workflow`). Actions logs are
readable and workflows dispatchable from here. The Actions *billing* endpoint
is not — it needs a `user` scope this token does not carry.

---

## Commands

```
npm run migrate                # apply pending migrations
npm run migrate -- --status    # show applied/pending
npm run verify:schema          # extensions, tables, views, PostGIS check

npm run ingest:firms -- --window=24h --trigger=cron
npm run ingest:nws -- --trigger=cron
npm run ingest:openaq -- --mode=latest|stations|backfill
npm run ingest:openmeteo -- --mode=weather|cams|grid-init
npm run cluster:fires
npm run attribute:smoke
npm run build:frames
```

Most accept `--dry-run` and `--budget=<minutes>`. Migrations are numbered
`001`–`017` in `db/migrations/`.

---

## Things that will bite a fresh session

1. **`AGENTS.md` requires reading `node_modules/next/dist/docs/` before writing
   any app code.** This is a modified Next.js (16.3.5) with breaking changes.
   **The `LayoutProps` typecheck error is solved** — `npx next typegen`
   generates it, typecheck then exits 0, and the output lands in `.next/` so
   the tree stays clean. The grep filter is no longer needed; the verification
   command is now:
   `npx next typegen && npx tsc --noEmit -p tsconfig.json`
   What actually bites from Next 16: request APIs are async-only (`params` is a
   Promise), route context types come from `RouteContext<'/api/...'>` which
   typegen produces, route handlers are uncached by default, `use cache` cannot
   sit inline in a handler body, and the edge runtime is deprecated so `nodejs`
   is the default.
2. **Load the `claude-api` skill before writing agent code.** Model is
   `claude-opus-5`; `budget_tokens` is rejected; use
   `thinking: {type:"adaptive"}` and `output_config.effort`.
3. **Test the exact command a workflow runs**, not an approximation. A cron
   path shipped broken because only the backfill path had been exercised
   locally.
4. **`CREATE OR REPLACE VIEW` cannot reorder or rename columns.** Two
   migrations failed on this; use explicit `DROP VIEW` in dependency order.
5. **Never hold a `PoolClient` across long HTTP work** — Neon closes the idle
   connection. `withIngestRun` passes the pool. Use `withTransaction` (held
   client) only for pure-DB work such as temp tables.
6. **Wind direction cannot be averaged arithmetically** (350° and 10° average
   to 180°, the opposite). Use a vector mean.
7. **A regional maximum is not a regional condition.** `max()` over 3M km² is
   always extreme; use percentiles.
8. Open-Meteo weights requests by cost — a 429 lands after ~4 large calls, and
   `past_days=1` does **not** avoid that.
9. OpenAQ is 60 req/min. The sliding-window limiter in `lib/openaq.ts` handles
   it; do not reintroduce flat sleeps.
10. **Open the ingest run BEFORE the fetch.** Every cron path used to fetch
    first, so a network failure left no row in `ingest_runs` at all and the
    feed went stale with no explanation. Fixed in all five paths on
    2026-09-22. `withIngestRun` passes the pool, not a held client, precisely
    so HTTP work inside the callback is safe.
11. **`fetch failed` is undici hiding the reason in `err.cause`.** Use
    `describeFetchError` from `lib/http.ts`, which walks the chain.
    `withIngestRun` already does this for `error_message`.
12. FIRMS and NWS retry via `lib/http.ts` (3 attempts, fail fast on 4xx except
    429). OpenAQ and Open-Meteo keep their own older loops, which retry 4xx.

---

## Step 11 — the nine tools (in progress)

### Built and verified against live data

| File | State |
|---|---|
| `lib/tools/envelope.ts` | done — envelope, record ids, `computed: false` discipline |
| `lib/tools/time.ts` | done — both clocks, one place |
| `lib/tools/sql.ts` | done — Neon serverless driver, cached source registry |
| `lib/tools/types.ts` | done — `ToolDefinition` shape |
| `lib/tools/place.ts` | done — gazetteer + conservative cell labelling |
| `lib/tools/get-data-health.ts` | **done, verified** — 5 sources, 200 ms |
| `lib/tools/resolve-place.ts` | done — ambiguity surfaced, not resolved |
| `get_air_quality` | next |
| `get_fires` / `get_wind` / `get_alerts` | not started |
| `explain_smoke` | not started |
| `compare_time` / `rank_places` | not started |
| `registry.ts` | not started |
| `app/api/tools/[tool]/route.ts` | not started |
| `scripts/verify-tools.ts` | not started |

**This work is uncommitted** — `lib/tools/` is untracked.

Build order for the rest: the four readers, then `explain_smoke`, then
`compare_time`/`rank_places`, then the registry and route, then the
verification script.

### The contract

Each returns the same envelope, which is where provenance and quality live:

```ts
{
  data: [...],
  provenance: { source_id, source_url, record_ids[], event_time_range, ingest_time, row_count },
  quality: { as_of, age_seconds, is_stale, gaps: [{start,end,reason}], conflicts: [...] }
}
```

| Tool | Reads |
|---|---|
| `resolve_place` | station localities, NWS zone names, cluster labels |
| `get_air_quality` | `aq_measurements` + `model_aq_hourly` side by side |
| `get_fires` | `v_fire_clusters_active` |
| `get_wind` | `v_weather_latest` |
| `get_alerts` | `v_alert_geometry` |
| `explain_smoke` | `v_smoke_explanations` |
| `compare_time` | `hourly_frames` |
| `rank_places` | `hourly_frames` / `v_timeline_series` |
| `get_data_health` | `v_source_health`, `v_feed_variant_health`, `v_roster_coverage` |

**Every tool takes TWO time parameters, not one.** This was corrected by
measurement — see 5c in the decision record.

- **Event time** (`at`, or `from`/`to`) is the primary axis and drives the
  scrub. Depth: ~8 days of history plus 2 of forecast.
- **`known_as_of`** is the optional knowledge cutoff (`ingest_time <=
  known_as_of`), defaulting to now. Depth: **only as old as our collector** —
  5.1 h when measured, growing an hour per hour.

The original single-`as_of`-on-`ingest_time` design returns **zero rows** for a
scrub position three days back, because the whole history arrived in one
backfill. Do not reinstate it.

The three derived tables (`fire_clusters`, `smoke_attributions`,
`hourly_frames`) hold a single `computed_at` and no `ingest_time`, so they
cannot honour a knowledge cutoff at all. Their tools return
`known_as_of_applied: false` with the reason rather than ignoring the
parameter.

### Facts the tools must surface honestly

- **Only 20.9% of elevated station-hours have an attributable fire.** The agent
  must be able to say "nothing explains this" — urban PM2.5 has traffic,
  industry, dust and cooking as sources.
- **CAMS runs 42% high against sensors with r=0.118** across 112,917 paired
  station-hours. Modelled and measured are never interchangeable.
- **Regulatory monitors are nearly absent** — 42 of 856 reporting. The live
  network is low-cost sensors (AirGradient, Clarity). Instrument tier is a
  stated caveat; 359 selected stations have tier `unknown` because they were
  synthesized from the measurement feed.
- **NWS retains only ~7–14 days**, so it is the one feed that decays.
- **`source_character`** distinguishes wildfire from industrial heat
  (refineries, oil sands). `all_industrial` on `v_smoke_explanations` marks
  station-hours explained *only* by industry — never report those as wildfire
  smoke.
- **`v_reading_corroboration`** gives the neighbour comparison for extreme
  readings: a 985 µg/m³ value with 8 neighbours at ~10 is a 99× outlier on a
  *reference-grade* monitor.
- **Freshness has four states**: `fresh`, `stale`, `one_off`/`not_scheduled`,
  `never_succeeded`. "Never scheduled" and "overdue" are different facts.

## Steps 12, 14, 15 — decided shape

- **Agent:** `toolRunner({stream:true})` gathers (streaming per-tool progress),
  then `client.messages.parse()` + `zodOutputFormat(ClaimsSchema)` composes.
  They do **not** compose directly — verified. Validate every citation against
  record ids the tools returned and retry the compose step alone on failure.
  `claude-opus-5`, effort routing (low for lookups, high for multi-hop),
  prompt caching, server-side refusal fallbacks.
- **Interface:** MapLibre GL, map-dominant, docked chat, permanently visible
  timeline. Evidence drawer: claim → record → upstream API. Per-feed freshness
  strip. Cold open: seeded state + example questions.
- **New technology (Step 13, folded into 14):** DuckDB-WASM reading a Parquet
  export of `hourly_frames` client-side, so scrubbing never touches the
  network. Timeboxed with a server-query fallback.
- **Deploy:** Vercel. Hobby cron is daily-only, which is why ingestion lives in
  GitHub Actions.
