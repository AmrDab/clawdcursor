/**
 * Guarded action-sequence executor + the `batch` tool.
 *
 * Lets an AI driving clawdcursor (over MCP, or the autonomous loop) submit an
 * ORDERED LIST of tool calls that run in one shot — collapsing N round-trips
 * into one — WITHOUT a code sandbox. It is DECLARATIVE on purpose:
 *
 *   - Each step is `{ name, arguments, expect? }` (`args` is accepted for
 *     `arguments`, matching the agent-loop batch) — a normal tool call plus an
 *     optional precondition guard. No arbitrary code → no injection-as-control-
 *     flow, no element-handle staleness (every step re-queries by name), no
 *     opaque partial-execution blob.
 *   - Every step runs through the SAME `getTool().handler` execution path the MCP server uses per call, behind the
 *     same guards: the user's Stop and pause, clawdcursor's own UI, the screenshot binding — and, in the input layer
 *     below every handler, the hard key list and the AI-host guard. A batch is not a way around any of them.
 *   - Between steps the executor RE-PERCEIVES to check each step's `expect`
 *     guard; on any guard miss / refusal / step error it HALTS and returns
 *     a structured trace so the caller re-plans from real state (the morph
 *     ladder's recovery, just coarser).
 *
 * This is the "batched planning" middle path: most of Code Mode's efficiency,
 * none of the sandbox's hard problems (see the architecture review).
 */
import { getTool, getCompactTools } from './registry';
import { windowTextIncludes } from '../platform/window-text';
import type { ToolContext, ToolResult, ToolDefinition } from './types';
import { refusalBefore, afterCall, guardedCall, type GuardedCall, type Refusal } from './call-guards';
import { logger } from '../core/observability/logger';
import { clipScreenText, quoteScreenText } from '../core/untrusted-screen-content';
import { actedIn, actRecord } from '../core/control';
import { effectLine } from '../core/effect';

/** Resolve a step's tool by name from EITHER surface — a granular tool
 *  (`mouse_click`, `open_app`, …) or a compound tool (`computer`, `window`, …)
 *  — so a batch works whether the caller drives the 97-tool or 6-compound API. */
function resolveAnyTool(name: string): ToolDefinition | undefined {
  return getTool(name) ?? getCompactTools().find(t => t.name === name);
}

/** A lightweight, declarative precondition checked (by re-perceiving) before a step runs. */
export interface BatchGuard {
  /** An a11y element with this name must be present in the current UI. */
  element?: string;
  /** The foreground/active window's title or processName must contain this (case-insensitive). */
  window?: string;
}

export interface BatchStep {
  /** Tool name — a compound (`computer`/`window`/…) with `arguments.action`, or a granular tool. */
  name: string;
  arguments?: Record<string, unknown>;
  /** Alias of `arguments` — the agent-loop batch's spelling. A step written
   *  with `args` used to run with no arguments at all. */
  args?: Record<string, unknown>;
  /** Optional precondition; if it fails the batch halts here and reports back. */
  expect?: BatchGuard;
  /** Canonical alias for `expect` (matches the agent-loop batch). An `expect`
   *  ASSERTION ARRAY belongs inside `arguments` instead — the projected tool
   *  handlers verify it post-action. */
  precheck?: BatchGuard;
  /** Optional human label for the trace. */
  label?: string;
}

type StepStatus = 'ok' | 'guard_failed' | 'blocked' | 'error' | 'unknown_tool' | 'skipped';

export interface StepOutcome { i: number; label: string; status: StepStatus; text: string; pressedKeys?: boolean;
  /** What THIS step acted on, verified when it was sent: not the batch's last target. */
  app?: string; appPid?: number; appHandle?: number; }

export interface BatchResult {
  total: number;
  completed: number;
  allDone: boolean;
  stoppedAt?: number;
  stopReason?: string;
  steps: StepOutcome[];
  /** The image of the last step that returned one (a screenshot, a zoom), and that step's index. */
  image?: NonNullable<ToolResult['image']>;
  imageStep?: number;
}

const DEFAULT_MAX_STEPS = 12;

function stepArgs(step: BatchStep): Record<string, unknown> {
  return step.arguments ?? step.args ?? {};
}

function labelFor(step: BatchStep): string {
  if (step.label) return step.label;
  const action = stepArgs(step).action;
  return action ? `${step.name}.${String(action)}` : step.name;
}

