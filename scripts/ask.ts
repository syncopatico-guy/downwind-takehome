/**
 * Ask the agent a question from the terminal: npm run ask -- "your question"
 *
 *   --model=opus|sonnet   default sonnet (Decision 5f amended: build on the
 *                         cheaper model, choose the demo model by measurement)
 *   --effort=low|medium|high
 *   --as-of=<ISO>         answer as the timeline would at that moment
 *   --json                raw result, for scripting
 *
 * Exists because iterating through the UI costs a rebuild and a page load per
 * question while spending the same tokens. Every run prints its measured cost
 * so the budget stays visible rather than inferred.
 */

import { config } from 'dotenv';

config({ path: '.env.local', quiet: true });
config({ quiet: true });

import { ask, type AgentModel } from '../lib/agent/run';
import { closePool } from '../lib/db';

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}
const hasFlag = (n: string) => process.argv.includes(`--${n}`);

const CONF = { high: 'HIGH  ', medium: 'MEDIUM', low: 'LOW   ' } as const;

async function main(): Promise<void> {
  const question = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ');
  if (!question) {
    console.error('usage: npm run ask -- "which fires are affecting Portland?"');
    process.exitCode = 1;
    return;
  }

  const modelArg = (arg('model') ?? 'sonnet').toLowerCase();
  const model: AgentModel = modelArg.startsWith('o') ? 'claude-opus-5' : 'claude-sonnet-5';
  const effort = (arg('effort') ?? 'high') as 'low' | 'medium' | 'high';
  const json = hasFlag('json');

  if (!json) {
    console.log(`\n  ${question}`);
    console.log(`  ${model} · effort=${effort}\n`);
  }

  const result = await ask({
    question, model, effort, asOf: arg('as-of'),
    onProgress: json ? undefined : (e) => {
      if (e.phase === 'start') process.stdout.write(`    ${e.tool} ...`);
      else console.log(` ${e.detail ?? 'done'}`);
    },
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.error) {
    console.log(`\n  ERROR: ${result.error}`);
  } else if (result.claims) {
    console.log(`\n  ${result.claims.answer}\n`);
    result.claims.claims.forEach((c, i) => {
      console.log(`  ${i + 1}. [${CONF[c.confidence]}] ${c.statement}`);
      console.log(`     ${c.citations.length ? c.citations.slice(0, 4).join('  ') : '(no citations)'}` +
        (c.citations.length > 4 ? `  +${c.citations.length - 4} more` : ''));
    });
    if (result.claims.map_focus) {
      const m = result.claims.map_focus;
      console.log(`\n  map: ${m.label ?? '(unnamed)'} ` +
        `[${m.min_lat.toFixed(2)}, ${m.min_lon.toFixed(2)} .. ${m.max_lat.toFixed(2)}, ${m.max_lon.toFixed(2)}]` +
        (m.at ? ` at ${m.at}` : ''));
    }
    const v = result.validation;
    if (v && !v.ok) {
      console.log(`\n  CITATION PROBLEMS (${v.problems.length}) after ${result.compose_attempts} attempt(s):`);
      for (const p of v.problems.slice(0, 5)) console.log(`    - ${p.kind}: ${p.detail}`);
    }
  }

  if (!json) {
    const u = result.usage;
    console.log(
      `\n  ${result.calls.length} tool call(s) · ${result.evidence.length} citable records · ` +
      `${result.compose_attempts} compose attempt(s) · ${(result.elapsed_ms / 1000).toFixed(1)}s`);
    console.log(
      `  tokens: ${u.input_tokens} in (${u.cache_read_input_tokens} cached, ` +
      `${u.cache_creation_input_tokens} written) / ${u.output_tokens} out`);
    console.log(`  cost:   $${u.estimated_cost_usd.toFixed(4)}\n`);
  }
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exitCode = 1; })
  .finally(closePool);
