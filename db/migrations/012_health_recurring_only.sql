-- Migration 012: measure freshness over RECURRING runs only
--
-- The pessimistic rollup ("a source is only as fresh as its weakest variant")
-- is correct for genuine sub-feeds -- if one of three VIIRS satellites stops
-- publishing we must know -- but it produced FALSE staleness in practice.
--
-- Observed: nws_alerts and openaq both reported 'stale' minutes after
-- succeeding, because each carries a variant that is a ONE-OFF BY DESIGN:
--   nws_alerts / 'zone_geometry'  -- the --resolve-zones repair pass
--   openaq     / 'backfill:7d'    -- the historical backfill
-- Those ran once, correctly, and will never run again. Treating them as
-- continuously-refreshed feeds meant they were permanently stale and dragged
-- their whole source down with them.
--
-- `cadence_seconds` is a claim about the CRON schedule, so freshness is now
-- measured against cron runs only. A variant that has never had a cron run is
-- reported as 'one_off' -- informative rather than alarming -- and excluded
-- from the source rollup. `last_ok_any_at` still exposes the most recent
-- success of any kind, because provenance wants the full picture even when
-- freshness does not.

-- CREATE OR REPLACE cannot reorder or rename a view's columns, and this
-- revision inserts last_ok_any_at ahead of last_attempt_at. Drop first --
-- v_source_health depends on v_feed_variant_health, so order matters.
DROP VIEW IF EXISTS v_source_health;
DROP VIEW IF EXISTS v_feed_variant_health;

CREATE VIEW v_feed_variant_health AS
SELECT
  s.source_id,
  s.display_name,
  coalesce(i.feed_variant, '(single)')                     AS feed_variant,
  s.staleness_seconds,
  -- Freshness clock: recurring runs only.
  max(i.started_at) FILTER (WHERE i.status = 'ok' AND i.trigger_kind = 'cron') AS last_ok_at,
  -- Provenance clock: any successful run, whatever triggered it.
  max(i.started_at) FILTER (WHERE i.status = 'ok')         AS last_ok_any_at,
  max(i.started_at)                                        AS last_attempt_at,
  (array_agg(i.status ORDER BY i.started_at DESC))[1]      AS last_status,
  count(*) FILTER (WHERE i.trigger_kind = 'cron')          AS cron_runs,
  count(*) FILTER (WHERE i.status = 'error')               AS error_runs,
  count(*)                                                 AS total_runs,
  sum(i.rows_inserted)                                     AS rows_inserted_total,
  CASE
    -- Never scheduled: a maintenance pass, not a feed. Excluded from rollup.
    WHEN count(*) FILTER (WHERE i.trigger_kind = 'cron') = 0
      THEN 'one_off'
    WHEN max(i.started_at) FILTER (WHERE i.status = 'ok' AND i.trigger_kind = 'cron') IS NULL
      THEN 'never_succeeded'
    WHEN now() - max(i.started_at) FILTER (WHERE i.status = 'ok' AND i.trigger_kind = 'cron')
         > (s.staleness_seconds || ' seconds')::interval
      THEN 'stale'
    ELSE 'fresh'
  END                                                      AS freshness
FROM sources s
LEFT JOIN ingest_runs i ON i.source_id = s.source_id
GROUP BY s.source_id, s.display_name, i.feed_variant, s.staleness_seconds;

CREATE VIEW v_source_health AS
SELECT
  s.source_id,
  s.display_name,
  s.provider,
  s.measurement_kind,
  s.cadence_seconds,
  s.staleness_seconds,
  s.latency_seconds,
  s.requires_key,
  coalesce(v.recurring_variants, 0)                        AS recurring_variants,
  coalesce(v.one_off_variants, 0)                          AS one_off_variants,
  coalesce(v.stale_variants, 0)                            AS stale_variants,
  v.weakest_last_ok_at                                     AS last_ok_at,
  v.last_ok_any_at,
  v.last_attempt_at,
  EXTRACT(EPOCH FROM (now() - v.weakest_last_ok_at))::bigint AS seconds_since_ok,
  CASE
    WHEN coalesce(v.recurring_variants, 0) = 0 THEN 'not_scheduled'
    WHEN v.weakest_last_ok_at IS NULL          THEN 'never_succeeded'
    WHEN coalesce(v.stale_variants, 0) > 0     THEN 'stale'
    ELSE 'fresh'
  END                                                      AS freshness
FROM sources s
LEFT JOIN (
  SELECT
    source_id,
    -- One-off variants are excluded from every rollup figure: they are
    -- maintenance history, not part of the refresh contract.
    count(*) FILTER (WHERE freshness <> 'one_off')                  AS recurring_variants,
    count(*) FILTER (WHERE freshness =  'one_off')                  AS one_off_variants,
    min(last_ok_at) FILTER (WHERE freshness <> 'one_off')           AS weakest_last_ok_at,
    max(last_ok_any_at)                                             AS last_ok_any_at,
    max(last_attempt_at)                                            AS last_attempt_at,
    count(*) FILTER (WHERE freshness NOT IN ('fresh','one_off'))    AS stale_variants
  FROM v_feed_variant_health
  GROUP BY source_id
) v ON v.source_id = s.source_id;