/** Re-perceive and evaluate a step's precondition guard. Returns ok=false with a reason on miss. */
async function checkGuard(guard: BatchGuard, ctx: ToolContext): Promise<{ ok: boolean; detail: string }> {
  if (guard.window) {
    const t = getTool('get_active_window');
    if (t) {
      const r = await t.handler({}, ctx).catch((e): ToolResult => ({ text: String(e), isError: true }));
      // Window-aware normalization: real titles carry invisible Unicode (Edge's
      // NBSP in "Microsoft Edge") that defeats a plain substring compare (#bug
      // 2026-06-11).
      if (!windowTextIncludes(r.text, guard.window)) {
        return { ok: false, detail: `foreground window is not "${guard.window}" (got: ${quoteScreenText((r.text || '').slice(0, 90))})` };
      }
    }
  }
  if (guard.element) {
    const t = getTool('find_element');
    if (t) {
      const r = await t.handler({ name: guard.element }, ctx).catch((e): ToolResult => ({ text: String(e), isError: true }));
      // Element presence is decided by find_element's own absence markers, not
      // by title matching — leave this ASCII-literal (the window guard above is
      // where the invisible-Unicode normalization matters).
      const txt = (r.text || '').toLowerCase();
      const missing = r.isError || txt.includes('not found') || txt.includes('no match') || txt.includes('no element') || /\b0 (match|element)/.test(txt);
      if (missing) return { ok: false, detail: `element "${guard.element}" not present` };
    }
  }
  return { ok: true, detail: '' };
}

/**
 * Run an ordered list of guarded tool calls, halting on the first guard miss,
 * refusal, or step error. Reuses the real guards + tool handlers.
 */
