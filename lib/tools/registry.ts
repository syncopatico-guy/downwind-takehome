/**
 * The tool surface, in one place.
 *
 * Decision 5a chose nine curated tools over a raw SQL surface, so this registry
 * IS the contract between the agent and the database. Nothing else reaches the
 * data.
 *
 * Each tool carries a Zod schema rather than a hand-written JSON Schema, and
 * the Anthropic tool definition is derived from it. That means the schema the
 * model is shown and the schema that validates the call are the same object and
 * cannot drift -- a class of bug that is invisible until the model sends a
 * field the validator rejects.
 */

import { z } from 'zod';
import type { Envelope } from './envelope';
import { ToolInputError, type ToolDefinition } from './types';
import { TimeParamError } from './time';

import { getDataHealth } from './get-data-health';
import { resolvePlace } from './resolve-place';
import { getAirQuality } from './get-air-quality';
import { getFires } from './get-fires';
import { getWind } from './get-wind';
import { getAlerts } from './get-alerts';
import { explainSmoke } from './explain-smoke';
import { compareTime } from './compare-time';
import { rankPlaces } from './rank-places';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ALL = [
  resolvePlace,
  getAirQuality,
  getFires,
  getWind,
  getAlerts,
  explainSmoke,
  compareTime,
  rankPlaces,
  getDataHealth,
] as unknown as ToolDefinition<z.ZodTypeAny, any>[];
/* eslint-enable @typescript-eslint/no-explicit-any */

export const TOOLS: Record<string, (typeof ALL)[number]> = Object.fromEntries(
  ALL.map((t) => [t.name, t]),
);

export const TOOL_NAMES = ALL.map((t) => t.name);

export function getTool(name: string): (typeof ALL)[number] | null {
  return TOOLS[name] ?? null;
}

/** Anthropic tool definition shape, derived from the Zod schema. */
export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function anthropicToolDefinitions(): AnthropicToolDefinition[] {
  return ALL.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(t.inputSchema, {
      target: 'draft-7',
      io: 'input',
    }) as Record<string, unknown>,
  }));
}

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`Unknown tool "${name}". Available: ${TOOL_NAMES.join(', ')}.`);
    this.name = 'UnknownToolError';
  }
}

export interface ToolInvocationFailure {
  error: string;
  kind: 'unknown_tool' | 'invalid_input' | 'failed';
  /** Per-field validation problems, when the input was the issue. */
  issues?: { path: string; message: string }[];
}

/**
 * Validate then run. Validation is deliberately strict: the tolerant parser
 * used for streamed tool input can return a silently truncated object, so a
 * missing or malformed field must surface as a rejection rather than as a
 * query over the wrong window.
 */
export async function invokeTool(
  name: string,
  rawInput: unknown,
): Promise<{ ok: true; result: Envelope<unknown> } | { ok: false; failure: ToolInvocationFailure }> {
  const tool = getTool(name);
  if (!tool) {
    return { ok: false, failure: { error: new UnknownToolError(name).message, kind: 'unknown_tool' } };
  }

  const parsed = tool.inputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        error: `Invalid input for ${name}.`,
        kind: 'invalid_input',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message,
        })),
      },
    };
  }

  try {
    return { ok: true, result: await tool.handler(parsed.data) };
  } catch (err) {
    // Time and input errors are the caller's fault and are worth reporting
    // verbatim so the agent can correct itself. Anything else is ours, and the
    // message is not promised to be safe to echo.
    if (err instanceof TimeParamError || err instanceof ToolInputError) {
      return { ok: false, failure: { error: err.message, kind: 'invalid_input' } };
    }
    console.error(`[tools] ${name} failed:`, err);
    return {
      ok: false,
      failure: { error: `${name} failed to execute.`, kind: 'failed' },
    };
  }
}
