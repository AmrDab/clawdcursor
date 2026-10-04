/**
 * `batch` — the autonomous loop's action-list executor (Phase 3).
 *
 * Lets the cheap text brain (Haiku) plan SEVERAL known next actions and run them
 * in ONE turn instead of one tool-call per LLM round-trip. Same shape and
 * guarantees as the MCP-side `batch` (src/tools/batch.ts) but over the agent-loop
 * machinery: UnifiedTool catalog, AgentToolContext, and the loop's own
 * `safety.evaluate` chokepoint. Declarative + guarded:
 *
 *   - Each step { name, args, precheck? } is a normal agent-loop tool call.
 *   - Optional `precheck` ({window}|{element}) is re-checked against LIVE state
 *     before the step — so an action can't fire into the wrong window.
 *   - Steps get the SAME per-call treatment as single tool calls (audit
 *     2026-06-10, finding B): el_NN→label resolution for the safety gate,
 *     activeApp refreshed from a post-step snapshot, outcome-gated UIMap
 *     invalidation, and the Layer C reactive check (assertion-array `expect`
 *     in a step's args is verified, DEVIATION halts the batch).
 *   - Halts on the first guard miss / safety stop / step failure / DEVIATION
 *     and returns a trace; the loop continues from real state.
 *
 * The token A/B (scripts/measure-batch-tokens.ts) shows this collapses the
 * per-turn catalog/perception re-reads — the win grows with task length.
 */
import type { UnifiedTool, UnifiedToolResult, AgentToolContext } from './types';
import { buildUnifiedTools } from './tools';
import { evaluate as safetyEvaluate, isAllowed } from '../safety';
import { captureSnapshot } from '../sense/snapshot';
import { reactiveCheck } from '../sense/reactive-check';
import { validateExpect } from '../verify/assertions';
import { OcrEngine } from '../../platform/ocr-engine';
import { windowTextIncludes } from '../../tools/window-text';

interface AgentBatchStep {
  name: string;
  args?: Record<string, unknown>;
  /** Precondition re-checked against live state before the step. */
  precheck?: { element?: string; window?: string };
  /** Legacy alias: an OBJECT here is treated as `precheck`; an ARRAY is
   *  treated as the assertion-list post-condition (same as args.expect). */
  expect?: { element?: string; window?: string } | unknown[];
  label?: string;
}

const MAX_STEPS = 10;

// Lazy OCR singleton for per-step reactive checks — mirrors agent.ts reactiveOcr.
let _batchOcr: OcrEngine | null = null;
function batchOcr(): OcrEngine { return (_batchOcr ??= new OcrEngine()); }

type Snap = Awaited<ReturnType<typeof captureSnapshot>>;

/** Re-perceive the a11y tree (lower-cased) — fallback guard surface when a
 *  structured snapshot is unavailable. */
async function perceiveTree(ctx: AgentToolContext): Promise<string> {
  const rs = buildUnifiedTools().find(t => t.name === 'read_screen');
  if (!rs) return '';
  try { return ((await rs.execute({}, ctx)).text || '').toLowerCase(); } catch { return ''; }
}