export async function executeBatch(
  steps: BatchStep[],
  ctx: ToolContext,
  opts: { maxSteps?: number } = {},
): Promise<BatchResult> {
  const cap = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const outcomes: StepOutcome[] = [];
  let completed = 0;
  // "Act N times, then look once" in one call: the last image a step returned goes back with the trace.
  let shot: Pick<BatchResult, 'image' | 'imageStep'> = {};

  const halt = (i: number, reason: string): BatchResult =>
    ({ total: steps.length, completed, allDone: false, stoppedAt: i, stopReason: reason, steps: outcomes, ...shot });
  const block = (i: number, label: string, c: GuardedCall, r: Refusal): BatchResult => {
    logger.warn('safety.refused', { tool: c.tool, action: c.action, guard: r.guard, reason: r.why, batchStep: i });
    // The Stop and pause texts whole: they say what to do next.
    outcomes.push({ i, label, status: 'blocked', text: r.guard === 'stopped' || r.guard === 'own_ui' ? r.why : r.why.slice(0, 200) });
    return halt(i, `step ${i} (${label}): ${r.why}`);
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = labelFor(step);

    if (i >= cap) {
      outcomes.push({ i, label, status: 'skipped', text: `not run — batch capped at ${cap} steps` });
      return halt(i, `batch capped at ${cap} steps; submit the remainder as a new batch`);
    }

    const tool: ToolDefinition | undefined = resolveAnyTool(step.name);
    if (!tool) {
      outcomes.push({ i, label, status: 'unknown_tool', text: `tool "${step.name}" is not registered` });
      return halt(i, `unknown tool "${step.name}"`);
    }

    // Precondition: re-perceive and verify the step's expectation.
    // `precheck` is the canonical name (parity with the agent-loop batch);
    // `expect` remains the documented MCP alias for back-compat.
    const guard = step.precheck ?? step.expect;
    const args = stepArgs(step);
    const stepAction = typeof args.action === 'string' ? args.action : undefined;
    // Refused as the same call made directly would be (call-guards.ts), before the precondition, which reads the screen.
    const call = guardedCall(tool.name, stepAction, args, !!guard);
    const refused = await refusalBefore(call, ctx);
    if (refused) return block(i, label, call, refused);

    if (guard) {
      const g = await checkGuard(guard, ctx);
      if (!g.ok) {
        outcomes.push({ i, label, status: 'guard_failed', text: `precondition failed: ${g.detail}` });
        return halt(i, `precondition failed at step ${i} — re-plan from current state`);
      }
    }

    let res: ToolResult;
    const before = actedIn();
    try {
      res = await tool.handler(args, ctx);
    } catch (e) {
      res = { text: `threw: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
    // This step's own target (if it acted on a window at all), as the input guard verified it when the step ran.
    const target = actRecord(before);
    if (res.isError) {
      outcomes.push({ i, label, status: 'error', text: clipScreenText(res.text || '', 200), pressedKeys: res.pressedKeys, ...target });
      return halt(i, `step ${i} (${label}) errored`);
    }

    const after = await afterCall(call, res, ctx);
    if ('guard' in after) return block(i, label, call, after);
    // A screenshot step names its id first, so it survives the step text's truncation.
    const shotNote = after.screenshotNote ? `${after.screenshotNote.split(' — ')[0]} · ` : '';
    outcomes.push({ i, label, status: 'ok', text: `${shotNote}${clipScreenText(res.text || '', 160)}`, pressedKeys: res.pressedKeys, ...target });
    if (res.image) shot = { image: res.image, imageStep: i };
    completed++;
  }

  return { total: steps.length, completed, allDone: completed === steps.length, steps: outcomes, ...shot };
}

function renderResult(r: BatchResult): string {
  const lines = r.steps.map(s => `  ${s.i}. [${s.status}] ${s.label} — ${s.text}`);
  const head = r.allDone
    ? `batch: all ${r.total} steps completed.`
    : `batch: ${r.completed}/${r.total} completed, halted at step ${r.stoppedAt} — ${r.stopReason}`;
  const image = r.imageStep !== undefined ? ` The image attached is step ${r.imageStep}'s.` : '';
  return `${head}${image}\n${lines.join('\n')}`;
}

export function getBatchTools(): ToolDefinition[] {
  return [
    {
      name: 'batch',
      annotations: { title: 'Run several tool calls in one round trip', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        'Run an ORDERED LIST of tool calls in one shot (collapses many round-trips into one). Each step is ' +
        '{ name, arguments, expect? } (`args` is accepted for `arguments`). `name`+`arguments` is a normal tool call (compound like ' +
        '{"name":"computer","arguments":{"action":"type","text":"hi"}} or a granular tool). Optional `expect` ' +
        'is a precondition checked by RE-PERCEIVING before the step runs: {"window":"notepad"} (foreground ' +
        'window must match) or {"element":"Send"} (a11y element must be present). The batch HALTS on the first ' +
        'failed precondition, refusal, or step error and returns a per-step trace so you re-plan from real ' +
        'state. A step is refused exactly as a direct call would be (the user has stopped or paused clawdcursor, a dangerous key combo, an AI assistant window in front). ' +
        'Do not batch past an irreversible step the user did not ask for: ask first with system pause_for_user.',
      parameters: {
        steps: {
          type: 'array',
          required: true,
          description: 'Ordered steps to run. Each step is a normal tool call: { "name": "<tool>", "arguments": {...}, "expect"?: {"window"?,"element"?} } ("args" is accepted for "arguments"). (A JSON-encoded string of the same array is also accepted.)',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Tool to call — a compound ("computer"/"window"/...) or a granular tool.' },
              arguments: { type: 'object', description: 'Arguments for that tool, e.g. {"action":"type","text":"hi"}. May include an `expect` ASSERTION ARRAY (post-condition) — verified after the step by the tool itself.' },
              args: { type: 'object', description: 'Alias of `arguments`.' },
              expect: { type: 'object', description: 'Optional precondition re-checked by perceiving before the step: {"window":"..."} or {"element":"..."}. (`precheck` is an accepted alias.)' },
            },
            required: ['name'],
          },
        },
        maxSteps: { type: 'number', description: `Hard cap on executed steps (default ${DEFAULT_MAX_STEPS}).`, required: false },
      },
      category: 'orchestration',
      safetyTier: 0, // the batch itself is inert; the pill shows when a STEP acts (batchActs).
      handler: async (params, ctx: ToolContext): Promise<ToolResult> => {
        // `steps` arrives as a JSON string (constrained schema) or, from clients
        // that pass rich JSON, a real array. Accept both.
        let steps: BatchStep[];
        const raw = params.steps;
        if (typeof raw === 'string') {
          try { steps = JSON.parse(raw); } catch { return { text: 'batch: `steps` must be a valid JSON array.', isError: true }; }
        } else if (Array.isArray(raw)) {
          steps = raw as BatchStep[];
        } else {
          return { text: 'batch: `steps` must be a JSON array of { name, arguments, expect? }.', isError: true };
        }
        if (!Array.isArray(steps) || steps.length === 0) {
          return { text: 'batch: `steps` must be a non-empty array of { name, arguments, expect? }.', isError: true };
        }
        for (const s of steps) {
          if (!s || typeof s.name !== 'string') {
            return { text: 'batch: every step needs a string `name` (the tool to call).', isError: true };
          }
        }

        // Once per batch: what the window in front did across all its steps (#357), by identity, never by title.
        const window = () => ctx.platform?.getActiveWindow().catch(() => null) ?? Promise.resolve(null);
        const w0 = await window();
        const result = await executeBatch(steps, ctx, {
          maxSteps: typeof params.maxSteps === 'number' ? params.maxSteps : undefined,
        });
        const effect = effectLine(w0, await window());
        return {
          text: renderResult(result) + (effect ? `\n${effect}` : ''),
          isError: !result.allDone,
          ...(result.image ? { image: result.image } : {}),
          steps: result.steps.map(s => {
            const a = stepArgs(steps[s.i]).action;
            return { tool: steps[s.i].name, ...(typeof a === 'string' ? { action: a } : {}), status: s.status, text: s.text, pressedKeys: s.pressedKeys,
              ...(s.app ? { app: s.app } : {}), ...(s.appPid ? { appPid: s.appPid } : {}), ...(s.appHandle ? { appHandle: s.appHandle } : {}) };
          }),
        };
      },
    },
  ];
}
