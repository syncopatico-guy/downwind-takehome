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

## Status: Steps 1–9 done · Step 10 **deliberately skipped** · next is **Step 11**

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
| **11 Query layer (9 tools)** | **NEXT** |
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

`gh` CLI is **not installed**. Consequence: Actions logs cannot be read
(anonymous API returns 403) and workflows cannot be triggered from here — the
user must do both. Installing `gh` would remove that round-trip.

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
   any app code.** This is a modified Next.js with breaking changes. **Step 11
   is the first app code**, so do that read first. `app/layout.tsx` currently
   fails typecheck with `Cannot find name 'LayoutProps'` — that is scaffold
   code awaiting Next's type generation, not our bug. Filter it when checking:
   `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v LayoutProps`
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

---

## Step 11 — the nine tools (next)

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

**Every tool takes an optional `as_of`.** Default is now; the UI passes the
scrub position, so the agent answers *as the world was known then*
(`WHERE ingest_time <= as_of`). This is the single thing that makes the
timeline and the conversation one instrument.

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
