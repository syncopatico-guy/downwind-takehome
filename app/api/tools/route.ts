/**
 * GET /api/tools -- the tool surface, described.
 *
 * Useful on its own for checking a deployment, and it is the same list the
 * agent is given, derived from the same Zod schemas.
 */

import { anthropicToolDefinitions, TOOL_NAMES } from '@/lib/tools/registry';

// Route handlers are uncached by default in Next 16, which is what we want:
// every one of these reads live data.
export async function GET() {
  return Response.json({
    tools: anthropicToolDefinitions(),
    names: TOOL_NAMES,
    count: TOOL_NAMES.length,
  });
}
