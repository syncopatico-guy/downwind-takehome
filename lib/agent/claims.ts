/**
 * The grounded-answer contract, and its enforcement.
 *
 * Decision 5e chose typed claims with citation ids over prose with inline
 * markers, accepting that the final answer cannot stream as progressive text.
 * The reason is here: because composition is a separate call over accumulated
 * tool results, every citation can be checked against the record ids the tools
 * actually returned, and the compose step retried ALONE when a claim comes
 * back uncited -- without re-running any tool work. Citation integrity becomes
 * enforcement rather than an instruction the model may or may not follow.
 */

import { z } from 'zod';

export const ClaimSchema = z.object({
  statement: z.string().describe('One factual statement, in plain language.'),
  citations: z.array(z.string()).describe(
    'record_id values taken verbatim from tool results, e.g. "aq_measurement:842193".',
  ),
  confidence: z.enum(['high', 'medium', 'low']).describe(
    'high: direct measurement. medium: rests on a model or a single station. ' +
    'low: rests on attribution, a stale feed, or a disputed reading.',
  ),
});

export const MapFocusSchema = z.object({
  min_lat: z.number(), max_lat: z.number(),
  min_lon: z.number(), max_lon: z.number(),
  at: z.string().nullable().describe('ISO 8601 moment the answer is about, or null for now.'),
  label: z.string().nullable().describe('What to call this place in the interface.'),
});

export const ClaimsSchema = z.object({
  answer: z.string().describe('Two or three sentences for a person, leading with the finding.'),
  claims: z.array(ClaimSchema),
  map_focus: MapFocusSchema.nullable().describe(
    'Where and when the interface should look. Null if the answer is not about a place.',
  ),
});

export type Claims = z.infer<typeof ClaimsSchema>;
export type Claim = z.infer<typeof ClaimSchema>;

export interface CitationProblem {
  claim_index: number;
  statement: string;
  kind: 'uncited' | 'unknown_id';
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: CitationProblem[];
  /** Ids cited that the tools never returned. The retry prompt names these. */
  invented: string[];
  cited_count: number;
}

/**
 * Check every citation against what the tools actually returned.
 *
 * Two failures are possible and they need different messages back to the
 * model: a claim with no citations at all, and a claim citing an id that was
 * never in a tool result. The second is the dangerous one -- a fabricated
 * record id looks exactly like a real one to a reader.
 *
 * The zero-citation rule has one deliberate exception. With no typed refusal
 * field in the schema, "nothing was found" has to be expressed as a claim; so
 * when the tools returned no records AT ALL, an uncited claim is the grounded
 * answer rather than an ungrounded one. That exception is conditioned on the
 * tool results, not on the model asserting it.
 */
export function validateCitations(
  claims: Claims,
  availableIds: ReadonlySet<string>,
): ValidationResult {
  const problems: CitationProblem[] = [];
  const invented = new Set<string>();
  let cited = 0;

  const toolsReturnedNothing = availableIds.size === 0;

  claims.claims.forEach((claim, i) => {
    if (claim.citations.length === 0) {
      if (!toolsReturnedNothing) {
        problems.push({
          claim_index: i,
          statement: claim.statement,
          kind: 'uncited',
          detail: 'No citations. Every claim needs the record_id of a record that supports it.',
        });
      }
      return;
    }
    for (const id of claim.citations) {
      if (availableIds.has(id)) {
        cited++;
      } else {
        invented.add(id);
        problems.push({
          claim_index: i,
          statement: claim.statement,
          kind: 'unknown_id',
          detail: `Cited "${id}", which no tool returned.`,
        });
      }
    }
  });

  return {
    ok: problems.length === 0,
    problems,
    invented: [...invented],
    cited_count: cited,
  };
}

/** The correction sent back when composition is retried. */
export function retryInstruction(result: ValidationResult): string {
  const lines = ['Your previous answer failed citation validation. Fix it and return the whole answer again.'];
  for (const p of result.problems.slice(0, 10)) {
    lines.push(`- Claim ${p.claim_index + 1} ("${p.statement.slice(0, 80)}"): ${p.detail}`);
  }
  if (result.invented.length > 0) {
    lines.push(
      '',
      'These ids appear in no tool result: ' + result.invented.slice(0, 10).map((i) => `"${i}"`).join(', ') + '.',
      'Copy record_id values verbatim from the tool results above. Do not construct them.',
    );
  }
  lines.push(
    '',
    'If a claim cannot be supported by a record the tools returned, remove the claim or restate it as something the data does show.',
  );
  return lines.join('\n');
}
