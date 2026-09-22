/**
 * The two-phase agent: gather, then compose.
 *
 * Decision 5d verified that the Tool Runner and structured outputs do not
 * compose -- structured output comes from `client.messages.parse()`, a
 * different method with no documented way to pass `output_config.format` to
 * the runner. Rather than work around it, the work is split the way the task
 * splits:
 *
 *   1. GATHER  `toolRunner({stream: true})` drives the tool loop, streaming
 *              per-tool progress. Evidence accumulates in the run context.
 *   2. COMPOSE one `messages.parse()` over that history with a Zod output
 *              format, producing typed claims with citations.
 *
 * This is better than a workaround. Because composition is its own call, every
 * citation can be validated against the ids the tools actually returned, and
 * the compose step retried ALONE when validation fails -- no tool work is
 * repeated, and the gather history is cached, so the retry is cheap.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  ClaimsSchema, retryInstruction, validateCitations,
  type Claims, type ValidationResult,
} from './claims';
import { COMPOSE_INSTRUCTION, SYSTEM_PROMPT } from './prompt';
import { agentTools, newRunContext, type RunContext, type ToolCallRecord } from './tools';

/**
 * Bounded deliberately. A question that keeps calling tools is either
 * confused or pathological, and on a fixed budget an unbounded loop is a
 * financial risk as much as a latency one. Eight is roughly twice what the
 * hardest multi-hop question needs (resolve -> fires -> wind -> explain).
 */
const MAX_ITERATIONS = 8;

/** One retry. If the model invents ids twice, more attempts will not help. */
const MAX_COMPOSE_ATTEMPTS = 2;

export type AgentModel = 'claude-opus-5' | 'claude-sonnet-5';

export interface AskOptions {
  question: string;
  model?: AgentModel;
  /** The timeline position. Passed to the model so answers respect the scrub. */
  asOf?: string;
  onProgress?: RunContext['onProgress'];
  /** 'low' for lookups, 'high' for multi-hop attribution (Decision 5f). */
  effort?: 'low' | 'medium' | 'high';
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** USD, from the model's published rates. */
  estimated_cost_usd: number;
}

export interface AskResult {
  question: string;
  model: AgentModel;
  claims: Claims | null;
  validation: ValidationResult | null;
  /** Every record id the tools returned: the interface's evidence drawer. */
  evidence: string[];
  calls: ToolCallRecord[];
  usage: Usage;
  compose_attempts: number;
  elapsed_ms: number;
  /** Set when no answer could be produced. */
  error?: string;
}

const RATES: Record<AgentModel, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
};

function emptyUsage(): Usage {
  return {
    input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    estimated_cost_usd: 0,
  };
}

function addUsage(total: Usage, u: Anthropic.Usage | undefined, model: AgentModel): void {
  if (!u) return;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  total.input_tokens += u.input_tokens ?? 0;
  total.output_tokens += u.output_tokens ?? 0;
  total.cache_read_input_tokens += cacheRead;
  total.cache_creation_input_tokens += cacheWrite;
  const r = RATES[model];
  // Cache reads bill at ~0.1x and writes at ~1.25x of base input rate.
  total.estimated_cost_usd +=
    ((u.input_tokens ?? 0) * r.input +
     cacheRead * r.input * 0.1 +
     cacheWrite * r.input * 1.25 +
     (u.output_tokens ?? 0) * r.output) / 1_000_000;
}

/**
 * Lazy, for the same reason `getPool()` in lib/db.ts is lazy.
 *
 * ES module imports are hoisted and evaluated before the importing module's
 * body runs, so a client constructed at module scope is built BEFORE a script
 * that calls `dotenv.config()` at the top of its body has loaded .env.local --
 * and it fails with "Could not resolve authentication method" while the key
 * sits correctly in the file. Deferring construction to first use puts it
 * after the environment is loaded, whoever the caller is.
 */