export function buildBatchTool(): UnifiedTool {
  return {
    name: 'batch',
    description:
      'Run SEVERAL known next actions in ONE call instead of one per turn (saves round-trips). ' +
      'steps = JSON array of {"name","args","precheck"?}. Each step is a normal tool call (e.g. ' +
      '{"name":"type","args":{"text":"hi"}}). Optional "precheck" is a precondition re-checked ' +
      'against live state before the step: {"window":"notepad"} (that window must be focused) or ' +
      '{"element":"Send"} (that a11y element must exist). An `expect` assertion array inside a ' +
      'step\'s args is verified after that step (DEVIATION halts the batch). The batch STOPS at ' +
      'the first failed precondition, safety stop, step error, or DEVIATION and returns a ' +
      'per-step trace so you continue from real state. el_NN refs are only safe up to the first ' +
      'screen-changing step — after that the screen moved; target later steps by name. Use it ' +
      'for deterministic stretches (open -> focus -> type -> save). Do NOT put perception-only ' +
      'reads or terminal tools (done/give_up) in a batch.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          maxItems: 10,
          description: 'The steps to run (max 10). Each step is a normal tool call: {"name","args","precheck"?}, e.g. {"name":"type","args":{"text":"hi"}}.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Tool to call (e.g. "type", "key", "invoke_element").' },
              args: { type: 'object', description: 'Arguments object for that tool (may include an `expect` assertion array, verified after the step).' },
              precheck: { type: 'object', description: 'Optional precondition re-checked against live state before the step: {"window":"..."} or {"element":"..."}.' },
            },
            required: ['name'],
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    changesScreen: true,
    async execute(args, ctx): Promise<UnifiedToolResult> {
      let steps: AgentBatchStep[];
      const raw = args.steps;
      try { steps = typeof raw === 'string' ? JSON.parse(raw) : (raw as AgentBatchStep[]); }
      catch { return { success: false, text: 'batch: `steps` must be a JSON array of {name, args, precheck?}.' }; }
      if (!Array.isArray(steps) || steps.length === 0) {
        return { success: false, text: 'batch: `steps` must be a non-empty array.' };
      }

      // Terminal tools must never run inside a batch — their stop/terminalExit
      // semantics are discarded by the trace, so the loop would keep going
      // while the model believes it terminated.
      const byName = new Map(
        buildUnifiedTools().filter(t => t.name !== 'batch' && t.terminal !== true).map(t => [t.name, t]),
      );
      const trace: string[] = [];
      let done = 0;
      const halt = (msg: string): UnifiedToolResult => ({ success: false, text: `${msg}\n${trace.join('\n')}` });

      // Live state tracked ACROSS steps. The single-call path refreshes the
      // active app + invalidates the UIMap holder between actions; the batch
      // must do the same per step, or later steps act on — and are safety-
      // gated against — pre-batch state (audit 2026-06-10, finding B).
      let activeApp = ctx.activeApp;
      let snap: Snap | null = await captureSnapshot(ctx.platform).catch(() => null);
      if (snap?.activeWindow?.processName) activeApp = snap.activeWindow.processName;

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const label = step.label || `${step.name}${step.args?.action ? '.' + String(step.args.action) : ''}`;

        if (i >= MAX_STEPS) { trace.push(`  ${i}. [skipped] ${label}`); return halt(`batch: ${done}/${steps.length} done — capped at ${MAX_STEPS}; submit the rest as a new batch.`); }

        const tool = byName.get(step.name);
        if (!tool) { trace.push(`  ${i}. [unknown] ${label}`); return halt(`batch halted: tool "${step.name}" is not available inside a batch.`); }

        // Precondition. `precheck` is canonical; a legacy OBJECT `expect`
        // is accepted as the same thing (the two shapes used to share one
        // name — audit finding B/H4).
        const legacyExpect = step.expect;
        const precheck = step.precheck
          ?? (legacyExpect && !Array.isArray(legacyExpect) && typeof legacyExpect === 'object'
            ? legacyExpect as { element?: string; window?: string }
            : undefined);
        if (precheck && (precheck.window || precheck.element)) {
          if (!snap) snap = await captureSnapshot(ctx.platform).catch(() => null);
          if (snap) {
            // Structured check: window against the ACTIVE window's process+title
            // (not a substring of arbitrary element text), element against the
            // FULL element list (not a 60-element truncated render).
            if (precheck.window) {
              // window-normalized: tolerate invisible Unicode in titles (Edge's
              // NBSP in "Microsoft Edge") that defeats a plain substring compare.
              const got = `${snap.activeWindow?.processName ?? ''} ${snap.activeWindow?.title ?? ''}`;
              if (!windowTextIncludes(got, precheck.window)) {
                trace.push(`  ${i}. [guard_failed] ${label} — window "${precheck.window}" not focused (active: ${snap.activeWindow?.processName ?? 'unknown'})`);
                return halt(`batch halted at step ${i}: precondition failed (window "${precheck.window}" not focused) — re-plan from current state.`);
              }
            }
            if (precheck.element) {
              const found = snap.elements.some(e => windowTextIncludes(e.name, precheck.element));
              if (!found) {
                trace.push(`  ${i}. [guard_failed] ${label} — element "${precheck.element}" not present`);
                return halt(`batch halted at step ${i}: precondition failed (element "${precheck.element}" not present) — re-plan from current state.`);
              }
            }
          } else {
            // Snapshot unavailable — degrade to the legacy tree-text check
            // rather than blocking the batch outright.
            const tree = await perceiveTree({ ...ctx, activeApp });
            if (precheck.window && !windowTextIncludes(tree, precheck.window)) {
              trace.push(`  ${i}. [guard_failed] ${label} — window "${precheck.window}" not focused`);
              return halt(`batch halted at step ${i}: precondition failed (window "${precheck.window}" not focused) — re-plan from current state.`);
            }
            if (precheck.element && !windowTextIncludes(tree, precheck.element)) {
              trace.push(`  ${i}. [guard_failed] ${label} — element "${precheck.element}" not present`);
              return halt(`batch halted at step ${i}: precondition failed (element "${precheck.element}" not present) — re-plan from current state.`);
            }
          }
        }

        const a = step.args ?? {};
        let targetLabel = typeof a.name === 'string' ? a.name : typeof a.target === 'string' ? a.target : undefined;
        // el_NN refs carry no name/target — resolve the element's label from the
        // holder so the safety gate sees a real label (same as the loop's 5a;
        // without this a batched invoke on a "Send"/"Pay" button skipped the
        // destructive-label rule entirely — audit finding B/H3).
        if (!targetLabel && step.name === 'invoke_element'
            && typeof a.element_id === 'string' && typeof a.snapshot_id === 'string' && ctx.uiMaps) {
          const r = ctx.uiMaps.resolve(a.snapshot_id, Date.now());
          if (r.ok) {
            const el = r.map.elements.find(e => e.id === a.element_id);
            if (el) targetLabel = el.text ?? el.normalized_text ?? undefined;
          }
        }
        const decision = safetyEvaluate({ tool: step.name, args: a, targetLabel, activeApp, userTaskText: ctx.task });
        if (!isAllowed(decision)) {
          trace.push(`  ${i}. [${decision.decision}] ${label}`);
          const why = 'reason' in decision ? decision.reason : decision.tier;
          return halt(`batch halted at step ${i}: safety ${decision.decision} (${why}).`);
        }

        // Layer C per step — the assertion-array `expect` lives in the step's
        // args (same schema as the single-call tools); a step-level ARRAY
        // `expect` is accepted as the same thing. Previously these were
        // silently dropped inside a batch (audit finding B/H4). Validated
        // BEFORE the step runs so a malformed one costs no action.
        const assertionExpect = a.expect !== undefined ? a.expect : (Array.isArray(legacyExpect) ? legacyExpect : undefined);
        const expectError = validateExpect(assertionExpect);
        if (expectError) {
          trace.push(`  ${i}. [error] ${label} — expect rejected (nothing executed)`);
          return halt(`batch halted at step ${i} (${label}): expect rejected (nothing executed): ${expectError}`);
        }

        let res: UnifiedToolResult;
        try { res = await tool.execute(a, { ...ctx, activeApp }); }
        catch (e) { res = { success: false, text: `threw: ${e instanceof Error ? e.message : String(e)}` }; }

        // Post-step parity with the loop's 5c: re-perceive after a screen-
        // changing step, refresh activeApp, and invalidate the holder when the
        // action actually did something (outcome-gated, same rule as the loop).
        let observedChange = false;
        if (tool.changesScreen) {
          const post = await captureSnapshot(ctx.platform).catch(() => null);
          if (post) {
            observedChange = snap ? post.fingerprint !== snap.fingerprint : false;
            snap = post;
            if (post.activeWindow?.processName) activeApp = post.activeWindow.processName;
          }
          if (res.success || observedChange) ctx.uiMaps?.invalidate();
        }

        const reactive = await reactiveCheck({
          expect: assertionExpect,
          toolText: res.text,
          toolSuccess: res.success,
          changesScreen: tool.changesScreen === true,
          observedChange,
          adapter: ctx.platform,
          ocrText: async () => (await batchOcr().recognizeScreen()).fullText ?? '',
        }).catch(() => null);
        if (reactive) res = { ...res, success: reactive.success, text: reactive.text };

        if (!res.success) {
          trace.push(`  ${i}. [error] ${label} — ${(res.text || '').slice(0, 100)}`);
          return halt(`batch halted at step ${i} (${label}): ${(res.text || '').slice(0, 200)}`);
        }
        trace.push(`  ${i}. [ok] ${label} — ${(res.text || '').slice(0, 80)}`);
        done++;
      }
      return { success: true, text: `batch: all ${steps.length} steps completed.\n${trace.join('\n')}` };
    },
  };
}
