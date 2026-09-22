/**
 * HTTP fetching with retries, for the feeds that had none.
 *
 * Written after a scheduled FIRMS run failed at 09:21 UTC on 2026-09-22 with
 * all six endpoints reporting the single word `fetch failed`, and nothing else.
 * Two separate defects were behind that:
 *
 *   1. `fetch failed` is undici's generic wrapper. The actual reason -- DNS
 *      failure, refused connection, reset, TLS error -- lives in `err.cause`,
 *      which the ingester discarded. The log could not distinguish a NASA
 *      outage from a broken URL.
 *   2. There was no retry at all, so a blip lasting under two seconds took out
 *      the whole run. All six endpoints share one hostname, so one unreachable
 *      host fails all six at once.
 *
 * `lib/openaq.ts` and `lib/openmeteo.ts` keep their own retry loops: both work,
 * and OpenAQ's sliding-window limiter is intricate enough that replacing it
 * under a deadline would be trading a real risk for a tidier dependency graph.
 * This module serves FIRMS and NWS.
 */

/** A non-2xx response. Carries enough to decide whether retrying is pointless. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly url: string;

  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** A request that exceeded its own deadline, as distinct from a refused one. */
export class TimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms: ${url}`);
    this.name = 'TimeoutError';
  }
}

/**
 * Render the whole cause chain, which is the part that was missing.
 *
 * undici raises `TypeError: fetch failed` and hangs the real error off
 * `cause`, sometimes as an AggregateError holding one failure per resolved
 * address. Walking it turns an unactionable string into `fetch failed
 * (ENOTFOUND: getaddrinfo ENOTFOUND firms.modaps.eosdis.nasa.gov)`.
 */
export function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const walk = (e: unknown, depth: number): void => {
    if (e == null || depth > 4 || seen.has(e)) return;
    seen.add(e);

    if (typeof e !== 'object') {
      parts.push(String(e));
      return;
    }
    const obj = e as { message?: string; code?: string; errno?: number; errors?: unknown[]; cause?: unknown };
    const code = obj.code ?? (typeof obj.errno === 'number' ? String(obj.errno) : undefined);
    const message = obj.message;
    if (code && message) parts.push(`${code}: ${message}`);
    else if (code) parts.push(code);
    else if (message) parts.push(message);

    // AggregateError: one entry per address tried. The first is representative.
    if (Array.isArray(obj.errors) && obj.errors.length > 0) {
      walk(obj.errors[0], depth + 1);
      if (obj.errors.length > 1) parts.push(`(+${obj.errors.length - 1} more address(es))`);
    }
    walk(obj.cause, depth + 1);
  };

  walk(err, 0);
  const unique = parts.filter((p, i) => p && parts.indexOf(p) === i);
  return unique.length > 0 ? unique.join(' <- ') : String(err);
}

/**
 * Is another attempt worth making?
 *
 * 429 and 5xx are the server asking us to come back; network errors and
 * timeouts are transport. A 400, 401, 403 or 404 is a statement about the
 * request itself and will say the same thing next time -- retrying it wastes
 * the backoff and delays the diagnosis. The `/alerts/active` rejecting `limit`
 * bug (Decision 4h) would have burned four attempts under a retry-everything
 * policy to learn what one attempt already knew.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof TimeoutError) return true;
  // undici network failures and anything else transport-shaped.
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

export interface FetchRetryOptions {
  timeoutMs?: number;
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  headers?: Record<string, string>;
  /** Prefix for retry warnings, e.g. 'firms'. */
  label?: string;
}

export interface FetchResult {
  body: string;
  status: number;
  /** How many attempts it took. 1 means it worked first time. */
  attempts: number;
}

const BASE_BACKOFF_MS = 1000;
const MAX_RETRY_AFTER_MS = 60_000;

/** Exponential with jitter, so six endpoints failing together do not resynchronise. */
function backoffMs(attempt: number): number {
  const base = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(
  url: string,
  opts: FetchRetryOptions = {},
): Promise<FetchResult> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const label = opts.label ? `[${opts.label}] ` : '';

  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);

    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: opts.headers });
      const body = await res.text();

      if (res.status === 429) {
        const retryAfter = Math.min(
          (Number(res.headers.get('retry-after')) || 30) * 1000,
          MAX_RETRY_AFTER_MS,
        );
        const err = new HttpError(429, url, body);
        if (attempt === attempts) throw err;
        console.warn(`    ${label}429 — waiting ${retryAfter / 1000}s (attempt ${attempt}/${attempts})`);
        await sleep(retryAfter);
        lastErr = err;
        continue;
      }

      if (!res.ok) throw new HttpError(res.status, url, body);
      return { body, status: res.status, attempts: attempt };
    } catch (err) {
      // An abort we caused is a timeout; an abort we did not is still transport.
      const normalised = timedOut ? new TimeoutError(url, timeoutMs) : err;
      lastErr = normalised;

      if (!isRetryable(normalised) || attempt === attempts) throw normalised;

      const wait = backoffMs(attempt);
      console.warn(
        `    ${label}${describeFetchError(normalised)} — retrying in ${wait} ms ` +
          `(attempt ${attempt}/${attempts})`,
      );
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new Error(`exhausted ${attempts} attempts: ${url}`);
}
