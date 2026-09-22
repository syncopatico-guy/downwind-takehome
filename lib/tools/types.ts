/**
 * The shape every tool shares.
 *
 * Decision 5a chose nine curated tools over a raw SQL surface, so the tool
 * definition is the whole contract between the agent and the database. Keeping
 * the input schema as Zod means Step 12 derives the Anthropic tool definition
 * from the same object that validates the call, rather than maintaining a JSON
 * Schema alongside it and letting the two drift.
 */

import type { z } from 'zod';
import type { Envelope } from './envelope';

export interface ToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny, TRow = unknown> {
  name: string;
  /** Written for the model: what it answers, and what it deliberately does not. */
  description: string;
  inputSchema: TInput;
  handler: (input: z.infer<TInput>) => Promise<Envelope<TRow>>;
}

export class ToolInputError extends Error {}
