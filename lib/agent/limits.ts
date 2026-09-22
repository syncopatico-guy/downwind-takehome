/**
 * Cost control for a public endpoint with an LLM behind it.
 *
 * Decision 7 called this out as an unbounded cost surface and noted that a
 * rate limit is cost control, not authentication -- which the brief puts out
 * of scope. With a hard $20 monthly cap on the account, an unbounded endpoint
 * is the single most likely way for the demo to stop working mid-review.
 *
 * Two limits, because they fail differently. A per-caller limit stops one
 * person or script monopolising the budget. A global daily spend ceiling stops
 * the budget going in an afternoon regardless of how many callers shared it --
 * a hundred people asking one question each would pass every per-caller check
 * ever written.
 */

import { createHash } from 'node:crypto';
import { tq, tq1 } from '../tools/sql';

/** Per caller, per hour. Enough to explore properly, not enough to drain it. */
export const PER_CLIENT_HOURLY = 12;

/**
 * Global ceiling per rolling day, in USD. Sized so the $20 month survives a
 * bad day: at the measured $0.14 for a hard multi-hop question, this is about
 * 14 of them, and the month has room for several such days.
 */
export const DAILY_SPEND_CAP_USD = 2.0;

/** Never identify the caller -- only tell callers apart. */
export function clientHash(ip: string, userAgent: string): string {
  return createHash('sha256').update(`${ip}|${userAgent}`).digest('hex').slice(0, 32);
}

export interface LimitDecision {
  allowed: boolean;
  reason?: string;
  retry_after_seconds?: number;
  /** Surfaced to the interface so a user can see where they stand. */
  remaining_this_hour?: number;
}

export async function checkLimits(hash: string): Promise<LimitDecision> {
  const [mine, spend] = await Promise.all([
    tq1<{ n: string; oldest: string | null }>(
      `SELECT count(*)::text AS n, min(asked_at)::text AS oldest
         FROM ask_log
        WHERE client_hash = $1 AND asked_at > now() - interval '1 hour'`,
      [hash],
    ),
    tq1<{ total: string }>(
      `SELECT coalesce(sum(cost_usd), 0)::text AS total
         FROM ask_log WHERE asked_at > now() - interval '1 day'`,
    ),
  ]);

  const used = Number(mine?.n ?? 0);
  const dailySpend = Number(spend?.total ?? 0);

  if (dailySpend >= DAILY_SPEND_CAP_USD) {
    return {
      allowed: false,
      reason:
        `This demo runs on a fixed budget and has reached its daily ceiling ` +
        `($${DAILY_SPEND_CAP_USD.toFixed(2)}). It resets on a rolling 24-hour window — ` +
        `everything except the agent still works in the meantime.`,
      retry_after_seconds: 3600,
    };
  }

  if (used >= PER_CLIENT_HOURLY) {
    const oldest = mine?.oldest ? new Date(mine.oldest).getTime() : Date.now();
    const retry = Math.max(60, Math.ceil((oldest + 3600_000 - Date.now()) / 1000));
    return {
      allowed: false,
      reason: `Rate limit: ${PER_CLIENT_HOURLY} questions an hour. This is cost control on a fixed budget, not a login wall.`,
      retry_after_seconds: retry,
      remaining_this_hour: 0,
    };
  }

  return { allowed: true, remaining_this_hour: PER_CLIENT_HOURLY - used };
}

export interface AskLogRow {
  client_hash: string;
  question: string;
  model?: string;
  ok: boolean;
  refused?: boolean;
  tool_calls?: number;
  claim_count?: number;
  citation_count?: number;
  compose_attempts?: number;
  elapsed_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cost_usd?: number;
  error?: string;
}

/**
 * Logged AFTER the answer, so the row carries real measured spend rather than
 * an estimate. The consequence is deliberate: a caller can always exceed the
 * cap by exactly one question, because cost is unknown until it is paid.
 * Reserving a nominal amount up front would be more precise and would make
 * every question wait on a second write.
 */
export async function logAsk(row: AskLogRow): Promise<void> {
  try {
    await tq(
      `INSERT INTO ask_log (client_hash, question, model, ok, refused, tool_calls,
                            claim_count, citation_count, compose_attempts, elapsed_ms,
                            input_tokens, output_tokens, cache_read_tokens, cost_usd, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        row.client_hash, row.question.slice(0, 2000), row.model ?? null,
        row.ok, row.refused ?? false, row.tool_calls ?? null,
        row.claim_count ?? null, row.citation_count ?? null,
        row.compose_attempts ?? null, row.elapsed_ms ?? null,
        row.input_tokens ?? null, row.output_tokens ?? null,
        row.cache_read_tokens ?? null, row.cost_usd ?? null,
        row.error?.slice(0, 1000) ?? null,
      ],
    );
  } catch (err) {
    // Logging must never fail the answer the user already paid for.
    console.error('[ask] could not log:', err);
  }
}
