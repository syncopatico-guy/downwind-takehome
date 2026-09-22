/**
 * Bridging the query layer to the SDK's tool runner.
 *
 * The registry already holds Zod schemas and handlers (Decision 5a), so this
 * is a mapping rather than a second definition -- the schema the model is
 * shown, the schema that validates the call, and the schema the handler is
 * typed against remain one object.
 *
 * Its real job is bookkeeping. Every record id a tool returns is recorded in
 * the run's evidence set, which is what `validateCitations` later checks the
 * composed answer against. Without this the citation guarantee would be a
 * prompt instruction rather than an invariant.
 */

import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { TOOLS } from '../tools/registry';
import type { Envelope } from '../tools/envelope';

export interface ToolCallRecord {
  tool: string;
  input: unknown;
  row_count: number;
  elapsed_ms: number;
  error?: string;
}

export interface RunContext {
  /** Every record id any tool returned this run. The citation allowlist. */
  evidence: Set<string>;
  /** One entry per tool call, for the progress stream and the decision record. */
  calls: ToolCallRecord[];
  /** Called as each tool starts and finishes, so the interface can show work. */
  onProgress?: (event: { phase: 'start' | 'done'; tool: string; detail?: string }) => void;
}

export function newRunContext(
  onProgress?: RunContext['onProgress'],
): RunContext {
  return { evidence: new Set(), calls: [], onProgress };
}

/**
 * Drop null and undefined before the result reaches the model.
 *
 * Measured at 5-10% of payload across the tools -- not a lever on its own, but
 * free, and a null field costs tokens to say nothing. Deliberately shallow in
 * effect: no field is renamed, reordered or summarised, because the model
 * needs the caveats and the evidence numbers intact to answer honestly.
 */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, stripNulls(v)]),
    );
  }
  return value;
}

function collectIds(envelope: Envelope<unknown>, into: Set<string>): void {
  for (const id of envelope.provenance.record_ids) into.add(id);
  // Nested ids -- a fire cluster's detections, an explanation's contributing
  // fires -- are citable too, and they are the end of the evidence chain the
  // interface is meant to follow.
  for (const row of envelope.data as Record<string, unknown>[]) {
    for (const [key, v] of Object.entries(row ?? {})) {
      if (key.endsWith('record_id') && typeof v === 'string') into.add(v);
      if (Array.isArray(v)) {
        for (const item of v) {
          const nested = (item as Record<string, unknown>)?.record_id;
          if (typeof nested === 'string') into.add(nested);
          const cluster = (item as Record<string, unknown>)?.cluster_record_id;
          if (typeof cluster === 'string') into.add(cluster);
        }
      }
    }
  }
}

/** The nine tools, wired to record what they return. */
export function agentTools(ctx: RunContext) {
  return Object.values(TOOLS).map((tool) =>
    betaZodTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      run: async (input: unknown) => {
        const started = Date.now();
        ctx.onProgress?.({ phase: 'start', tool: tool.name });
        try {
          const envelope = await tool.handler(input);
          collectIds(envelope, ctx.evidence);
          const elapsed = Date.now() - started;
          ctx.calls.push({
            tool: tool.name, input,
            row_count: envelope.provenance.row_count,
            elapsed_ms: elapsed,
          });
          ctx.onProgress?.({
            phase: 'done', tool: tool.name,
            detail: `${envelope.provenance.row_count} rows`,
          });
          return JSON.stringify(stripNulls(envelope));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.calls.push({
            tool: tool.name, input, row_count: 0,
            elapsed_ms: Date.now() - started, error: message,
          });
          ctx.onProgress?.({ phase: 'done', tool: tool.name, detail: `failed: ${message}` });
          // Returned rather than thrown: a failed tool must not abort the run.
          // The model can try a different approach, and an error it can read
          // is more useful than a dead turn.
          return JSON.stringify({ error: message, tool: tool.name });
        }
      },
    }),
  );
}
