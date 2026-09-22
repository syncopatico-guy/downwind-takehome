# Downwind — Architecture & Technology Decision Record

**Project:** A natural-language interface for exploring wildfire smoke and air quality
across Western North America, using five real-time data feeds.

**Purpose of this document:** A grounded record of every significant product and
technical decision, the alternatives that were considered, and the reasoning that
selected one over the others. It is maintained continuously as the build proceeds.

**Status:** Live document. Last updated at end of **Step 9** (hourly frames).

---

## Contents

1. [Reading the brief](#1-reading-the-brief)
2. [Decision 1 — The question](#decision-1--the-question)
3. [Decision 2 — Data feeds, scope, and historical seeding](#decision-2--data-feeds-scope-and-historical-seeding)
4. [Decision 3 — Data model](#decision-3--data-model)
5. [Decision 4 — Storage and hosting](#decision-4--storage-and-hosting)
6. [Decision 5 — The agent](#decision-5--the-agent)
7. [Decision 6 — The interface](#decision-6--the-interface)
8. [Decision 7 — Risk posture and cut order](#decision-7--risk-posture-and-cut-order)
9. [Open items](#open-items)
10. [Decision log summary](#decision-log-summary)

---

## 1. Reading the brief

Six requirements were stated explicitly:

| # | Requirement | Source |
|---|---|---|
| 1 | Three or more real-time feeds around one coherent question | Technical |
| 2 | Ingestion, storage, and query backend | Technical |
| 3 | Web interface with NL queries over real-time *and* historical data | Technical |
| 4 | Interactive timeline for replaying change | Technical |
| 5 | At least one meaningful part uses a technology new to the author | Deliverable |
| 6 | Deployed online, accessible by shared URL | Deliverable |

Three further requirements were identified in the prose rather than the bullet lists.
These drove architecture more than the explicit bullets did:

**Following evidence to its source.** A provenance requirement. Every figure the system
states must be traceable to a specific record with a timestamp and an upstream link.
Provenance therefore had to be a first-class part of the data model rather than a
retrofitted annotation.

**Clear treatment of stale, missing, or conflicting data.** The word *conflicting* is
significant: conflict only arises when two feeds describe the same phenomenon. This
turned out to be a hint about feed selection — deliberately overlapping sources create
something to demonstrate rather than something to apologise for.

**Queries feel interactive and the timeline scrubs smoothly.** A per-frame round trip to
a database cannot deliver smooth scrubbing. This forced both pre-aggregated
time-bucketed storage and, ultimately, a client-side query engine (see Decision 4c).

### The scheduling constraint that shaped everything

Several feeds named in the brief are annotated *"historical data is generally
unavailable"* (GBFS, GTFS-Realtime, OpenSky, aisstream). Requirement 4 asks for replay
of history. For any live-only feed, **the archive exists only if our own collector has
been running** — which cannot be fixed by working harder near the deadline.

With a **three-day budget**, this ruled out a design resting on live-only feeds: the
timeline would have been roughly 48 hours deep, partly recorded while the schema was
still changing. The chosen shape is a hybrid: feeds that ship a real historical archive
give the timeline depth from first deploy, while live capture proves the real-time
requirement and builds forward history.

It also fixed the build order — ingestion first, ahead of the agent and the interface.

### Explicitly out of scope per the brief

Authentication, user accounts, permissions, identity management; test-coverage
percentages and style-guide compliance.

One consequence is worth noting: a public URL with an LLM behind it is an unbounded cost
surface. A simple rate limit is not identity management — it is cost control.

---

## Decision 1 — The question

### Chosen

> **Where is wildfire smoke degrading air quality right now, which fires are
> responsible, and where is it heading next?**

### Alternatives considered

| Option | Feeds | Why rejected |
|---|---|---|
| **River flood risk** — "where is water rising faster than the rain explains?" | USGS streamflow, Open-Meteo precipitation, NWS flood alerts | Safest data quality in the brief and the deepest archive, but USGS streamflow is a *dominant feed* that carries most of the answer by itself, weakening the case for a multi-feed join. Also depends on an active rain event and covers well-trodden ground. |
| **Coastal storm surge** — "where is water higher than the tide predicts?" | NOAA Tides & Currents, NDBC buoys, NWS, Open-Meteo | The most elegant derived metric available (NOAA publishes both predicted *and* observed water level, so surge is a real residual rather than an invented one), and 6-minute cadence scrubs beautifully. Rejected because it is strongly event-dependent: with no active storm the demo is flat. |
| **Weather and city movement** — how rain and cold reshape bike share and transit | GBFS, GTFS-Realtime, Open-Meteo | Most enjoyable and a good fit with more runway. Rejected on three counts: no movement feed has history, so the timeline would be ~48h deep; GTFS-Realtime protobuf parsing is a material time cost; and "human patterns" strains the brief's "physical and natural world" framing. |

### Reasoning for the selection

1. **It is the only candidate where the answer is impossible without joining all three
   feeds.** A fire's location is meaningless for human health without a wind field to
   transport the smoke and a downwind sensor to measure the result. In the flood and
   surge candidates, one feed dominates.
2. **Archive depth exists on day one** — see Decision 2.
3. **The conflict story is intrinsic, not manufactured.** OpenAQ aggregates
   reference-grade regulatory monitors alongside low-cost sensors that disagree
   systematically; satellite fire detection produces genuine false positives (gas flares,
   industrial heat).
4. **The evidence chain is the strongest available**: claim → station reading → satellite
   detection → upstream API.
5. **It does not depend on a single weather event** — something is always burning
   somewhere.

### Known weakness, accepted deliberately

Smoke attribution is a **modelling claim, not a measurement**. This is treated as an
asset rather than a flaw: it obliges the agent to express calibrated uncertainty, which
is precisely what the "reliable, grounded answers" criterion tests. The system presents
attribution as a hypothesis with attached evidence, never as established fact.

---

## Decision 2 — Data feeds, scope, and historical seeding

### 2a. Feed roster — five feeds, four of them keyless

All five were verified live before selection rather than trusted from the brief's link
list.

| Feed | Role | Kind | Key | Verified status |
|---|---|---|---|---|
| **NASA FIRMS** (VIIRS) | Where it is burning, and how hard | observation | none | 1,932 CONUS detections in 24h; **10,786 over 7 days** |
| **OpenAQ v3** | What people are actually breathing | observation | required | HTTP 401 without key |
| **Open-Meteo Forecast** | Wind vector — where the smoke goes | model | none | Live; archive to 1940 |
| **Open-Meteo Air Quality (CAMS)** | Modelled PM2.5 — a second estimate of the same quantity | model | none | Live, PM2.5 + US AQI |
| **NWS Alerts** | What officials have declared | advisory | none (UA only) | Live; 111 alert types |

Each feed is load-bearing. FIRMS locates and quantifies the source; Open-Meteo wind
provides transport; OpenAQ provides ground truth; CAMS provides an independent estimate
of the same quantity as OpenAQ, creating a model-versus-measurement conflict axis; NWS
provides official human judgement, which can conflict with both.

**Verification findings that changed the design:**

- **FIRMS requires no API key and ships a 7-day archive.** The keyless regional CSVs
  returned 10,786 detections across a clean eight-day histogram. This substantially
  defused the three-day history problem — the fire timeline has a week of depth before
  our collector records anything.
- **The data-quality levers are real, not hypothetical.** Every detection carries
  `confidence` (1,776 nominal / **83 low** / 73 high) and `frp` (fire radiative power;
  mean 6.3 MW, max 161.7 MW). Low-confidence detections are therefore flaggable as
  probable false positives, and fires can be weighted by intensity rather than counted
  equally — a 0.5 MW agricultural burn is not the same input as an 85 MW crown fire.
- **A day/night split** (1,494 night / 438 day) explains detection *gaps*: a fire burns
  continuously but is only observed on satellite overpass. This is a genuine missing-data
  case the agent must handle honestly rather than interpolate over.
- **OpenAQ v2 is dead** (HTTP 410) and **AirNow also requires a key** (401). OpenAQ v3
  with a free key is retained because it is the only feed providing a *named physical
  station with coordinates and a provider tier* — which is what "follow evidence to its
  source" concretely means.

### 2b. Geographic scope — Western North America

**Chosen:** CA, OR, WA, NV, ID, MT, UT, AZ, plus British Columbia and Alberta.

| Alternative | Why rejected |
|---|---|
| **All CONUS + Canada** (~2,400 detections/day) | Viable and gives full NWS coverage plus southeast US agricultural burning as a contrast case. Rejected as unnecessary volume and map work for no gain in answer quality. |
| **Global, multiple theatres** (~45,000/day) | Has by far the most dramatic activity — South America alone returned 23,666 detections in 24 hours during Amazon burning season. Rejected because the volume is unmanageable in three days, OpenAQ station coverage in the Amazon is sparse (which collapses the join), and there is no non-US equivalent of the NWS alert feed. |

**Reasoning:** all five feeds function in this scope; OpenAQ coverage is dense; NWS
covers the US portion; volume (~700 detections/day) is right-sized for the budget; and
live activity was confirmed present at selection time — a cluster at **37.62N −119.61W
(Sierra Nevada, near Yosemite) at 85 MW**, and another at **49.8N −121.5W (southern
British Columbia) at 68 MW**.

**Accepted limitation:** NWS alerts are US-only, so the Canadian portion of the scope has
no advisory feed. This is surfaced in the UI rather than hidden.

### 2c. Historical seeding — one episode

**Chosen:** backfill the **7–16 September 2020 West Coast smoke event**, clearly labelled
as historical.

| Alternative | Why rejected |
|---|---|
| **Live data only** | Purest real-time story and least work. Rejected because the demo's impact would depend entirely on conditions during the review window — and at selection time the western US had **one** active NWS alert across eight states. The region was quiet. |
| **Multiple seeded episodes** | Richest replay and the best stress test of the storage layer. Rejected on archive-API cost and the 0.5 GB storage ceiling (Decision 4a). |

**Reasoning:** this decouples *"the system is live"* from *"the demo is dramatic."* Live
ingestion satisfies the real-time requirement; the seeded episode guarantees the timeline
replays something significant regardless of current conditions.

September 2020 was chosen specifically because it is not decoration. It was the most
extreme air-quality event in modern US record — Oregon and Washington PM2.5 exceeded
500 µg/m³, beyond the top of the AQI scale — and its mechanism was a Labor Day east-wind
event driving fire smoke into the Willamette Valley. That is exactly the
fire → wind → station chain the attribution engine models, making it the **proof case for
the attribution logic**, not merely a pretty replay.

---

## Decision 3 — Data model

### 3a. Bitemporal timestamps — chosen

Every observation carries two clocks:

- `event_time` — when the phenomenon occurred (satellite acquisition; the sensor's hour)
- `ingest_time` — when we first learned of it

**Alternative rejected:** `event_time` only. Simpler schema and queries, one less concept
in the UI.

**Reasoning:** two clocks enable two distinct replays. Replay by *event time* answers
"what was the air like at 3pm Tuesday," using everything known now. Replay by *ingest
time* answers "what did we **know** at 3pm Tuesday" — showing that a fire was invisible
to us because the satellite had not yet passed. That converts "clear treatment of stale
and missing data" from a disclaimer into a feature that can be scrubbed through.

The decisive argument was asymmetric cost: it costs two columns now and is **impossible
to add retroactively.** Three days of ingestion without `ingest_time` would permanently
destroy that history.

Implementation: `"what did we know at T"` is the predicate `WHERE ingest_time <= T`.

### 3b. Layered raw + derived — chosen

**Raw** tables preserve full upstream fidelity and are **append-only**; **derived** tables
serve fast queries and the agent's tool surface, and are **freely recomputable**.

| Alternative | Why rejected |
|---|---|
| **Single unified observation table** | One query path, one agent tool, trivial provenance. Rejected for sparse wide rows, loss of type safety, and poor handling of alert polygons and multi-parameter records. |
| **Per-feed tables only** | Least transformation work, most natural per-feed fit. Rejected because the agent would need five separate tools with every cross-feed join hand-written, increasing both latency and agent error rate. |

**Reasoning:** raw keeps provenance exact; derived keeps queries fast and the tool surface
small; and the split gives a clear scaling story with responsibility boundaries. In
implementation the raw/derived split is also a **mutability boundary**, which makes the
layering enforceable rather than aspirational.

### 3c. Revisions without updates — implementation decision

Because raw tables are append-only, upstream corrections cannot overwrite. Each raw table
carries a `UNIQUE` constraint that includes a **hash of the value**:

- Re-reading an unchanged value conflicts and is discarded (`ON CONFLICT DO NOTHING`).
- A **changed** value inserts a new row with a later `ingest_time`.

This captures FIRMS reprocessing (NRT → science-processed, distinguished by
`proc_version`) and OpenAQ late corrections as *history* rather than loss. "Latest known"
is the row with the greatest `ingest_time` per `observation_key`.

### 3d. Entity resolution — fire clustering, chosen

1,932 detections are not 1,932 fires; the Yosemite cluster alone is roughly 186 detections
of one complex. Detections are clustered spatio-temporally into `fire_clusters` carrying
**stable IDs that survive ingest runs.**

**Reasoning:** this lets the agent say *"the Yosemite complex, which grew 40% since
Thursday"* rather than *"detections in a region"* — the difference between a product and a
data dump. The hard part, acknowledged, is ID stability as fires grow and merge.

### 3e. Fire-to-station attribution — upwind cone, chosen

For each station-hour, look upwind along the wind vector and find fire clusters within a
cone; weight by fire radiative power and distance.

| Alternative | Why rejected |
|---|---|
| **Clustering plus bare correlation** ("fires nearby, PM2.5 elevated") | Several hours cheaper and makes no indefensible claims. Rejected because it leaves *"which fires are responsible"* — the core of the chosen question — largely unanswered. |
| **Full plume dispersion model** | Physically strongest. Rejected as multiple days of work, unavailable in a 72-hour budget. |
| **Forward plume projection** (answering "where next" by projecting along forecast winds) | Strongest answer to the complete question. Deferred, not rejected outright, as the highest modelling risk in the budget. |

**Reasoning:** physically motivated, fully explainable, and each attribution row carries
**its own evidence** — contributing fires, wind alignment, distance, intensity, travel
time — so the agent shows its work. Attribution is always presented as a hypothesis with
evidence, never as fact. `method_version` is stored so the method can be revised without
discarding prior computations.

### 3f. Multi-endpoint sources — `feed_variant` on `ingest_runs`

**Context.** Verification established that all three VIIRS satellites (SNPP,
NOAA-20, NOAA-21) publish keyless CSVs with an identical schema, across two
regions — six endpoints in total behind one logical feed.

| 24h rows | SNPP | NOAA-20 | NOAA-21 |
|---|---|---|---|
| USA | 1,952 | 1,639 | 1,992 |
| Canada | 455 | 453 | 535 |
| **7-day archive (USA)** | **10,806** | **10,343** | **10,743** |

The combined 7-day archive is ~31,900 US detections plus Canada; roughly 15,000
fall inside our bbox. Three satellites give ~6 overpasses per day rather than 2,
which materially shrinks the blind windows between passes — directly serving the
replay requirement.

**Chosen:** keep `sources` at five rows and add a nullable `feed_variant` column
to `ingest_runs` (e.g. `viirs_noaa21:canada`).

| Alternative | Why rejected |
|---|---|
| **Three separate `source_id` rows** | Most transparent per-satellite provenance with no schema change. Rejected because the registry and UI would then advertise seven feeds, diluting the "five feeds, each load-bearing" framing. |
| **One source, `satellite` column only** | No schema change at all. Rejected because health tracking becomes all-or-nothing: if one satellite's endpoint silently died, the health view would still report the source as fresh. |

**Reasoning:** it preserves the clean five-feed narrative while keeping
per-endpoint failure visible. The change was made while nothing had yet been
ingested, when it was free; after ingestion began it would have been awkward.

Consequence in the schema: **two** health views rather than one.
`v_feed_variant_health` reports per endpoint; `v_source_health` rolls up
**pessimistically** — a source is only as fresh as its weakest endpoint, because
the alternative is claiming freshness we do not have.

### 3g. Deduplication key — empirically validated

Because raw tables are append-only and deduplicate on conflict, the identity key
has to be exactly right. Rather than reason about it, it was measured against
live data:

- All **1,932** keys from the 24h feed appear **identically** in the 7-day feed
  (zero mismatches) — so coordinates are republished byte-identical rather than
  re-derived. The 7-day backfill and the ongoing cron therefore deduplicate
  against each other correctly.
- **Zero** duplicate keys within either feed, confirming the key is not too coarse.
- Coordinate precision is ragged: 5 decimal places for 9,749 rows, but also 4, 3
  and even 2 for others.

**Decision:** compose `observation_key` from the **raw published field strings**
(`lat|lon|acq_date|acq_time|satellite`), not from parsed and rounded floats. This
is the form that was validated; rounding would have introduced avoidable risk for
no benefit. `acq_time` was confirmed uniformly 4 characters (HHMM), so no ragged
time parsing is needed.

### Schema summary as implemented

`db/migrations/001_init.sql`

| Layer | Tables |
|---|---|
| **Registry** | `sources` (cadence, staleness threshold, latency, measurement kind), `ingest_runs` (provenance + gap backbone), `sample_points` |
| **Raw, append-only** | `fire_detections`, `aq_stations`, `aq_measurements`, `weather_hourly`, `model_aq_hourly`, `alerts` |
| **Derived, recomputable** | `fire_clusters`, `smoke_attributions`, `hourly_frames` |
| **Health** | `v_source_health` view (backs the agent's `get_data_health` tool) |

Three modelling choices inside the schema worth defending explicitly:

- **`sources.measurement_kind`** is constrained to `observation` / `model` / `advisory`.
  This is the axis along which feeds are *permitted* to disagree, making conflict a typed
  property of the data rather than an application-layer special case.
- **`model_aq_hourly` is a separate table from `aq_measurements`.** A model estimate and
  an instrument reading are different kinds of claim; collapsing them into one table
  would destroy the conflict signal that Requirement 3 asks us to surface.
- **`alerts.geom` is nullable.** Many NWS products are zone-coded (UGC/SAME) with no
  polygon. Rather than silently dropping them, they are stored with their zone codes as a
  data-quality case the agent must be honest about.
- **Gridded feeds are sampled at points, not on a dense grid.** `sample_points` holds
  station locations, fire centroids, and a coarse background grid. Sampling a dense H3
  grid over the region would have produced tens of thousands of rows per day for no gain
  in answer quality, and would have breached the storage ceiling.

---

### 3h. Fire detection scope — decided, then reversed on better information

This decision was made twice, and the reversal is recorded because the reasoning
error is instructive.

**First decision: store everything the feed returns, filter at query time.** The
argument was asymmetry — fire detections are the cheapest table, and the live
window is unrecoverable, so scope can always be narrowed later but never widened
backwards. This is the same asymmetry that correctly decided the bitemporal
question (Decision 3a).

**What measurement then showed.** A dry run against all six live endpoints
returned **8,119 detections in 24 hours**, of which only **3,017 (37%) fall
inside the scope bbox.** This invalidated an estimate given earlier in planning:
in-scope volume had been put at ~700/day, derived from a single satellite and a
single region, where the true figure across three satellites and two regions is
roughly four times that. The revised projection for `fire_detections` including
the 2020 seed rose from 6–15 MB to **60–90 MB**, against a 500 MB ceiling with
roughly 350–400 MB now projected in total.

Measuring the geographic distribution also showed that an intermediate filter
would not help: 80% of fetched rows lie west of −90°, so trimming only the
eastern US saves 20%. The bulk of out-of-scope volume is Plains agricultural
burning between −103° and −90°, not the east coast.

| Filter | Share of feed |
|---|---|
| Scope bbox (31–60N, −128…−103) | 29% |
| West of −90 | 80% |
| East of −90 | 20% |
| Hawaii | 2% |

**The reasoning error.** The store-all argument rested on the live window being
unrecoverable. **That premise does not hold for FIRMS.** FIRMS publishes a full
archive through its keyed area API — the very mechanism being used to seed
September 2020. Unlike GBFS or GTFS-Realtime, which genuinely have no history,
nothing about FIRMS is lost by not storing it today. The asymmetry argument had
been applied *by analogy* from the bitemporal decision without checking whether
its premise transferred, and it did not.

**Final decision: filter to the scope bbox at ingest**, with a
`--no-scope-filter` escape hatch so a wider scope can be backfilled later.

**Reasoning:** it cuts the largest raw table by 63%, freeing 40–60 MB of
headroom for the attribution table — whose size is the hardest in the system to
predict — and costs nothing permanent, because any historical window can be
re-fetched.

**Outstanding verification:** archive depth for the VIIRS science-processed
product has not yet been confirmed against the keyed API. If it proves shallower
than 2012–present, the scope filter should be widened as a hedge.

**Implementation note:** filtering happens in the ingester, not the parser. The
parser's contract is a faithful read of what the feed published, so its anomaly
and rejection counts stay meaningful across the whole payload rather than a
subset. Rows dropped by the scope filter are recorded in the run's `notes` as
`dropped_out_of_scope` and deliberately **not** counted as `rows_rejected` —
that field is reserved for malformed data and marks a run `partial`, and "this
fire is in Texas" is not a defect.

### 3i. Discovered: FIRMS regional files overlap

The first backfill run reported duplicate rows against an *empty* table, which
should be impossible. The arithmetic explained it: `811 + 840 + 908 = 2,559`
duplicates, and `9,990 in-scope − 2,559 = 7,431` inserted.

**Finding:** FIRMS' `USA_contiguous_and_Hawaii` region extends well north of the
border and overlaps the `Canada` file. Roughly **72% of in-scope Canadian
detections were already present** from the USA feed.

**Why it matters:** the same physical detection published in two regional files
is one observation, not two. Without the value-identity dedupe key (Decision
3g), ~2,559 fires would have been silently double-counted, corrupting every FRP
total, fire count and attribution weight downstream — and the error would have
been invisible, because both copies are individually valid.

The Canada endpoints are retained regardless: they contributed 1,039 detections
the USA feed did not cover, in northern BC and Alberta.

**Verified result of the first backfill:** 7,431 in-scope detections spanning 8
days (2026-09-14 to 09-21), zero bbox violations, zero parse rejections, all six
endpoints reporting `fresh`. Confidence distribution 6,714 nominal / 413 high /
304 low; day/night 4,915 / 2,516.

### 3j. NWS alerts — retention, geometry, and a corrected premise

#### The corrected premise

Planning asserted that "every hour of delay is an hour of history you can never
recover," which drove the ingestion-first build order. Probing the feeds showed
this is **wrong for four of the five**: FIRMS, OpenAQ and both Open-Meteo feeds
all publish real archives.

**Only NWS decays.** Measured retention, by national query:

| Window | Features returned |
|---|---|
| 1–3 days ago | 500 (page cap) |
| 7 days ago | 282 |
| 30 days ago | **0** |

So retention is roughly **7–14 days**, then the data is gone upstream. The
conclusion "build ingestion first" survives, but for a different reason than
originally given: we need data to build the agent and interface against, not
because a clock is destroying history. This is the second premise imported by
analogy that did not hold on inspection (see also 3h).

**Consequence accepted deliberately:** the September 2020 seeded episode
**cannot have an advisory layer.** Four feeds cover it; the alert layer will
render a labelled "provider does not retain data before this date" state, and
the agent will say so when asked. The alternative — moving the seed to a recent
window where all five feeds have data — was rejected because the last fortnight
had almost no fire or alert activity in scope, forfeiting the dramatic episode
seeding exists to guarantee.

#### Payload findings that forced schema changes

Inspecting a real 200-feature response revealed four mismatches with the
initial schema:

| Finding | Consequence |
|---|---|
| Geometry is `Polygon`, not `MultiPolygon` (124 of 200) | Inserts would have failed outright. Fixed with `ST_Multi()` on insert, preserving the column's type safety rather than loosening it to `Geometry` |
| **38% have NULL geometry** and are zone-coded — **79% within our eight states** | Zone geometry is mandatory; see below |
| `id` is unique **per message**, not per alert (200/200 distinct) | Amendments arrive as new messages linked by `references` (61 of 200; 64 Cancels observed). Added `references_ids text[]` — without the chain, an alert *lifted early* is indistinguishable from one that simply expired, which is a timeline correctness problem |
| `status` may be `Test` (5 of 200) | Retained rather than dropped, so the record stays faithful to what was published; every product query filters `status = 'Actual'` |

Also added `same_codes` (the payload carries both UGC and SAME geocodes) and
`effective` (distinct from `onset` in some products). All applied in migration
**003**, as a new file — `001` was already applied, and the runner correctly
refuses to re-run a modified applied migration.

#### Zone geometry — lazy resolution, chosen

Since every air-quality and fire-weather alert sampled was zone-coded, without
zone polygons the advisory layer cannot be mapped or joined to stations at all.
The bulk `/zones?include_geometry=true` endpoint proved useless: it returned
601 zones with **zero** geometries, silently ignoring the parameter. Individual
zone fetches do return polygons (~66 KB, 179–1,301 points each).

**Chosen:** fetch a zone the first time an alert references it and cache it
permanently in `nws_zones`.

| Alternative | Why rejected |
|---|---|
| **Pre-load all 601 forecast zones** | Cleaner: a purely-database ingest path with no network dependency. Rejected at ~20 MB of mostly-unused geometry, when only ~16 distinct zones appeared across eight states in two weeks. |
| **Store zone codes and names only** | Zero cost, but forfeits mapping and spatial joins — gutting the "officials declared an alert here but the sensor reads moderate" conflict story that justifies this feed's inclusion. |

A zone that cannot be resolved is **recorded** with `fetch_status`, so it is not
retried every run and the resulting map gap is explainable rather than mysterious.

#### The fire-zone bug — the most consequential catch so far

The first backfill logged 18 zone failures. They were not random: `IDZ403`,
`NVZ425–427`, `ORZ670–675` — all high-numbered.

**Cause:** a Z-prefixed zone id may be a **public forecast zone** *or* a **fire
weather zone**, served on different API paths, and the id does not distinguish
them. The original code mapped any `Z` to `forecast`.

**Why it mattered disproportionately:** fire-weather zones are a different
geography entirely — BLM districts and National Forests (`Burns BLM`, `Northern
Boise National Forest`) — and **Red Flag Warnings and Fire Weather Watches are
issued against them.** Guessing a single zone type silently lost geometry for
precisely the alerts this system exists to reason about. 83 of 890 alerts were
partially unmapped, concentrated in the smoke-relevant subset.

**Fix:** a fallback chain per id shape rather than a single inferred type
(`Z` → forecast, fire, coastal, offshore; `C` → county), recording which type
succeeded. The API exposes five types: public 1058, fire 950, county 674,
coastal 240, offshore 78; `forecast` is a path alias for `public`.

**Result after re-resolution:**

| Metric | Before | After |
|---|---|---|
| Zone-coded alerts with geometry | 119/146 | **146/146** |
| Partially resolved | 83 | **1** |
| Red Flag Warnings with geometry | 0/18 | **18/18** |
| Fire Weather Watches with geometry | 0/10 | **10/10** |

**A genuine permanent gap, correctly identified:** `BCZ096`–`BCZ099` resolve
under no zone type. These are British Columbia zones that NWS references for
cross-border coordination but does not publish geometry for. They are recorded
as `not_found` — consistent with the Canadian portion of scope having no
advisory coverage, and surfaced rather than hidden.

#### Verified state after Step 3

890 alerts over 7 days, all with geometry. 467 Alert / 359 Update / 64 Cancel,
423 carrying amendment references. 425 zones cached (331 forecast, 80 county,
14 fire), 4 unresolvable. Storage: `nws_zones` 12 MB — unexpectedly the largest
table, because full-fidelity polygons total 672,000 points. Total database
34 MB against the 500 MB ceiling.

### 3k. OpenAQ — station selection, tier reality, and a roster gap

#### The access pattern is dictated by a 60 req/min limit

Probing settled the design before any code was written:

| Need | Endpoint | Cost |
|---|---|---|
| Station roster | `/v3/locations?bbox` — honours bbox | 3 requests |
| Live values | `/v3/parameters/{id}/latest` — **ignores** bbox, honours `datetime_min` | ~15 requests, filtered client-side |
| History | `/v3/sensors/{id}/hours` — one request covers a whole range (verified 168/168 hourly values for 7 days) | 1 per sensor |

Per-sensor polling for the live path was impossible: ~1,100 sensors would take
18+ minutes per run.

#### A station cap was forced, not chosen

Each retained station costs **three** hourly rows — one measurement, plus a
`weather_hourly` and a `model_aq_hourly` row, because wind and CAMS are sampled
at its coordinates. Keeping all ~2,000 live sensors would cost ~233 MB for
seven days alone against a 500 MB ceiling.

**Chosen: 800 stations**, selected by an auditable SQL function
(`select_aq_stations`) rather than hidden application logic, so the cap can be
changed without re-discovery and the sampling is reproducible.

Priority order encodes what the product needs: every live **reference** monitor
(authoritative), then **paired low-cost** sensors within 10 km of one (so
disagreement is demonstrable as a pair), then **spatial fill** — round-robin
across H3 r4 cells, so a fire has *some* downwind sensor wherever it burns.

**A correction:** the first version filled "empty" r6 cells. But r6 is ~36 km²
and 1,401 live stations occupied 766 r6 cells, so nearly every station had its
own cell and "fill the gaps" selected almost everything — 668 spatial_fill
against 42 reference, inverting the priority. Fixed by grouping at r4
(~1,770 km²) with round-robin selection.

#### The reference tier is nearly empty — accepted and surfaced

Only **42 of 856** regulatory monitors reported within 24 hours; **6 within
three hours**. Verified as a genuine upstream condition rather than stale
metadata: every station the bulk feed shows fresh is also marked fresh by
`/locations`, with zero discrepancies. AirNow has effectively stopped feeding
OpenAQ for this region.

The live network is therefore almost entirely low-cost community sensors
(AirGradient, Clarity). **Consequence accepted:** the reference-vs-low-cost
*pairing* the conflict story leaned on does not survive. Instrument tier
becomes a first-class caveat the agent must state, and conflict rests instead
on model-versus-measurement (CAMS vs sensors) and sensor-versus-sensor
disagreement — both of which have ample data.

Rejected alternatives: adding AirNow as a sixth direct feed (strongest fix, but
an unknown-latency API key plus a sixth ingester on a 3-day budget); widening
the liveness window (would pad the roster with stations producing no current
data, making the system look better-sourced than it is).

#### The roster gap — reasoned wrong, then measured

**517 locations publish fresh in-bbox readings but are absent from the roster.**

My initial reasoning said this was cheap to skip: we cap at 800 and already
discard 601 eligible stations, so more candidates change nothing.

**That was wrong, and measurement showed it.** Those 517 are not redundant with
what we have — they are *elsewhere*. They occupy 326 r4 cells, of which **182
contain no live station at all.** Closing the gap meant extending coverage from
253 to ~435 cells, a **72% gain** — and it matters for the core feature
specifically, because attribution needs a downwind sensor and fires burn in
exactly the rural terrain that well-documented urban stations do not cover.

#### Closing it — three wrong attempts, then a free answer

The first two attempts fetched each unknown location individually. Both failed:
one wedged a run for twenty minutes, the other was cut off by a session
restart. The third revealed why the approach was doomed:

- Queued location ids return **HTTP 404 "Location not found"** from
  `/v3/locations/{id}` — they are gone from the locations API while their
  measurements keep flowing. The ten minutes of lookups would have 404'd every
  time.
- `/v3/sensors/{id}` *does* resolve for them, but carries no coordinates, name,
  provider or `isMonitor` — only parameter, units and coverage.
- **The bulk measurement feed already carries coordinates for every reading.**

**Chosen: synthesize minimal stations from the bulk feed, at zero additional
API cost.** Recovered: coordinates, sensor id, parameter, readings. Not
recovered: name, provider, tier.

`aq_stations.metadata_source` records which path produced each row
(`locations_api` vs `bulk_feed_synthesized`), so a synthesized record is never
mistaken for one with full provenance. Their `instrument_tier` stays
`'unknown'` rather than being guessed — they are probably low-cost given the
pattern, but *probably* is not a basis for a claim the agent will cite.

**Verified result:** coverage 253 → **438 cells**. 3,317 stations known (2,801
full metadata, 516 synthesized); 800 selected (441 full metadata, 359
synthesized); tier composition 42 reference / 399 low-cost / 359 unknown.

#### Bugs found and fixed in this step

| Bug | Consequence had it shipped |
|---|---|
| `spatial_fill` at r6 | Selection priority inverted; coverage concentrated in dense cities |
| `sample_points` never deactivated | 968 active for 800 selected — Step 5 would sample wind at 21% more points than chosen |
| `withIngestRun` held a `PoolClient` across long HTTP work | 90s of uninterrupted fetching idled the connection past its timeout; Neon closed it mid-run. Holding a client bought nothing — these are append-only inserts, not transactions. The same latent flaw existed in the NWS zone resolver |
| Rate limiter slept a flat `reset + 1` seconds | `x-ratelimit-reset: 60` is the window *length*, not time remaining. Every near-exhaustion cost 61s, and the 429 path repeated it up to four times. Replaced with a true sliding window: the same work now takes 10s instead of wedging for 20 minutes |
| Runs abandoned by a hard crash stayed `running` forever | An unhandled `error` event bypasses the failure handler, so runs 14/15/18 would have polluted the health view permanently. `reapStaleRuns` now closes them |

One non-bug worth recording, because it looked like data loss: 938 matched
readings produced 649 rows. The diagnostic now reports why — **665 distinct
sensors, 273 feed-level repeats.** The bulk endpoint returns multiple rows per
sensor across pages, and the value-hash dedupe absorbs them. That is the third
time the append-only dedupe has caught upstream duplication, after the FIRMS
regional overlap and OpenAQ's own repeats.

### 3n. The hourly rollup that does not exist

The backfill initially reported that **every synthesized station returned zero
history** — 374 sensors attempted, none with data. Taken at face value that
would have meant the +182 cells of coverage won by synthesis existed only
going forward, with the 7-day replay window back at its original 253 cells.

Probing one sensor directly contradicted its own API:

| Query | Result |
|---|---|
| `/v3/sensors/377` metadata | `datetimeFirst` 2016-03-14, `datetimeLast` **2026-09-22T00:00Z**, 66,903 observations |
| `/v3/sensors/377/hours` | **`found: 0`** |
| `/v3/sensors/377/measurements` | **165 readings** across the same 7-day window |

**Cause:** `/hours` serves a precomputed hourly *rollup*, and that rollup was
never computed for these sensors. `/measurements` serves the raw readings —
which, for these sensors, arrive on the hour anyway, giving the same ~165
values per week that `/hours` yields elsewhere.

**Fix:** choose the endpoint from `metadata_source` rather than discovering it
per sensor. Synthesized stations go straight to `/measurements`, roster
stations to `/hours`, with a fallback either way. An earlier version tried
`/hours` first for everything and paid two requests per sensor to learn
nothing; the informed version ran 319 sensors in 319 requests with the
fallback never firing.

**Verified result:** 991/991 sensors attempted (879 with data, 112 genuinely
empty). 134,652 measurements across 1,193 stations. Daily H3 r4 cell coverage
is **434–438 across the entire seven-day history** — uniform, not merely live.
Synthesized stations contributed 65,558 rows across 359 stations, **49% of all
measurements**.

Median PM2.5 by tier came out close — low-cost 5.0, unknown 4.8, reference 5.6
µg/m³ — which matters for the conflict story: with tiers agreeing in clean
conditions, divergence during a smoke event is signal rather than baseline bias.

### 3o. PM10 is largely non-reporting — a justification that did not survive

PM10 was included in the storage budget because the PM10/PM2.5 ratio
discriminates coarse blowing dust from fine combustion smoke, letting the agent
say "that is dust, not smoke."

Measured reality: of 239 PM10 sensors on selected stations, only **20 have any
data** in the seven-day window; 209 are empty. In-bbox PM10 readings run ~220
against ~2,100 for PM2.5.

**The capability therefore exists at a small minority of stations rather than
generally.** PM10 is retained — it costs little now that it is ingested, and
where present the ratio is genuinely informative — but the agent must treat
dust-versus-smoke discrimination as available only at specific stations, never
as a claim it can make anywhere. Recorded because the justification given when
the storage budget was chosen turned out to be much weaker in practice than in
principle.

### 3p. Open-Meteo — batching, forecast rows, and a model that disagrees

#### Batching changed what the constraint was

Verified against the live API: multi-location batching accepts comma-separated
coordinate lists, and `past_days` combines with `forecast_days` in a single
call. 200 coordinates per request is safe; 400 works; 800 returns HTTP 414 on
URL length.

Consequence: **all 800 stations, seven days of history and two days of forecast,
cost about four requests.** After OpenAQ's 60 req/min grind — where requests,
not storage, were binding — this feed inverted the calculus entirely.

That reopened one earlier decision. "Wind and CAMS at stations, not on a grid"
had been chosen on cost, and cost meant requests. With requests nearly free,
only storage counted, so **CAMS was additionally sampled on a coarse H3 r3 grid
(546 cells)**: a model's value is partly to cover ground that has no sensors,
which is most of fire country, and sampling it only where sensors already exist
forfeits exactly that. **Wind stayed at station and fire precision** — Open-Meteo
resolves ~9–11 km, and 69 km cells would smooth away the valley channeling that
drove the September 2020 episode.

#### Request weighting, found by instrumenting

A dry run reported 5 requests for 4 batches with zero retries and 33 seconds
elapsed — a signature that only made sense as a hidden rate-limit wait.
Instrumenting it confirmed **a 429 after 3 requests**: Open-Meteo weights by
request *cost*, and a 200-location, 7-variable, 9-day call consumes far more
than one unit.

**Consequence for the cron (Step 6): the hourly run requests `past_days=1`,**
so it stays cheap in rows and bandwidth; the seven-day pull is a one-off
backfill.

**A correction to that reasoning.** I first claimed `past_days=1` "cuts the
request weight roughly fourfold". Measuring it disproved that: with
`past_days=1`, a 429 still lands after ~4 requests, exactly as with
`past_days=7`. The limit tracks **locations per request** (or simply requests
per minute), not the time span requested. `past_days=1` is still right for the
cron, but for a different reason than the one originally given.

#### Forecast rows — the bitemporal design doing real work

**Chosen: ingest 48 hours of forecast alongside history.** A forecast value is
superseded by analysis as time passes, arriving as a *new row with a later
ingest_time* rather than overwriting — so "what we expected the wind to do" and
"what it actually did" stay separable, and the replay can show both. This is the
clearest payoff yet from Decision 3a.

Rejected: history only (simpler queries, but leaves a third of the chosen
question — "where is it heading next" — unanswerable).

#### The most important data-quality finding so far

Comparing modelled against measured PM2.5 at co-located station-hours:

| Metric | Value |
|---|---|
| Paired station-hours | **112,917** |
| Mean observed PM2.5 | 5.73 µg/m³ |
| Mean modelled PM2.5 | **8.13 µg/m³** (42% high) |
| Correlation | **0.118** |

CAMS runs systematically high and tracks ground sensors only weakly. **The agent
must never present modelled and measured values as interchangeable**, and any
answer resting on CAMS where no sensor exists carries a materially weaker claim
than one resting on a measurement.

One caveat stated honestly: present conditions are clean — median 5 µg/m³, p95
under 20 — and correlation is naturally weak with little dynamic range. Whether
CAMS tracks reality during an actual smoke event is a question the September 2020
seed can answer, with readings past 500 µg/m³. That measurement is worth taking
before drawing a firm conclusion.

#### Verified result

`weather_hourly` 172,800 rows (136,000 analysis / 36,800 forecast);
`model_aq_hourly` 290,736 rows (228,820 / 61,916), spanning 2026-09-15 to 09-23.
Wind direction distribution is plausible for the West Coast in September (W/NW
dominant, E/NE least common). Boundary-layer height ranges from **50 m at p10**
to 1,305 m at p90 — the low end being severe trapping, which is how a moderate
fire produces hazardous surface readings.

### 4e. Storage: the constraint has arrived

**267 MB of 500 MB used after Step 5.**

| Table | Size |
|---|---|
| `model_aq_hourly` | 102 MB |
| `aq_measurements` | 65 MB |
| `weather_hourly` | 59 MB |
| `nws_zones` | 12 MB |
| everything else | ~29 MB |

Remaining: ~233 MB for the September 2020 seed, `smoke_attributions` and
`hourly_frames`. At the density observed here, a 5–6 day seed across four feeds
would cost roughly 125 MB, leaving ~105 MB for the derived layer.

That fits, but without much room, and the attribution table is the hardest in
the system to size in advance. **The levers, in the order they should be pulled:**
narrow the seed window; drop the CAMS grid for the seed only (117,936 rows is
the single largest line item and the seed's value is concentrated where sensors
existed); reduce seed scope to Oregon and Washington, where the record readings
occurred.

### 3r. Fire clustering — parameters from measurement, identity from membership

7,431 detections are not 7,431 fires: the busiest H3 cell alone holds 1,577
detections of one complex. Clustering gives the agent entities it can name,
track and compare over time.

#### Parameters were measured, not guessed

Nearest-neighbour distance between detections: **p50 84 m, p90 376 m, then p99
jumps to 28 km.** Detections pack far tighter than the 375 m pixel because
three satellites across multiple overpasses report the same fire at slightly
offset coordinates; the gap between ~400 m and ~28 km is where fires separate.

DBSCAN proved insensitive across that gap — 545 clusters at eps=750 m versus
427 at eps=5000 m, a 6.7× parameter change moving the answer by 22%. That
insensitivity *is* the evidence that the groups are real rather than an
artifact of the threshold.

**Chosen: eps 1500 m, minpoints 2**, in EPSG:5070 so eps is true metres —
degrees would be anisotropic across 31–60N, where a longitude degree shrinks
from ~95 km to ~62 km. minpoints=2 keeps small fires as real entities and
qualifies them by confidence rather than discarding them; minpoints=4 was
rejected because it pushes ~9% of detections into noise, including genuine
small fires only a couple of overpasses caught.

**Chosen: 48 h temporal split.** The maximum gap observed *within* a
continuously burning fire is 14–24 h — satellite overpass spacing and cloud
cover, not extinction. 48 h clears that, so no fire is fragmented by a cloudy
day, while a genuine re-ignition after two days' silence becomes a separate
fire.

#### Identity through membership, not geometry

Fuzzy spatial matching between runs is the obvious approach and the fragile
one. But **detections are immutable rows with stable ids**, so "which cluster
did this detection belong to last run" is an *exact lookup*. Clustering is
therefore recomputed freely and identity inherited through detection overlap:

| Prior clusters sharing detections | Action |
|---|---|
| 0 | new key, derived from the earliest detection's `observation_key` |
| 1 | inherit that key |
| 2+ | **merge** — survivor is the largest contributor, ties to the older fire |

A merge is recorded in `fire_cluster_merges`, not hidden: two fires growing
into one another is exactly the kind of change the timeline should show, and if
the agent named a fire yesterday it must be able to explain where that name
went. `resolve_cluster_key()` follows merge chains so a stale key still
resolves.

| Alternative | Why rejected |
|---|---|
| **Incremental assignment, never recluster** | Cheapest, ids never change. Rejected because clusters chain outward over time and absorb neighbours, and an early bad grouping can never be corrected. |
| **Deterministic key from H3 cell + time bucket** | Perfectly stable with no matching logic. Rejected because arbitrary cell boundaries would split any fire straddling one, reporting a single fire as two. |

**Verified:** an immediate re-run reported `created=0 inherited=617 merged=0` —
every identity preserved.

#### FIRMS detects industrial heat as fire

A persistence analysis surfaced clusters burning continuously for a week at a
fixed ~500 m footprint with steady intensity. Checked against known locations,
they are **refineries and industrial plants**: the Athabasca oil sands
(57.0, −111.5), four separate gas-flaring sites around Grande Prairie, Alberta
(54.86–54.97, −118.3 to −118.5), Ferndale WA's refineries, Seattle's Duwamish,
Victorville's cement plants, a Utah power station.

**FRP variability separates them cleanly, because the physics differ** — a
wildfire's intensity swings as it consumes fuel and the weather shifts, a flare
burns steadily:

| | Footprint spread | FRP CV |
|---|---|---|
| Wildfires | 1,458–4,799 m | **0.63–2.60** |
| Industrial | 291–610 m | **0.30–0.37** |

**Chosen: flag, do not exclude.** A refinery is a real emission source — a
station downwind of Ferndale genuinely reads elevated PM, and excluding the
source would leave that reading with no attributable cause. What matters is
that the agent never calls it a wildfire. `source_character` is
`likely_wildfire` (88 clusters, 84% of total FRP), `likely_industrial` (34), or
`indeterminate` (495, fewer than 10 detections — too sparse to characterise
either way, and saying so beats guessing).

#### Labels: honest coverage over broad coverage

NWS zone names read like a person's description of a place — the headline fire
is labelled **"Yosemite NP outside of the valley"** — which is what makes them
useful and equally why attaching the wrong one matters.

The first heuristic took the nearest zone within 60 km. Measured, it named a
**neighbouring** zone rather than the containing one **223 times out of 358**,
including 18 clusters in Mexico and 6 in Canada carrying US place names.
"Imperial" for a fire 30 km inside Baja California is precisely the kind of
statement the agent would cite and be wrong about.

**Chosen: label only where the centroid lies inside the zone.** Coverage drops
to 135 of 617 and every label is a true statement; the remainder are described
by coordinates and region. Coverage is bounded not by the rule but by the
cache: only 429 zones are stored, being those an alert happened to reference.
Pre-loading all ~1,550 zones would raise coverage at roughly 20 MB — declined
for now against a storage budget already at 267 MB with the 2020 seed pending.

### 3v. Smoke attribution — the system's one causal claim

This is the only place the system asserts causation, so it is framed as a
**hypothesis carrying its evidence** rather than a conclusion. Every row stores
the numbers that produced it: distance, wind alignment, travel time, fire
intensity at the hour the smoke would have departed, and mixing depth.

#### It had to be bounded, and the bounds are principled

Unbounded this is **800 stations x 576 hours x 617 fires = 284M pairs.** Two
bounds reduce it to ~1,300 stored rows:

1. **Only attributable fires** — 122 of 617. The excluded 495 are
   `indeterminate` (fewer than 10 detections) and carry 13.6% of FRP between
   them; they could not be meaningfully attributed to a downwind reading.
2. **Only station-hours with something to explain** — PM2.5 at 2x the
   station's *own* 7-day median AND at least 8 µg/m³. Relative because
   low-cost sensors carry different offsets, so a fixed threshold would miss
   real elevation at a clean rural station and over-trigger at an urban one;
   the absolute floor stops a 1→2.5 µg/m³ rise counting as an event.
   **Attribution explains anomalies, not baselines.**

#### Travel time: a single-step back-trajectory

Smoke from 100 km away at 20 km/h departed five hours ago, so **the fire's
state then is what matters** — scoring against its intensity on arrival would
credit a fire that had only just ignited.

There is a circularity: travel time depends on wind speed, which one would want
at the departure hour, which depends on travel time. It is broken by estimating
the lag from wind speed at the *arrival* hour, then reading wind direction and
fire intensity at the resulting earlier hour. Fire intensity is summed over a
±90-minute window, because a satellite overpass need not coincide with the
exact hour.

Rejected: ignoring lag entirely (wrong by hours at regional distances); a full
iterative trajectory through the curved wind field (physically strongest, too
much modelling risk with two days left).

#### Scoring

Four interpretable factors, each stored separately so the agent can say *which*
one carried the claim:

| Factor | Form | Meaning |
|---|---|---|
| `alignment_factor` | exp(−(θ/30)²) | did the wind point from fire to station |
| `distance_factor` | 1/(1+(d/50)²) | dilution with distance |
| `frp_factor` | ln(1+FRP)/ln(5001) | fire intensity, log-scaled |
| `pbl_factor` | clamp(800/PBL, 0.5, 2.5) | shallow mixing concentrates smoke at the surface |

A continuous decay by misalignment was chosen over a hard cone, with a 90° cut
(beyond which it is not downwind at all). Storing `alignment_deg` means the
agent can distinguish "aligned within 2°" from "within 40°" instead of both
reading as merely *inside the cone*.

#### Results, including the one that matters most

**Only 20.9% of elevated station-hours (1,015 of 4,858) have a plausible
upwind fire.** The remaining 79% have none — and that is the correct answer,
not a coverage failure. Urban PM2.5 comes from traffic, industry, dust and
cooking; a system that attributed every elevated reading to wildfire smoke
would be wrong most of the time. **The agent must be able to say "nothing
explains this."**

Strongest attributions are physically coherent: 27.7 µg/m³ at **8.15x** the
station baseline, 58.8 km from the Yosemite complex, wind aligned to 7.4°, 6.3
hour lag, 3,530 MW at departure. Alignments of 2°, 7°, 8° are not coincidences.

**239 station-hours are explained only by industrial sources.** The
`all_industrial` flag exists precisely so the agent does not report those as
wildfire smoke.

Mean factor values expose where the scoring gets its discrimination:
alignment 0.609 (mean 21.1°), distance 0.238 (mean 132 km), frp 0.331, and
**pbl 2.148** — close to its 2.5 cap, because median mixing depth is 340 m.
The PBL factor therefore discriminates mainly by *excluding* deep-mixing
afternoons rather than by grading, and elevated readings concentrate at night
and early morning. Physically right, and worth stating rather than leaving the
factor to look more discriminating than it is.

## Decision 4 — Storage and hosting

Candidate infrastructure was verified against current pricing and feature documentation
rather than assumed. Two fashionable options were eliminated by that verification.

| Option | Verdict | Evidence |
|---|---|---|
| **ClickHouse Cloud** | Rejected | No permanent free tier. 30-day trial with $300 credits that **expire with the trial**, then ~$66/month minimum and ~$186/month running 24/7. Adequate for a review window, dead afterwards. |
| **Supabase + TimescaleDB** | Rejected | TimescaleDB is deprecated on Postgres 17+ and cannot be enabled on new projects (TSL relicensing). `pg_cron` requires a background worker and is gated to Pro. |
| **Neon + TimescaleDB** | Rejected | Only the Apache-2 edition is available; compression is explicitly unsupported and continuous aggregates are undocumented and likely TSL-gated — removing the main reason to choose it. |
| **Neon + PostGIS** | **Chosen** | Free tier durable past the review window; PostGIS available. |

### 4a. Store — Neon Postgres + PostGIS

**Reasoning — the data is small, and that drove the choice.** Sizing the workload first:
~700 fire detections/day, ~1,000–1,500 OpenAQ stations reporting hourly, weather and CAMS
sampled at points, plus the attribution table. Across the FIRMS 7-day archive, the seeded
2020 episode, and three days of live capture, this is on the order of **100–300 MB**.

At that size neither ClickHouse nor TimescaleDB earns its complexity — plain Postgres with
sensible indexes and materialised rollup tables serves every query in single-digit
milliseconds. Selecting a time-series engine here would have been résumé-driven, and being
able to say so plainly is worth more than the label.

**Accepted constraint:** the Neon free tier is **0.5 GB**. Mitigations, designed in from
the start: sample gridded feeds at points rather than on a dense grid; keep PM2.5 as the
primary parameter; use narrow column types. If the 2020 seed threatens the ceiling, it
narrows to Oregon and Washington — where the record readings occurred.

### 4b. Ingestion trigger — GitHub Actions cron

| Alternative | Why rejected |
|---|---|
| **Vercel Cron** | **Eliminated by verification.** The Hobby plan permits cron **once per day** with ±59 minute precision; more frequent expressions fail at deployment. Unusable for a ~10-minute ingester without upgrading to Pro. |
| **Cloudflare Worker cron trigger** | Genuinely good: 1-minute granularity, reliable timing, five triggers free, reads as more production-grade. Rejected for the **50 external subrequests per invocation** cap on the free plan and the cost of learning a second runtime under deadline. |
| **Long-running worker on a small VM** | Full control over scheduling, retries, and backfill with no platform caps. Rejected as the largest operational surface to build and monitor, for a few dollars a month. |

**Reasoning:** a plain Node/TypeScript script with no subrequest cap, trivial to debug,
and visible in the repository for reviewers.

**Accepted cost:** GitHub Actions scheduling drifts and can be skipped under load. This is
tolerable because `ingest_runs` logs every attempt with its intended event-time window —
so a missed run makes the resulting gap **provable rather than silent.** Given that the
system's data-quality thesis is honest treatment of gaps, a cron that occasionally skips
is a demonstrable feature with a story attached.

A batching technique adopted regardless of host: **Open-Meteo accepts comma-separated
multi-location queries**, collapsing dozens of sample points into a single HTTP call.

### 4d. Database drivers — two, each in its designed place

**Chosen:** `pg` (node-postgres) for ingestion scripts and server-side jobs;
`@neondatabase/serverless` for Next.js route handlers.

**Reasoning:** the ingesters need long-lived pooling, real transactions and
efficient multi-row inserts, which is what `pg` is built for.
`@neondatabase/serverless` is built for serverless request/response and is the
better fit inside route handlers. Standardising on one driver was considered and
rejected: it would have meant accepting the wrong tool in one of the two places
for the sake of a tidier dependency list.

**Provenance made an invariant.** `lib/db.ts` exposes `withIngestRun`, which
opens a run row, hands it to the caller, and closes it with its outcome —
*including on throw*, where it is closed as `error` with the message. The run row
is committed immediately on open, deliberately outside the caller's transaction:
wrapping both together would roll back the very evidence of the failure. The
effect is that a crashed ingester leaves an explanatory record rather than a
silent hole, which is what lets the agent distinguish *"no fires were detected"*
from *"we failed to look."*

### 4c. The new technology — DuckDB-WASM + Parquet, client-side

**Chosen:** precompute hourly frames, export them to a compact Parquet file, ship it to
the browser, and query it client-side with DuckDB-WASM. The Node DuckDB bindings write
the Parquet server-side, so the same engine appears on both ends.

| Alternative | Why rejected |
|---|---|
| **DuckDB-WASM plus H3 spatial indexing throughout** | Stronger story if both landed, but two unfamiliar technologies on a 72-hour clock. H3 is still used for bucketing, but is not the showcase. |
| **Self-hosted ClickHouse as the engine** | Strongest scaling narrative and a natural fit for append-only bitemporal data, with native H3 functions. Rejected as the highest risk of consuming a day that does not exist, plus ongoing hosting cost. |

**Reasoning, and why this placement is defensible rather than decorative:** the real
performance problem in this system **is not the database.** It is the scrub. Every
timeline position needs a frame, and a round trip to Postgres per frame costs 50–150 ms —
which feels like molasses while dragging a handle, especially for a reviewer far from the
database region.

Moving the frames into the browser makes scrubbing **zero-latency**, because it never
touches the network. Postgres remains the bitemporal source of truth that the agent
queries for precision; the browser holds an analytical replica for interaction. That is a
clean read/write path separation, it is justified by a stated requirement rather than by
novelty, and its blast radius is contained — if DuckDB-WASM misbehaves, the timeline falls
back to server queries and nothing else breaks.

---

### 4f. Ingestion scheduling — and why the repository is public

**Chosen: GitHub Actions with per-feed cadences** — NWS every 15 min, FIRMS
every 30 min, OpenAQ `latest` plus Open-Meteo wind hourly, **CAMS every 6
hours**, OpenAQ roster refresh daily. 173 scheduled runs/day across five
workflows.

**CAMS is 6-hourly because the model sets the cadence, not us.** Measured: an
hourly run 30 minutes after a full pull returned **0 new rows from 96,912
fetched** — the value-hash dedupe correctly rejecting every one, because CAMS
publishes on a ~12h cycle. Polling twice per cycle picks up an update within
six hours instead of spending ~200 requests a day and ~30 minutes of
rate-limit waiting to discard identical data. It also cut the hourly job from
~4 minutes to ~2. Wind stays hourly for the opposite reason: the same 30-minute
gap produced **36,240 revised rows**, because forecast values genuinely change
— which is the bitemporal design doing exactly what it was built for.

**The repository was made public to make this possible.** Actions minutes are
unlimited for public repositories but capped at 2,000/month for private ones,
and the designed schedule costs ~11,640 min/month — roughly six times the
private cap. Per-run cost is not one minute either: checkout, Node setup and
`npm ci` precede the ingester, and a heavy Open-Meteo run is 2–3 minutes.

| Alternative | Why rejected |
|---|---|
| **Private, one workflow every 2 hours** (~1,260 min/month) | Fits the cap and keeps the solution unpublished. Rejected on freshness: two-hour polling against a five-minute alert feed, and the declared staleness thresholds would have to be relaxed to match what the platform allowed rather than what the data deserves. |
| **Private, hourly, accept overage** | Best freshness while private, but 2,160–2,880 min/month exceeds the cap — billed or suspended. |
| **Off-platform worker on a VM** | Full scheduling control, no caps, no publishing. Rejected as the largest operational surface to build and monitor on a 3-day budget, for a few dollars a month. |

A secondary consequence that made the private options worse than they first
looked: our source registry declares staleness thresholds (1h for NWS, 2h for
OpenAQ) which the health view measures against. Under two-hour polling those
feeds would report as **perpetually stale** — technically honest, but
misleading when we are polling as fast as the platform permits. Publishing
avoided having to choose between a dishonest threshold and a permanently red
health indicator.

**Cadence is aligned with the declared registry** (migration 011): NWS moved
from 300s to 900s, because `cadence_seconds` is a claim about how often *we*
refresh and it should describe what we actually do. 15 minutes is a deliberate
choice rather than a budget artifact — alerts are issued sporadically, the
staleness threshold is an hour, and polling a public government API four times
faster for no gain in answer quality is not reasonable use.

**Hourly Open-Meteo uses `past_days=1`, not 7** -- to keep rows and bandwidth
down, not to dodge rate limiting, which it does not (see the correction in 3p).

Three operational details worth stating: every workflow declares a
`concurrency` group so a slow run cannot overlap the next tick and race on the
same rows; every workflow has a `timeout-minutes` ceiling; and every workflow
exposes `workflow_dispatch` for manual runs. GitHub delays scheduled runs under
load and may skip them outright — `ingest_runs` records each attempt with its
intended window, so a missed tick is a **provable gap** rather than a silent
hole.

**A bug caught before it shipped:** the hourly workflow's three commands were
first emitted as a plain YAML scalar, which folds newlines — so the three
`npm run` invocations would have become a single malformed command. Caught by
parsing the generated files with a real YAML parser rather than reading them.
Fixed with a literal block scalar (`run: |`).

### 4g. Freshness is measured over recurring runs only

The first CI cron run succeeded and wrote to the database — and immediately
exposed a flaw in the health model. Both `nws_alerts` and `openaq` reported
**stale minutes after succeeding.**

**Cause:** the pessimistic rollup from 3f ("a source is only as fresh as its
weakest variant") treated one-off maintenance passes as if they were
continuously-refreshed feeds:

| Variant | What it is |
|---|---|
| `nws_alerts / zone_geometry` | the `--resolve-zones` repair pass |
| `openaq / backfill:7d` | the historical backfill |

Each ran once, correctly, and will never run again — so each was permanently
stale and dragged its whole source down with it.

The pessimism itself is right, and stays: if one of three VIIRS satellites
stops publishing, that must surface. The error was the population it was
computed over.

**Fix:** `cadence_seconds` is a claim about the **cron** schedule, so freshness
is now measured against cron runs only. The health model distinguishes four
genuinely different states rather than collapsing them:

| State | Meaning |
|---|---|
| `fresh` | a scheduled run succeeded within the staleness threshold |
| `stale` | scheduled runs exist, but the most recent success is overdue |
| `one_off` / `not_scheduled` | never ran on a schedule — maintenance history, excluded from the rollup |
| `never_succeeded` | scheduled, but no successful run yet |

`last_ok_any_at` still reports the most recent success of any kind, because
provenance wants the full picture even where freshness does not. "We have never
scheduled this" and "this is overdue" are different facts, and the agent has to
be able to say which one it means.

**An implementation note worth keeping:** the migration initially failed with
`cannot change name of view column "last_attempt_at" to "last_ok_any_at"` —
`CREATE OR REPLACE VIEW` cannot reorder or rename columns, and the new revision
inserted a column mid-list. Fixed with explicit `DROP VIEW` in dependency
order. The failure cost nothing because the migration runner wraps each file in
its own transaction, so it rolled back unrecorded and re-ran after the fix.

### 4h. CI verification of the pipeline

The first `workflow_dispatch` run failed with HTTP 400: `/alerts/active`
rejects the `limit` parameter that `/alerts` requires.

**Why it escaped local testing, which is the more useful lesson:** every local
run had used `--days=N`, the *backfill* path through `/alerts`. The active path
— the one the cron executes 96 times a day — had never been exercised. I had
thoroughly validated the code I was iterating on and shipped the scheduled path
untested.

**Corrective practice adopted:** extract the exact command from each workflow
file and run *that*, rather than an approximation. Doing so immediately found
that FIRMS `--window=24h` had also only ever been dry-run (it works — 288 new
detections, rest deduped), and disproved the `past_days=1` rate-limit claim
recorded in 3p.

**Verified end to end:** run #2 succeeded, and `ingest_runs` row 41 records
`trigger_kind=cron, status=ok, rows_inserted=1`. GitHub Actions → repository
secrets → ingester → Neon is a working path.

### 4i. Frames, and two aggregation lessons

`hourly_frames` is one row per (hour, H3 r4 cell) — 165,012 rows across 180
hours and 1,111 cells, **28 MB**. They are written **sparsely**: only cell-hours
where something was observed, because a cartesian product over hours x cells
would be mostly empty. r4 (~1,770 km², 26 km edge) is fine enough for a
regional map and coarse enough that a week of frames stays a small Parquet file
for the browser.

`is_partial` and `missing_sources` make a gap **visible rather than
interpolated**, and crucially they are computed against *expectation*: a cell
with no station was never going to carry observed air quality, so reporting
that as a gap would be noise. Only a cell that normally carries a feed and has
none this hour is partial. Result: 156,963 complete frames, 7,569 missing only
`openaq`, 403 missing two feeds, 77 missing all three.

#### Lesson 1: a regional maximum is not a regional condition

The first timeline view plotted `max(us_aqi_max)` across every cell. The line
sat flat at **350–366 ("Hazardous") every hour**, while the regional median AQI
was **39**.

The data was fine — AQI distribution is p50 39 / p90 59 / p99 79, internally
consistent with its own PM2.5 (AQI 0–50 averages 4.6 µg/m³; AQI 301+ averages
306.8). **Only the aggregation was wrong.** A maximum over 3 million km² is
always extreme somewhere, so it reported the worst single station as though it
were the regional state — technically true, practically a lie.

Replaced with percentiles (p50 / p90 / p99), with the maximum retained but
renamed `pm25_worst_cell` and `us_aqi_worst_cell` so a single hot station
cannot masquerade as the regional condition. The corrected series reads
sensibly: p50 4–5, p90 10–14, p99 24–37, worst cell 88–694.

#### Lesson 2: wind direction cannot be averaged arithmetically

Averaging 350° and 10° arithmetically gives 180° — the exact opposite
direction. Frames use a vector mean (`atan2` of mean sine and mean cosine).
Worth recording because the arithmetic version would have produced plausible
numbers that were systematically wrong, and attribution depends on direction.

#### Corroboration: what to do with a 985 µg/m³ reading

The most extreme observations have no attributable fire, and a neighbour
comparison explains why:

| Reading | Tier | Neighbours within 25 km | Their median | Ratio |
|---|---|---|---|---|
| **985 µg/m³** | **reference** (AirNow) | 8 | 10.0 | **99x** |
| 707 | low_cost | 4 | 4.9 | **144x** |
| 731 | low_cost | 5 | 13.0 | 56x |
| 694 | low_cost | **0** | — | uncorroborable |

Eight stations reading ~10 while one reads 985 is close to conclusive: a sensor
artifact or an extremely local source, not regional smoke — and notably it is a
*reference-grade* monitor, so instrument tier is no guarantee.

`v_reading_corroboration` exposes the neighbour comparison rather than a
verdict. A 130x spike could be a structure fire or a calibration fault, and the
honest move is to give the agent the evidence and let it say which is
plausible. Where a station has no neighbours, the view reports that rather than
implying anything.

## Decision 5 — The agent

### Governing principle: the model never performs arithmetic

If the model computes *"PM2.5 is 3.2× the baseline,"* it will occasionally be wrong, and a
wrong number is fatal in a grounded-answer product. If a tool returns
`{value: 47.2, baseline: 14.8, ratio: 3.19}` and the model only composes prose around it,
the number is always right. Every quantity in a final answer originates in a tool result.

### 5a. Data access — curated tools only

**Chosen:** nine parameterised tools; no raw SQL surface.

| Tool | Purpose |
|---|---|
| `resolve_place` | Resolve "Portland", "the Sierra", "near Yosemite" to coordinates and bbox |
| `get_air_quality` | Station readings — observed **and** modelled, side by side |
| `get_fires` | Fire clusters and detections, filterable by FRP and confidence |
| `get_wind` | Wind vector series for a place and time range |
| `get_alerts` | NWS alerts, active or historical |
| `explain_smoke` | Attribution: contributing fires, wind alignment, distance, score |
| `compare_time` | Change between two moments |
| `rank_places` | "Where is the worst air right now" |
| `get_data_health` | Per-feed freshness, last successful ingest, known gaps |

| Alternative | Why rejected |
|---|---|
| **Curated tools + sandboxed read-only SQL** | More flexible and more impressive live. Rejected for weaker grounding guarantees and a real surface to secure, against a "reliable, grounded answers" bar. |
| **Text-to-SQL as the primary path** | Maximum flexibility. Rejected for unbounded queries that can exhaust the database, hallucinated columns, and citations that cannot be guaranteed. |

**Accepted cost:** questions outside the tool surface receive an honest *"I can't answer
that."* This is considered correct behaviour, not a limitation.

### 5b. The provenance envelope

Every tool returns the same wrapper, which is where provenance and data quality live:

```ts
{
  data: [...],
  provenance: { source_id, source_url, record_ids[], event_time_range, ingest_time, row_count },
  quality: { as_of, age_seconds, is_stale, gaps: [{start, end, reason}], conflicts: [...] }
}
```

The three data pathologies map onto it directly:

- **Stale** → `age_seconds` compared against the feed's declared `staleness_seconds`.
- **Missing** → explicit `gaps` with reasons such as *"no VIIRS overpass 06:00–18:00"*, so
  the agent states the gap rather than interpolating across it.
- **Conflicting** → `get_air_quality` returns OpenAQ, CAMS, and alert status together with
  a `conflicts` flag when they diverge, so the agent surfaces disagreement instead of
  silently selecting a winner.

### 5c. The bitemporal payoff — `as_of`

Every tool accepts an optional `as_of`. The default is *now* (best current knowledge).
When the user scrubs the timeline to a past moment and asks a question, the interface
passes that position as `as_of`, and **the agent answers as the world was known then.**

This is the single choice that makes the timeline and the conversation *one instrument*
rather than two features sharing a page, and it is only possible because Decision 3a chose
bitemporal storage.

### 5d. Agent loop — SDK Tool Runner

**Chosen:** `client.beta.messages.toolRunner`.

| Alternative | Note |
|---|---|
| **Manual tool-use loop** | Was the original recommendation: ~40 lines, fully predictable, no beta dependency, precise control over the SSE event protocol. Not selected. |
| **Managed Agents** | Anthropic hosts the loop and a per-session sandbox. Rejected because no sandbox is needed, the tools query our own Postgres, and it adds latency and concepts the system does not require. |

**Reasoning for the selection:** materially less code, with per-turn hooks available for
logging and interception.

#### A verified incompatibility and its resolution

Documentation confirms that **structured outputs are produced by
`client.messages.parse()`, a different method from `client.beta.messages.toolRunner()`**;
there is no documented way to pass `output_config.format` to the Tool Runner. Decisions 5d
and 5e therefore do not compose directly.

**Resolution — two-phase, splitting the work the way the task splits:**

1. **Gather.** `toolRunner({ ...params, stream: true })` drives the tool loop, streaming
   per-tool progress to the interface ("checking 47 stations…"). Evidence accumulates in
   the message history.
2. **Compose.** One `client.messages.parse()` call over that accumulated history with
   `zodOutputFormat(ClaimsSchema)`, producing the typed claims-and-citations object.

This is preferable to a workaround rather than merely acceptable: because composition is a
separate call, **every citation ID in the output can be validated against the record IDs
the tools actually returned, and the compose step retried alone** if a claim came back
uncited — without re-running any tool work. Citation integrity becomes enforcement rather
than a prompt instruction, and the retry is cheap because the gather history is cached.

**Two documented pitfalls carried into implementation:** with `stream: true`, each runner
iteration yields a *stream* rather than a message, so a bare `stop_reason` check silently
never fires; and `parsed_output` is `null` on parse failure, requiring a guard rather than
an assertion.

### 5e. Grounded output — structured claims with citations

**Chosen:** the answer returns as typed claims, each carrying citation record IDs, which
the interface renders as clickable evidence chips.

**Alternative rejected:** prose with inline `[ref:...]` markers. More fluid and
human-sounding writing, but citation completeness becomes best-effort rather than
verifiable.

**Reasoning:** it permits programmatic rejection and retry of any uncited claim.

**Accepted cost, stated honestly:** the final answer cannot stream as progressive prose,
because complete JSON is required to parse it. Latency sits mostly in the gather phase, so
the experience becomes "watch the agent work, then the answer lands" — which arguably
reads as more trustworthy than text typing itself out.

### 5f. Model and latency posture

**Chosen:** `claude-opus-5` (1M context; $5 / $25 per MTok) with **effort routing** —
`effort: "low"` for single-fact lookups, `"high"` for multi-hop attribution questions.

| Alternative | Why rejected |
|---|---|
| **Opus 5 fast mode** | Up to 2.5× output speed for the most responsive feel. Rejected on premium pricing ($10 / $50 per MTok) and research-preview status requiring a separate rate-limit fallback path. |
| **Sonnet 5** | $2 / $10 per MTok and lower default latency, cheaper to iterate against. Rejected for reduced reasoning quality on the harder multi-hop attribution questions, which are the system's core value. |

Supporting settings: adaptive thinking (`thinking: {type: "adaptive"}`); streaming
throughout; prompt caching on the stable prefix (tool definitions and system prompt are
large and frozen, so caching cuts both latency and cost materially); **server-side refusal
fallbacks** (`fallbacks: "default"`) so a classifier decline degrades gracefully rather
than returning an empty answer; and `eager_input_streaming` on client tools with schema
validation on every parsed tool input, since the tolerant parser can return a silently
truncated object.

### 5g. Verification — golden question set

A ~20-question set covering expected tool calls, expected groundedness, and expected
**refusals** for questions the data cannot answer. This is the clearest single signal
separating a production agent from a demo. Scheduled as a day-3 stretch goal, and first in
the cut order (Decision 7).

---

## Decision 6 — The interface

The brief asks for *"a single interface for exploring questions in natural language,
following evidence to its source, and replaying change over time."* The word **single** is
doing work. The map, timeline, and conversation are therefore designed as **one
instrument**: asking a question moves the map and the clock, and scrubbing the clock
changes what the agent knows via `as_of`. Anything less would be three widgets on a page.

### 6a. Layout — map-dominant, with docked chat and timeline

Map fills the view; the timeline spans the bottom and is permanently visible; chat docks
to one side.

| Alternative | Why rejected |
|---|---|
| **Conversation-dominant, map as answer artifact** | Makes the agent the star and the NL requirement unmissable. Rejected because the timeline becomes secondary and replay feels bolted on. |
| **50/50 split-pane** | Honours both requirements literally and is simple to build. Rejected because neither side gets enough room and it reads as two tools stapled together. |

**Reasoning:** spatial data reads best this way, and a permanently visible timeline is
what the replay requirement is actually asking for.

### 6b. Map stack — MapLibre GL

| Alternative | Why rejected |
|---|---|
| **deck.gl over MapLibre** | GPU-accelerated layers built for large point clouds with strong animated transitions, which would suit plume replay. Rejected as more power than ~700 points and ~1,500 stations require, plus another library to learn on the clock. |
| **Leaflet** | Simplest and fastest to wire up. Rejected as raster-oriented with jerkier animation — weak at exactly the smooth continuous transitions the scrubbing criterion grades. |

**Reasoning:** open source, no API token, no billing surprises, vector tiles, smooth
animation, and comfortably sufficient for our data volume.

### 6c. Cold open — seeded state plus example questions

The interface lands on a live view already centred on real activity, with three or four
clickable example questions and the timeline pre-positioned at the seeded episode.

| Alternative | Why rejected |
|---|---|
| **Guided tour walkthrough** | Most controlled demo, guarantees the best features are seen. Rejected on build time and because it can read as a canned pitch. |
| **Empty state with a prompt box** | Clean and confident, lowest build cost. Rejected because it makes the reviewer guess the system's capabilities, and one poor first question makes a good system look weak. |

**Reasoning:** a reviewer opening the URL cold sees the system working within seconds,
without typing.

---

## Decision 7 — Risk posture and cut order

### Build order

Ingestion precedes everything. Phase 0 targets **data accumulating within three hours**,
because every hour of delay is an hour of history that cannot be recovered later.

| Phase | Work |
|---|---|
| **Phase 0** (first 2–3 h) | Repo, Neon provisioned, schema migrated, three keyless ingesters (FIRMS, Open-Meteo, NWS) live on GitHub Actions cron |
| **Day 1 remainder** | OpenAQ + CAMS ingesters, fire clustering, hourly frames rollup, FIRMS 7-day and Open-Meteo archive backfill, seed the 2020 episode |
| **Day 2** | Upwind-cone attribution engine; the agent — nine tools, gather loop, compose call, citation validation, query routes |
| **Day 3** | Map, timeline, DuckDB-WASM Parquet path, chat panel, evidence drawer, freshness strip; deploy; cold-open seeding; this document |

### Identified risks

| Risk | Mitigation |
|---|---|
| **The schema must be correct first time** — a change on day 2 costs the accumulated history, the one thing that cannot be rebought | Bitemporal and provenance columns settled in Phase 0; additive changes only thereafter |
| **OpenAQ key latency** | Build the four keyless feeds first so the key is never on the critical path |
| **DuckDB-WASM is the new technology, therefore the unknown** | Hard timebox on day 3 with a server-query fallback behind it |
| **2020 seed size versus the 0.5 GB ceiling** | Narrow the seed to Oregon/Washington if threatened |
| **GitHub Actions cron drift** | `ingest_runs` logs every attempt, making gaps provable rather than silent |

### Cut order under time pressure

1. **Golden-question eval set** (Decision 5g)
2. **DuckDB-WASM** — falls back to server queries; the timeline still scrubs, over the network

| Alternative cut order | Why rejected |
|---|---|
| **Cut the seeded 2020 episode first** | Would protect the new technology and agent verification, but reintroduces exactly the event-dependency that seeding was chosen to eliminate. |
| **Cut attribution depth first** | Saves the most hours by far, but guts *"which fires are responsible"* — the core of the chosen question. |

**Reasoning:** protect the visible product and keep every graded requirement demonstrably
working; lose polish and the new-technology showcase before losing a requirement.

---

## Open items

### Blocking — required to proceed

| Item | Where | Needed for |
|---|---|---|
| **Neon connection string** | neon.tech — create project | Running the migration; all ingestion |
| **OpenAQ API key** | explore.openaq.org | The ground-sensor feed |
| **FIRMS `MAP_KEY`** | firms.modaps.eosdis.nasa.gov/api/map_key | The 2020 seed (keyless CSVs only reach back 7 days) |
| **Anthropic API key** | console.anthropic.com | The agent (day 2) |
| **GitHub repository** | `gh` CLI is not installed on this machine | GitHub Actions cron |

### Deferred decisions

- **Forward plume projection** ("where is it heading next") — deferred as the highest
  modelling risk; the question is currently answered by wind direction and forecast rather
  than by projected dispersion.
- **Rate limiting on the public agent endpoint** — cost control, not authentication.
- **Project name** — currently *Downwind*, chosen provisionally for the transport
  mechanism and the human stake. Not yet confirmed.

### Environment as verified

Node v22.22.2 · npm 10.9.7 · git 2.50.1 · **no `gh`** · **no `psql`** · **no Docker,
Podman or local Postgres** (migrations therefore run through a Node script, which is
more portable regardless).

One consequence worth stating: with no local Postgres engine available, the migration
SQL is **unvalidated until it first runs against Neon.** This is acceptable rather than
risky because the migration runner wraps each file in its own transaction — a syntax
error rolls back cleanly and re-runs after a fix, leaving earlier migrations applied. Next.js scaffolded with
TypeScript, Tailwind, ESLint, App Router, no `src/` directory.

**Note on the Next.js version in use:** the project's `AGENTS.md` states this is a
modified Next.js with breaking changes from common knowledge, and requires reading
`node_modules/next/dist/docs/` before writing application code. This is respected before
the first route or component is written.

---

## Decision log summary

| # | Decision | Chosen | Principal alternative rejected |
|---|---|---|---|
| 1 | The question | Wildfire smoke → air quality | River flood risk |
| 2a | Feed roster | FIRMS, OpenAQ, Open-Meteo wind, CAMS, NWS (5 feeds, 4 keyless) | Three-feed minimum |
| 2b | Geographic scope | Western North America | Global multi-theatre |
| 2c | Historical seeding | One episode — Sept 2020 West Coast | Live data only |
| 3a | Time model | Bitemporal (`event_time` + `ingest_time`) | `event_time` only |
| 3b | Layering | Raw append-only + derived recomputable | Single unified observation table |
| 3c | Revisions | Value-hash in UNIQUE key; new row per revision | In-place update |
| 3d | Entity resolution | Fire clustering with stable IDs | Raw detections only |
| 3e | Attribution | Upwind cone, FRP + distance weighted | Bare correlation |
| 3f | Multi-endpoint sources | `feed_variant` on `ingest_runs`, 5 clean source rows | Three separate `source_id` rows |
| 3g | Dedupe key | Raw published strings, empirically validated | Parsed floats rounded to 5dp |
| 3h | Fire scope | Bbox filter at ingest (reversed from store-all) | Store all, filter at query |
| 3i | Regional overlap | Dedupe key absorbs it; keep both region feeds | Drop the Canada feed |
| 3j | NWS retention | Accept the 2020 advisory gap, surface it explicitly | Move the seed to a recent window |
| 3k | Zone geometry | Lazy fetch + permanent cache, type fallback chain | Pre-load all 601 zones |
| 3k | AQ station cap | 800, auditable SQL selection, round-robin r4 fill | Keep all ~2,000 live sensors |
| 3l | Reference tier | Accept near-absence; tier becomes a stated caveat | Add AirNow as a sixth feed |
| 3m | Roster gap | Synthesize from the bulk feed at zero API cost | Individual lookups (all 404) |
| 3n | AQ history endpoint | Choose by metadata_source; /measurements for synthesized | Try /hours for all (2 req/sensor, 0 rows) |
| 3o | PM10 | Retain, but treat dust discrimination as station-specific | Assume the ratio is generally available |
| 3p | CAMS grid | Add H3 r3 grid for CAMS once requests proved cheap | Stations only |
| 3q | Forecast rows | Ingest 48h forecast; superseded by analysis bitemporally | History only |
| 3r | Clustering | DBSCAN eps 1500 m / minpts 2 / 48 h split | minpts 4 (discards 9% as noise) |
| 3s | Cluster identity | Inherit via exact detection membership | Incremental assignment; H3+time key |
| 3t | Industrial sources | Flag via FRP variability, do not exclude | Treat as ordinary fires |
| 3u | Cluster labels | Containing zone only (135 correct) | Nearest zone (223 of 358 wrong) |
| 3v | Attribution bounds | Attributable fires only + anomaly trigger | Unbounded (284M pairs) |
| 3w | Travel time | Single-step back-trajectory | Ignore lag; full iterative trajectory |
| 4i | Frame grain | Sparse (hour x r4 cell), 28 MB | Dense cartesian product |
| 4j | Regional series | Percentiles, max renamed 'worst_cell' | max() (read flat Hazardous) |
| 4k | Forecast horizon | 24h, to cap revision-driven growth | 48h (~74 MB over 2 days) |
| 4a | Store | Neon Postgres + PostGIS | ClickHouse Cloud (no durable free tier) |
| 4e | Storage headroom | 267/500 MB; narrow the seed first if pressed | Cut a graded deliverable |
| 4f | Cron + repo visibility | Public repo, per-feed Actions cadences | Private with 2h polling (~1,260 min/month) |
| 4g | Freshness population | Measure over cron runs only; one-offs excluded | Count every run (produced false staleness) |
| 4d | DB drivers | `pg` for scripts, `@neondatabase/serverless` for routes | One driver everywhere |
| 4b | Ingestion trigger | GitHub Actions cron | Vercel Cron (daily-only on Hobby) |
| 4c | New technology | DuckDB-WASM + Parquet, client-side scrub | Self-hosted ClickHouse |
| 5a | Data access | Nine curated tools, no raw SQL | Text-to-SQL |
| 5d | Agent loop | SDK Tool Runner, two-phase with compose | Manual loop |
| 5e | Grounded output | Structured claims + citations | Prose with inline markers |
| 5f | Model | `claude-opus-5`, effort routing | Sonnet 5 |
| 6a | Layout | Map-dominant, docked chat + timeline | Conversation-dominant |
| 6b | Map stack | MapLibre GL | deck.gl |
| 6c | Cold open | Seeded state + example questions | Empty state |
| 7 | Cut order | Eval set, then DuckDB-WASM | Cut seeded episode |
