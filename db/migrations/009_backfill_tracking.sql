-- Migration 009: per-sensor backfill tracking
--
-- The backfill resumed by asking "does this sensor have any row in the
-- window?". That works for sensors with data, but a sensor that genuinely has
-- NO readings in the window can never satisfy it, so every re-run re-fetched
-- the same dead sensors -- one chunk spent 487 requests to gain 1,376 rows,
-- most batches returning nothing.
--
-- Recording the ATTEMPT rather than inferring it from results makes the
-- backfill converge: a sensor fetched once is never fetched again for that
-- window, whether or not it had anything to give. It also turns "this sensor
-- reported nothing for seven days" into a recorded fact the agent can cite,
-- rather than an absence indistinguishable from never having looked.

ALTER TABLE aq_sensors ADD COLUMN IF NOT EXISTS backfill_attempted_at timestamptz;
ALTER TABLE aq_sensors ADD COLUMN IF NOT EXISTS backfill_window_start timestamptz;
ALTER TABLE aq_sensors ADD COLUMN IF NOT EXISTS backfill_rows integer;

CREATE INDEX IF NOT EXISTS ix_aq_sensors_backfill
  ON aq_sensors (backfill_attempted_at NULLS FIRST);

-- Sensors that already produced data are retrospectively marked attempted, so
-- the completed work is not repeated.
UPDATE aq_sensors sn
   SET backfill_attempted_at = now(),
       backfill_window_start = now() - interval '7 days',
       backfill_rows = sub.n
  FROM (SELECT sensor_id, count(*) AS n FROM aq_measurements
         WHERE event_time >= now() - interval '7 days' AND sensor_id IS NOT NULL
         GROUP BY sensor_id) sub
 WHERE sn.sensor_id = sub.sensor_id AND sn.backfill_attempted_at IS NULL;
