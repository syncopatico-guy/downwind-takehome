/**
 * Query access for the tool layer.
 *
 * Decision 4d splits the drivers by where they run: `pg` for ingestion scripts
 * that need long-lived pooling and real transactions, `@neondatabase/serverless`
 * for request/response work. The tools are request-scoped, so they use the
 * serverless driver -- and it works unchanged under `tsx`, which is what lets
 * the verification script exercise the same code path the route handler runs.
 *
 * Measured cost: the HTTP driver pays a round trip per statement (~75-115 ms
 * from a laptop to us-east-2, against ~30 ms on a warm pooled `pg` socket).
 * Tools that need several reads issue them through `Promise.all` so the round
 * trips overlap, rather than serially.
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let client: NeonQueryFunction<false, false> | null = null;

function getClient(): NeonQueryFunction<false, false> {
  if (client) return client;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set; the query layer cannot reach the database.');
  }
  client = neon(connectionString);
  return client;
}

/** Parameterised query. Every value the agent supplies arrives as a bind parameter. */
export async function tq<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const rows = await getClient().query(text, params);
  return rows as T[];
}

/** First row or null. */
export async function tq1<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await tq<T>(text, params);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

export interface SourceRow {
  source_id: string;
  display_name: string;
  provider: string;
  base_url: string | null;
  docs_url: string | null;
  measurement_kind: 'observation' | 'model' | 'advisory';
  cadence_seconds: number;
  staleness_seconds: number;
  latency_seconds: number;
  requires_key: boolean;
}

let registry: Map<string, SourceRow> | null = null;

/**
 * The registry is five immutable rows, so it is cached for the life of the
 * process. Every envelope needs a source's declared staleness budget, and
 * refetching it per tool call would double the round trips for no benefit.
 */
export async function sourceRegistry(): Promise<Map<string, SourceRow>> {
  if (registry) return registry;
  const rows = await tq<SourceRow>(
    `SELECT source_id, display_name, provider, base_url, docs_url, measurement_kind,
            cadence_seconds, staleness_seconds, latency_seconds, requires_key
       FROM sources ORDER BY source_id`,
  );
  registry = new Map(rows.map((r) => [r.source_id, r]));
  return registry;
}

export async function sourceRefs(
  ids: string[],
): Promise<{ source_id: string; source_url: string | null }[]> {
  const reg = await sourceRegistry();
  return ids.map((id) => ({ source_id: id, source_url: reg.get(id)?.docs_url ?? null }));
}

export async function stalenessFor(id: string): Promise<number | null> {
  const reg = await sourceRegistry();
  return reg.get(id)?.staleness_seconds ?? null;
}
