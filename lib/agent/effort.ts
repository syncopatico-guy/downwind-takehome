/**
 * Effort routing: how hard should the model think about this question?
 *
 * Decision 5f called for `low` on single-fact lookups and `high` on multi-hop
 * attribution. Measured on this build, the spread is real: a simple lookup ran
 * 18 s and $0.06, the Yosemite attribution question 80 s and $0.37 on the same
 * model. Most questions are the cheap kind, so routing them down is most of
 * the saving on a fixed budget.
 *
 * Deliberately a heuristic over the question text rather than a classifier
 * call. A classifier would be another API request on every question -- latency
 * and cost on the path this exists to make cheaper -- to decide something the
 * wording usually gives away.
 *
 * The bias is asymmetric and intentional. Under-thinking a hard question
 * produces a confident wrong answer, which is the failure this whole system is
 * built to avoid; over-thinking an easy one costs a few cents. So nothing
 * routes DOWN unless it clearly looks like a lookup, and anything ambiguous
 * lands in the middle rather than at the bottom.
 */

export type Effort = 'low' | 'medium' | 'high';

export interface EffortDecision {
  effort: Effort;
  reason: string;
}

/**
 * Causation, comparison and forecasting all need several tools and a chain of
 * reasoning across them -- which is exactly where a shallow pass produces a
 * plausible wrong answer.
 */
const HIGH_SIGNALS: [RegExp, string][] = [
  [/\b(why|cause[sd]?|causing|responsible|blame|due to|because|attribut\w*)\b/i, 'causal'],
  [/\b(which|what) (fire|fires|source)/i, 'attribution'],
  [/\b(coming from|source of|where.{0,12}from)\b/i, 'attribution'],
  [/\b(compare[ds]?|comparison|versus|vs\.?|than (yesterday|last|before))\b/i, 'comparison'],
  [/\b(chang\w+|trend|worse|better|improv\w+|deteriorat\w+|since)\b/i, 'change over time'],
  [/\b(will|going to|heading|expect\w*|forecast\w*|next \d|tomorrow|later)\b/i, 'forecast'],
  [/\b(how (confident|sure|reliable)|can i trust|how do you know|is that right)\b/i, 'confidence'],
  [/\b(explain|walk me through|break ?down|reason\w*)\b/i, 'explanation'],
];

/**
 * A single current-state reading of one thing. These are answered by one or
 * two tool calls and a sentence, and a deeper pass adds nothing but latency.
 */
const LOW_SIGNALS: [RegExp, string][] = [
  [/^(what('s| is|s)?|how)\b.{0,50}\b(air quality|aqi|pm2\.?5|smoky|smoke level)\b/i, 'current-state lookup'],
  [/^(are|is) (there|it)\b.{0,40}\b(fires?|smoky|smoke|alerts?)\b/i, 'presence check'],
  [/^how many\b.{0,50}\b(fires?|stations?|alerts?|detections?)\b/i, 'count'],
  [/\b(data (health|fresh\w*)|how (fresh|current|old) is|last updated|feeds? (up to date|working))\b/i, 'health check'],
  [/^(where|which)\b.{0,40}\b(worst|highest|cleanest|most)\b.{0,30}$/i, 'ranking'],
];

/**
 * Advice-seeking, which these tools cannot answer.
 *
 * "Air quality in Portland for someone with asthma who cycles to work" looks
 * like a lookup and routes down on shape alone, but the model has to recognise
 * the health question, decline that part, and still answer the measurable
 * part. That is more work than a lookup, not less.
 */
const ADVICE_SIGNALS =
  /\b(should i|is it safe|safe to|for (someone|a person|people|my|kids|children)|if i|given (my|that)|recommend\w*|advice)\b/i;

/** Several distinct asks in one message need the tools chained regardless. */
function looksMultiPart(q: string): boolean {
  const questionMarks = (q.match(/\?/g) ?? []).length;
  if (questionMarks > 1) return true;
  // " and " joining two clauses that each carry a verb, rather than a list.
  return /\?.*\band\b/i.test(q) || /\band (how|why|which|what|where|when)\b/i.test(q);
}

export function classifyEffort(question: string): EffortDecision {
  const q = question.trim();

  for (const [pattern, label] of HIGH_SIGNALS) {
    if (pattern.test(q)) return { effort: 'high', reason: `${label} question` };
  }
  if (looksMultiPart(q)) {
    return { effort: 'high', reason: 'several asks in one question' };
  }

  if (ADVICE_SIGNALS.test(q)) {
    return { effort: 'medium', reason: 'asks for advice the tools cannot give' };
  }

  // Routing down needs both a matching shape AND brevity. The threshold was 90
  // and let through "air quality in Portland for someone with asthma who
  // cycles to work" at 79 characters -- a lookup shape wrapping a question the
  // tools cannot answer. Every genuine lookup in the test set is under 45
  // characters, so 60 keeps them all with room to spare.
  if (q.length <= 60) {
    for (const [pattern, label] of LOW_SIGNALS) {
      if (pattern.test(q)) return { effort: 'low', reason: label };
    }
  }

  return { effort: 'medium', reason: 'no clear signal either way' };
}
