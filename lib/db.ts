/**
 * Database access for ingestion scripts and server-side jobs (Node runtime).
 *
 * Uses node-postgres against Neon over the standard wire protocol. Next.js
 * route handlers use @neondatabase/serverless instead -- it is built for
 * serverless request/response, whereas this module needs long-lived pooling,
 * real transactions and efficient multi-row inserts.
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and add your ' +
        'Neon connection string (include ?sslmode=require).',
    );
  }

  pool = new Pool({
    connectionString,
    max: 4,                        // Neon free tier: stay modest
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });

  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query<T>(sql, params);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** Run `fn` inside a transaction, rolling back on throw. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the connection may already be broken; the original error matters more */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ---------------------------------------------------------------------------
// Ingest run accounting
// ---------------------------------------------------------------------------

export type TriggerKind = 'cron' | 'manual' | 'backfill' | 'seed';

export interface IngestRunSpec {
  sourceId: string;
  /** Sub-feed identifier, e.g. 'viirs_noaa21:canada'. Null for single-endpoint sources. */
  feedVariant?: string | null;
  triggerKind: TriggerKind;
  requestUrl?: string | null;
  /** The event-time window this run INTENDED to cover. Recording the intent is
   *  what lets a later query prove a gap exists rather than merely suspect it. */
  windowStart?: Date | null;
  windowEnd?: Date | null;
}

export interface IngestRunOutcome {
  rowsFetched?: number;
  rowsInserted?: number;
  rowsRejected?: number;
  httpStatus?: number | null;
  notes?: Record<string, unknown> | null;
}

export interface IngestRunContext {
  runId: number;
  client: PoolClient;
}

/**
 * Open an ingest run, hand it to `fn`, and close it with the outcome --
 * including on throw, where the run is closed as 'error' with the message.
 *
 * This is the provenance invariant: every raw row carries a run_id, and a run
 * cannot be written without being accounted for. A crashed ingester therefore
 * leaves an explanatory record rather than a silent hole, which is what lets
 * the agent distinguish "no fires were detected" from "we failed to look".
 *
 * NOTE the deliberate transaction boundary: the run row is committed
 * IMMEDIATELY on open, outside the caller's work. If the work then fails, the
 * failure record survives -- wrapping both together would roll back the very
 * evidence of the failure.
 */
export async function withIngestRun<T>(
  spec: IngestRunSpec,
  fn: (ctx: IngestRunContext) => Promise<{ outcome: IngestRunOutcome; value: T }>,
): Promise<T> {
  const opened = await queryOne<{ run_id: string }>(
    `INSERT INTO ingest_runs
       (source_id, feed_variant, trigger_kind, status, request_url, window_start, window_end)
     VALUES ($1, $2, $3, 'running', $4, $5, $6)
     RETURNING run_id`,
    [
      spec.sourceId,
      spec.feedVariant ?? null,
      spec.triggerKind,
      spec.requestUrl ?? null,
      spec.windowStart ?? null,
      spec.windowEnd ?? null,
    ],
  );
  if (!opened) throw new Error('failed to open ingest run');
  const runId = Number(opened.run_id);

  const client = await getPool().connect();
  try {
    const { outcome, value } = await fn({ runId, client });

    const rejected = outcome.rowsRejected ?? 0;
    const status = rejected > 0 ? 'partial' : 'ok';

    await client.query(
      `UPDATE ingest_runs
          SET status = $2, finished_at = now(),
              rows_fetched = $3, rows_inserted = $4, rows_rejected = $5,
              http_status = $6, notes = $7
        WHERE run_id = $1`,
      [
        runId,
        status,
        outcome.rowsFetched ?? null,
        outcome.rowsInserted ?? null,
        rejected,
        outcome.httpStatus ?? null,
        outcome.notes ? JSON.stringify(outcome.notes) : null,
      ],
    );
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await client.query(
        `UPDATE ingest_runs
            SET status = 'error', finished_at = now(), error_message = $2
          WHERE run_id = $1`,
        [runId, message.slice(0, 2000)],
      );
    } catch (bookkeepingErr) {
      console.error('[db] could not record run failure:', bookkeepingErr);
    }
    throw err;
  } finally {
    client.release();
  }
}
