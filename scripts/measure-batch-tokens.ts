/**
 * Analytical token A/B: per-call loop vs. one guarded `batch`.
 *
 * NOT a live LLM run — it reconstructs the per-turn message payloads and
 * tokenizes them, using the REAL tool catalog (the dominant re-read cost) so
 * the ratio is grounded. The per-call model is deliberately the BEST case for
 * per-call (1 LLM turn per action, NO retries/refocus — which real runs
 * incur), so any batch advantage here is a floor, not a ceiling.
 *
 * The whole point being tested (the review's caveat): does emitting a step
 * list cost more than it saves? Run: npx tsx scripts/measure-batch-tokens.ts
 */
import { getCompactTools, getTools } from '../src/tools/registry';

// ~3.5 chars/token for Claude on English+JSON. The per-call/batch RATIO is
// robust to this constant (it appears on both sides).
const CHARS_PER_TOKEN = 3.5;
const tok = (s: string) => Math.round(s.length / CHARS_PER_TOKEN);
const schemaTokens = (tools: { name: string; description: string; parameters: unknown }[]) =>
  tok(JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))));

// ── REAL fixed costs (catalog from actual code) ─────────────────────────────
const CATALOG_COMPACT = schemaTokens(getCompactTools() as any);   // re-read EVERY turn in per-call
const CATALOG_GRANULAR = schemaTokens(getTools() as any);
const SYSTEM = 1500;          // representative system prompt (measured ~1.3–1.6K)
const PERCEIVE_RESULT = 800;  // a11y read_tree / window list result re-entering context (~700–900)
const ACT_RESULT = 25;        // "Key pressed: X", "Typed N chars", etc.
const TOOLCALL_OUT = 30;      // one tool_call generation
const BATCH_OUT_PER_STEP = 18;// generating one step of the list
const TRACE_PER_STEP = 35;    // one line of the batch result trace (perception FILTERED to a summary)

function perCall(steps: readonly string[], catalog: number) {
  let input = 0, output = 0, history = 0;
  for (const kind of steps) {
    input += SYSTEM + catalog + history;                 // re-read everything, every turn
    output += TOOLCALL_OUT;
    history += TOOLCALL_OUT + (kind === 'perceive' ? PERCEIVE_RESULT : ACT_RESULT);
  }
  return { turns: steps.length, input, output, total: input + output };
}

function batch(steps: readonly string[], catalog: number, replans: number) {
  const n = steps.length;
  const genOut = n * BATCH_OUT_PER_STEP;
  const trace = n * TRACE_PER_STEP;             // combined result: summaries, not full perception blobs
  let input = 0, output = 0, history = 0, turns = 0;
  for (let r = 0; r <= replans; r++) {
    turns++;
    input += SYSTEM + catalog + history;
    output += genOut + (r > 0 ? 0 : 0);
    history += genOut + trace;
  }
  return { turns, input, output, total: input + output };
}

function row(label: string, m: { turns: number; input: number; output: number; total: number }) {
  console.log(
    `  ${label.padEnd(28)} turns=${String(m.turns).padStart(2)}  in=${String(m.input).padStart(7)}  out=${String(m.output).padStart(5)}  TOTAL=${String(m.total).padStart(7)}`,
  );
}

console.log(`Catalog sizes (real): compact=${CATALOG_COMPACT} tok | granular=${CATALOG_GRANULAR} tok`);
console.log(`Assumptions: ${CHARS_PER_TOKEN} chars/tok, system=${SYSTEM}, perceive-result=${PERCEIVE_RESULT}, act-result=${ACT_RESULT}\n`);

for (const [surface, catalog] of [['COMPACT', CATALOG_COMPACT], ['GRANULAR', CATALOG_GRANULAR]] as const) {
  for (const size of [4, 8, 16]) {
    const steps = Array.from({ length: size }, (_, i) => (i % 2 === 1 ? 'perceive' : 'act'));
    const pc = perCall(steps, catalog);
    const b1 = batch(steps, catalog, 1);   // 1 re-plan (realistic)
    const b2 = batch(steps, catalog, 2);   // 2 re-plans (pessimistic)
    console.log(`── ${surface} catalog · ${size}-action task ──`);
    row('per-call (best case)', pc);
    row('batch (1 re-plan)', b1);
    row('batch (2 re-plans)', b2);
    console.log(`     -> batch(1) uses ${(b1.total / pc.total * 100).toFixed(0)}% of per-call tokens (${pc.total - b1.total >= 0 ? 'saves' : 'COSTS'} ${Math.abs(pc.total - b1.total)})\n`);
  }
}