let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export async function ask(opts: AskOptions): Promise<AskResult> {
  const started = Date.now();
  const model = opts.model ?? 'claude-sonnet-5';
  const effort = opts.effort ?? 'high';
  const ctx = newRunContext(opts.onProgress);
  const usage = emptyUsage();

  // Volatile content goes in the user turn, never the system prompt: the
  // system prompt and tool definitions are the cached prefix, and a timestamp
  // in there would invalidate the cache on every single request.
  const question = opts.asOf
    ? `${opts.question}\n\n(The user is looking at the timeline positioned at ${opts.asOf}. Answer as of that moment unless they ask otherwise.)`
    : opts.question;

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: 'user', content: question },
  ];

  // ---- Phase 1: gather ---------------------------------------------------
  try {
    const runner = getClient().beta.messages.toolRunner({
      model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      // Caches the stable prefix -- tools render before system, both frozen.
      // Worth ~35% of input cost on a multi-turn question.
      cache_control: { type: 'ephemeral' },
      thinking: { type: 'adaptive' },
      output_config: { effort },
      tools: agentTools(ctx),
      messages,
      max_iterations: MAX_ITERATIONS,
      stream: true,
    });

    // With stream: true each iteration yields a STREAM, not a message -- a
    // bare `message.stop_reason` check here would silently never fire, which
    // is the documented pitfall carried into Decision 5d.
    for await (const stream of runner) {
      const message = await stream.finalMessage();
      addUsage(usage, message.usage, model);
      if (message.stop_reason === 'refusal') {
        return {
          question: opts.question, model, claims: null, validation: null,
          evidence: [...ctx.evidence], calls: ctx.calls, usage,
          compose_attempts: 0, elapsed_ms: Date.now() - started,
          error: 'The model declined to answer this question.',
        };
      }
    }

    const finalGather = await runner.done();
    messages.length = 0;
    messages.push(...runner.params.messages as Anthropic.Beta.BetaMessageParam[]);
    if (finalGather.stop_reason === 'max_tokens') {
      opts.onProgress?.({ phase: 'done', tool: '(gather)', detail: 'hit max_tokens' });
    }
  } catch (err) {
    return {
      question: opts.question, model, claims: null, validation: null,
      evidence: [...ctx.evidence], calls: ctx.calls, usage,
      compose_attempts: 0, elapsed_ms: Date.now() - started,
      error: `Gathering failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ---- Phase 2: compose, validate, retry once ----------------------------
  const composeMessages: Anthropic.MessageParam[] = [
    ...(messages as unknown as Anthropic.MessageParam[]),
    { role: 'user', content: COMPOSE_INSTRUCTION },
  ];

  let claims: Claims | null = null;
  let validation: ValidationResult | null = null;
  let attempts = 0;

  while (attempts < MAX_COMPOSE_ATTEMPTS) {
    attempts++;
    opts.onProgress?.({ phase: 'start', tool: '(compose)' });
    try {
      const response = await getClient().messages.parse({
        model,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
        messages: composeMessages,
        output_config: { format: zodOutputFormat(ClaimsSchema), effort: 'low' },
      });
      addUsage(usage, response.usage, model);

      // parsed_output is null on parse failure -- a guard, not an assertion.
      if (!response.parsed_output) {
        opts.onProgress?.({ phase: 'done', tool: '(compose)', detail: 'unparseable' });
        composeMessages.push(
          { role: 'assistant', content: response.content },
          { role: 'user', content: 'That did not parse against the required schema. Return the answer again, matching the schema exactly.' },
        );
        continue;
      }

      claims = response.parsed_output as Claims;
      validation = validateCitations(claims, ctx.evidence);
      opts.onProgress?.({
        phase: 'done', tool: '(compose)',
        detail: validation.ok
          ? `${claims.claims.length} claims, ${validation.cited_count} citations`
          : `${validation.problems.length} citation problem(s)`,
      });
      if (validation.ok) break;

      // Retry composition ALONE. No tool is called again; the gather history
      // is cached, so a second attempt costs a fraction of the first.
      composeMessages.push(
        { role: 'assistant', content: response.content },
        { role: 'user', content: retryInstruction(validation) },
      );
    } catch (err) {
      return {
        question: opts.question, model, claims, validation,
        evidence: [...ctx.evidence], calls: ctx.calls, usage,
        compose_attempts: attempts, elapsed_ms: Date.now() - started,
        error: `Composing failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    question: opts.question, model, claims, validation,
    evidence: [...ctx.evidence], calls: ctx.calls, usage,
    compose_attempts: attempts, elapsed_ms: Date.now() - started,
  };
}
