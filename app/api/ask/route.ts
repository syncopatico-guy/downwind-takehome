/**
 * POST /api/ask -- the agent endpoint.
 *
 * Streams Server-Sent Events so the interface can show the agent working.
 * Decision 5e accepted that the final answer cannot stream as progressive
 * prose, because complete JSON is needed to parse it -- so what streams is the
 * WORK: which tool is running, what it returned. "Watch it check 47 stations,
 * then the answer lands" reads as more trustworthy than text typing itself
 * out, and it is honest about where the latency actually is.
 */

import type { NextRequest } from 'next/server';
import { ask, type AgentModel } from '@/lib/agent/run';
import { checkLimits, clientHash, logAsk, PER_CLIENT_HOURLY } from '@/lib/agent/limits';

export const maxDuration = 120;

interface AskBody {
  question?: string;
  as_of?: string;
  effort?: 'low' | 'medium' | 'high';
}

/**
 * The deployed model is chosen by env rather than by the caller: it is a
 * spending decision, and an endpoint that lets the client pick the expensive
 * model is not rate limited in any meaningful sense.
 */
function deployedModel(): AgentModel {
  return process.env.AGENT_MODEL === 'claude-opus-5' ? 'claude-opus-5' : 'claude-sonnet-5';
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  let body: AskBody;
  try {
    body = (await req.json()) as AskBody;
  } catch {
    return Response.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const question = (body.question ?? '').trim();
  if (!question) {
    return Response.json({ error: 'A question is required.' }, { status: 400 });
  }
  if (question.length > 1000) {
    return Response.json({ error: 'Question is too long (1000 characters max).' }, { status: 400 });
  }

  // Vercel sets x-forwarded-for; the fallback keeps local development working
  // rather than collapsing every dev request into one bucket.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? 'local';
  const hash = clientHash(ip, req.headers.get('user-agent') ?? '');

  const limit = await checkLimits(hash);
  if (!limit.allowed) {
    return Response.json(
      { error: limit.reason, retry_after_seconds: limit.retry_after_seconds },
      { status: 429, headers: { 'retry-after': String(limit.retry_after_seconds ?? 3600) } },
    );
  }

  const model = deployedModel();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(sse(event, data)));
        } catch {
          /* client went away mid-answer; the run finishes and is still logged */
        }
      };

      send('start', {
        question, model,
        remaining_this_hour: limit.remaining_this_hour,
        limit_per_hour: PER_CLIENT_HOURLY,
      });

      try {
        const result = await ask({
          question,
          model,
          asOf: body.as_of,
          effort: body.effort ?? 'high',
          onProgress: (e) => send('progress', e),
        });

        send('result', result);

        await logAsk({
          client_hash: hash, question, model,
          ok: result.claims !== null && (result.validation?.ok ?? false),
          refused: result.claims !== null && result.evidence.length === 0,
          tool_calls: result.calls.length,
          claim_count: result.claims?.claims.length,
          citation_count: result.validation?.cited_count,
          compose_attempts: result.compose_attempts,
          elapsed_ms: result.elapsed_ms,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_read_tokens: result.usage.cache_read_input_tokens,
          cost_usd: result.usage.estimated_cost_usd,
          error: result.error,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[ask] failed:', err);
        send('error', { error: 'The agent failed to answer. This has been logged.' });
        await logAsk({ client_hash: hash, question, model, ok: false, error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
    },
  });
}
