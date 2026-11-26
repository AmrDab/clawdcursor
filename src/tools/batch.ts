/**
 * Guarded action-sequence executor + the `batch` tool.
 *
 * Lets an AI driving clawdcursor over MCP submit an
 * ORDERED LIST of tool calls that run in one shot — collapsing N round-trips
 * into one — WITHOUT a code sandbox. It is DECLARATIVE on purpose:
 *
 *   - Each step is `{ name, arguments, expect? }` (`args` is accepted for
 *     `arguments`) — a normal tool call plus an
 *     optional precondition guard. No arbitrary code → no injection-as-control-
 *     flow, no element-handle staleness (every step re-queries by name), no
 *     opaque partial-execution blob.
 *   - Every step runs through the SAME `getTool().handler` execution path the MCP server uses per call, behind the
 *     same guards: the user's Stop and pause, clawdcursor's own UI, the screenshot binding — and, in the input layer
 *     below every handler, the hard key list and the AI-host guard. A batch is not a way around any of them.
 *   - Between steps the executor RE-PERCEIVES to check each step's `expect`
 *     guard; on any guard miss / refusal / step error it HALTS and returns
 *     a structured trace so the caller re-plans from real state.
 *
 * This is the "batched planning" middle path: most of Code Mode's efficiency,
 * none of the sandbox's hard problems (see the architecture review).
 */
import { getTool, getCompactTools } from './registry';
import { windowTextIncludes } from '../platform/window-text';
import type { ToolContext, ToolResult, ToolDefinition } from './types';
import { refusalBefore, afterCall, forgetScreenIfActed, guardedCall, type GuardedCall, type Refusal } from './call-guards';
import { logger } from '../core/observability/logger';
import { clipScreenText, quoteScreenText } from '../core/untrusted-screen-content';
import { actedIn, actRecord } from '../core/control';
import { effectLine } from '../core/effect';
import { compactCall } from './compact-routes';
import { classifyResult, renderResultLine, isActingAction } from '../core/result-codes';
import { sleepUnlessStopped } from '../core/control';
import { NAME_RULE, currentRoutineSession, saveRoutine, loadRoutine, listRoutines, fillVars, portableSteps, takeRecording, varsOf, type RoutineStep } from './routines';

/** Resolve a step's tool by name from EITHER surface — a granular tool
 *  (`mouse_click`, `open_app`, …) or a compound tool (`computer`, `window`, …)
 *  — so a batch works whether the caller drives the granular or 6-compound API. */
function resolveAnyTool(name: string): ToolDefinition | undefined {
  const bare = bareStepName(name);
  return getTool(bare) ?? getCompactTools().find(t => t.name === bare);
}

/** A step's tool name without the prefix the agent's host shows (`mcp__clawdcursor__accessibility`,
 *  `mcp__plugin_clawdcursor_clawdcursor__computer`): agents copy it into steps (the Mac run, 2026-11-15). Only a
 *  clawdcursor server's prefix is taken off, so another server's `computer` never runs as clawdcursor's. */
export function bareStepName(name: string): string {
  return name.replace(/^mcp__[\w-]*clawdcursor__(?=[^_])/, '');
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
  /** Alias of `arguments`. A step written
   *  with `args` used to run with no arguments at all. */
  args?: Record<string, unknown>;
  /** Optional precondition; if it fails the batch halts here and reports back. */
  expect?: BatchGuard;
  /** Alias for `expect`, and wins over it. An `expect`
   *  ASSERTION ARRAY belongs inside `arguments` instead — the core tool
   *  handlers verify it post-action. */
  precheck?: BatchGuard;
  /** Optional human label for the trace. */
  label?: string;
}

type StepStatus = 'ok' | 'guard_failed' | 'blocked' | 'error' | 'unknown_tool';

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
/** A replayed step that found nothing did nothing: safe to try again once the app has had time to show it. */
const RETRY_CODES = new Set(['NOT_FOUND', 'ELEMENT_HIDDEN']);
const RETRY_WAITS_MS = [1000, 2000];

/** A halting step's text whole, ending with the `[failed · CODE · hint · next]` line the same call made directly would have. */
function withResultLine(text: string, isError: boolean, acting: boolean): string {
  const c = classifyResult(text, isError, acting, 'mcp', acting);
  return c ? `${text}\n${renderResultLine(c)}` : text;
}

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
  /** A replay: a step that found nothing (NOT_FOUND, ELEMENT_HIDDEN) is tried again after 1 s, then 2 s: the app may still be loading. */
  opts: { retryMisses?: boolean } = {},
): Promise<BatchResult> {
  const outcomes: StepOutcome[] = [];
  let completed = 0;
  // "Act N times, then look once" in one call: the last image a step returned goes back with the trace.
  let shot: Pick<BatchResult, 'image' | 'imageStep'> = {};

  const halt = (i: number, reason: string): BatchResult =>
    ({ total: steps.length, completed, allDone: false, stoppedAt: i, stopReason: reason, steps: outcomes, ...shot });
  const block = (i: number, label: string, c: GuardedCall, r: Refusal): BatchResult => {
    logger.warn('safety.refused', { tool: c.tool, action: c.action, guard: r.guard, reason: r.why, batchStep: i });
    // The Stop and pause texts whole: they say what to do next.
    // The step that halts the batch comes back whole, with the result line a direct call would end with.
    outcomes.push({ i, label, status: 'blocked', text: withResultLine(r.why, true, false) });
    return halt(i, `step ${i + 1} (${label}): ${r.why}`);
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = labelFor(step);

    const tool: ToolDefinition | undefined = resolveAnyTool(step.name);
    if (!tool) {
      outcomes.push({ i, label, status: 'unknown_tool', text: `tool "${step.name}" is not registered` });
      return halt(i, `unknown tool "${step.name}"`);
    }

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
        return halt(i, `precondition failed at step ${i + 1} — re-plan from current state`);
      }
      // The precondition takes time (find_element: seconds) and the screen can change meanwhile: check again.
      const again = await refusalBefore(call, ctx);
      if (again) return block(i, label, call, again);
    }

    let res: ToolResult;
    const before = actedIn();
    const route = compactCall(tool.name, stepAction);
    // A read comes back whole; only an act's text is cut to a short summary.
    const acts = isActingAction(route.tool, route.action);
    const run = async (): Promise<ToolResult> => {
      try {
        return await tool.handler(args, ctx);
      } catch (e) {
        return { text: `threw: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    };
    res = await run();
    for (const wait of opts.retryMisses ? RETRY_WAITS_MS : []) {
      if (!res.isError || !RETRY_CODES.has(classifyResult(res.text || '', true, acts)?.code ?? '')) break;
      if (await sleepUnlessStopped(wait)) break;   // cut short: the user stopped clawdcursor
      res = await run();
    }
    // This step's own target (if it acted on a window at all), as the input guard verified it when the step ran.
    const target = actRecord(before);
    if (res.isError) {
      forgetScreenIfActed(call);   // the halt skips afterCall
      outcomes.push({ i, label, status: 'error', text: withResultLine(res.text || '', true, acts), pressedKeys: res.pressedKeys, ...target });
      return halt(i, `step ${i + 1} (${label}) errored`);
    }

    const after = await afterCall(call, res, ctx);
    if ('guard' in after) return block(i, label, call, after);
    // A screenshot step names its id first, so it survives the step text's truncation.
    const shotNote = after.screenshotNote ? `${after.screenshotNote.split(' — ')[0]} · ` : '';
    outcomes.push({ i, label, status: 'ok', text: `${shotNote}${acts ? clipScreenText(res.text || '', 160) : res.text || ''}`, pressedKeys: res.pressedKeys, ...target });
    if (res.image) shot = { image: res.image, imageStep: i };
    completed++;
  }

  return { total: steps.length, completed, allDone: completed === steps.length, steps: outcomes, ...shot };
}

// Step numbers in the text count from 1, as the agent counts its steps: "5/6 completed, halted at step 5" read as the fifth
// failing when the sixth had. `i`, `stoppedAt`, `imageStep` and the log's `batchStep` stay indexes.
function renderResult(r: BatchResult): string {
  const lines = r.steps.map(s => `  ${s.i + 1}. [${s.status}] ${s.label} — ${s.text}`);
  const head = r.allDone
    ? `batch: all ${r.total} steps completed.`
    : `batch: ${r.completed}/${r.total} completed, halted at step ${r.stoppedAt! + 1} — ${r.stopReason}`;
  const image = r.imageStep !== undefined ? ` The image attached is step ${r.imageStep + 1}'s.` : '';
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
        '{"name":"computer","arguments":{"action":"type","text":"hi"}}). Optional `expect` ' +
        'is a precondition checked by RE-PERCEIVING before the step runs: {"window":"notepad"} (foreground ' +
        'window must match) or {"element":"Send"} (a11y element must be present). The batch HALTS on the first ' +
        'failed precondition, refusal, or step error and returns a per-step trace so you re-plan from real ' +
        'state. A step is refused exactly as a direct call would be (the user has stopped or paused clawdcursor, a dangerous key combo, an AI assistant window in front). ' +
        'Do not batch past an irreversible step the user did not ask for: ask first with system pause_for_user. ' +
        'Routines: save_as saves a task that worked; replay runs a saved one in one call (see their parameters).',
      parameters: {
        steps: {
          type: 'array',
          required: false,
          description: 'Ordered steps to run (not with replay). Each step is a normal tool call: { "name": "<tool>", "arguments": {...}, "expect"?: {"window"?,"element"?} } ("args" is accepted for "arguments"). (A JSON-encoded string of the same array is also accepted.)',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Tool to call: "computer", "accessibility", "window", "system" or "browser".' },
              arguments: { type: 'object', description: 'Arguments for that tool, e.g. {"action":"type","text":"hi"}. May include an `expect` ASSERTION ARRAY (post-condition) — verified after the step by the tool itself.' },
              args: { type: 'object', description: 'Alias of `arguments`.' },
              expect: { type: 'object', description: 'Optional precondition re-checked by perceiving before the step: {"window":"..."} or {"element":"..."}. (`precheck` is an accepted alias.)' },
            },
            required: ['name'],
          },
        },
        maxSteps: { type: 'number', description: `Most steps one batch may hold; a longer one is refused before step 1 (default ${DEFAULT_MAX_STEPS}).`, required: false },
        save_as: { type: 'string', description: 'Save a routine under this name (letters, digits, - and _), so the next time is one call. Without steps: the calls of this session that changed something since the last save. With steps: runs them, and saves them once all ran. Put {{name}} in an argument for a value that changes between runs. The same name replaces the old one.', required: false },
        description: { type: 'string', description: 'With save_as: what the routine does and in which app, e.g. "Export the open sheet as PDF in Excel".', required: false },
        replay: { type: 'string', description: 'Run the saved routine of this name. A step whose element is not there yet is tried again; it halts at the first failure: carry on by hand from there.', required: false },
        vars: { type: 'object', description: 'With replay: a value for each {{name}} in the routine, e.g. {"to":"a@b.com"}.', required: false },
      },
      category: 'orchestration',
      safetyTier: 0, // the batch itself is inert; the pill shows when a STEP acts (batchActs).
      handler: async (params, ctx: ToolContext): Promise<ToolResult> => {
        const saveAs = typeof params.save_as === 'string' ? params.save_as.trim() : undefined;
        const replay = typeof params.replay === 'string' ? params.replay.trim() : undefined;
        // `steps: []` says no step ran (a log reader judges a batch with no step list as one that could have done anything).
        const none = (text: string): ToolResult => ({ text, isError: true, steps: [] });
        if (saveAs !== undefined && replay !== undefined) return none('batch: save_as and replay go in separate calls.');
        if (saveAs !== undefined && !NAME_RULE.test(saveAs)) {
          return none(`batch: save_as ${JSON.stringify(saveAs)} is not a routine name: use 1-60 letters, digits, - or _, starting with a letter or digit.`);
        }
        if (replay !== undefined) {
          if (params.steps !== undefined && params.steps !== null) return none('batch: replay runs the saved steps; pass no steps with it.');
          return { steps: [], ...await replayRoutine(replay, params.vars, params.maxSteps, ctx) };
        }
        if (saveAs !== undefined && (params.steps === undefined || params.steps === null)) {
          return { steps: [], ...await saveRecording(saveAs, typeof params.description === 'string' ? params.description : '', ctx) };
        }
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
        // Refused before step 1, not after twelve steps have run.
        const cap = typeof params.maxSteps === 'number' ? params.maxSteps : DEFAULT_MAX_STEPS;
        if (steps.length > cap) {
          return { text: `batch: ${steps.length} steps is over the cap of ${cap} steps per batch, so none ran. Split it into batches of at most ${cap} steps.`, isError: true };
        }
        const w0 = await window();
        const result = await executeBatch(steps, ctx);
        const effect = effectLine(w0, await window());
        let saved = '';
        if (saveAs !== undefined) {
          saved = result.allDone
            ? `\n${await saveSteps(saveAs, typeof params.description === 'string' ? params.description : '', steps.map(s => ({ name: bareStepName(s.name), arguments: stepArgs(s) })), ctx)}`
            : `\nNot saved as "${saveAs}": not every step ran.`;
        }
        return {
          text: renderResult(result) + (effect ? `\n${effect.replace(/^effect:/, 'effect (whole batch):')}` : '') + saved,
          isError: !result.allDone,
          ...(result.image ? { image: result.image } : {}),
          steps: result.steps.map(s => {
            const a = stepArgs(steps[s.i]).action;
            return { tool: bareStepName(steps[s.i].name), ...(typeof a === 'string' ? { action: a } : {}), status: s.status, text: s.text, pressedKeys: s.pressedKeys,
              ...(s.app ? { app: s.app } : {}), ...(s.appPid ? { appPid: s.appPid } : {}), ...(s.appHandle ? { appHandle: s.appHandle } : {}) };
          }),
        };
      },
    },
  ];
}

// ─── Routines (routines.ts) ──────────────────────────────────

async function saveSteps(name: string, description: string, steps: RoutineStep[], ctx: ToolContext): Promise<string> {
  const { steps: kept, notes, refused } = await portableSteps(steps, ctx.platform);
  if (refused.length) return `Not saved as "${name}": ${refused.join('; ')}.`;
  if (!kept.length) return `Not saved as "${name}": no steps.`;
  const file = saveRoutine(name, description, kept);
  const vars = varsOf(kept);
  return `Saved routine "${name}" (${kept.length} steps${vars.length ? `, vars ${vars.join(', ')}` : ''}) to ${file}. ` +
    `Next time: batch with replay "${name}"${vars.length ? ' and vars' : ''}.${notes.length ? ` Changed to replay: ${notes.join('; ')}.` : ''}`;
}

async function saveRecording(name: string, description: string, ctx: ToolContext): Promise<ToolResult> {
  const session = currentRoutineSession();
  const steps = session ? takeRecording(session) : [];
  if (!steps.length) {
    return { text: `batch: nothing to save as "${name}": no call in this session changed anything since the last save. Pass the steps to save instead.`, isError: true };
  }
  const text = await saveSteps(name, description, steps, ctx);
  const list = steps.map((s, i) => `  ${i + 1}. ${s.name}${typeof s.arguments?.action === 'string' ? `.${s.arguments.action}` : ''}`).join('\n');
  return { text: `${text}\nSteps:\n${list}\nIf a step does not belong, save again with the steps you want.`, isError: text.startsWith('Not saved') };
}

async function replayRoutine(name: string, rawVars: unknown, rawMax: unknown, ctx: ToolContext): Promise<ToolResult> {
  const routine = loadRoutine(name);
  if (!routine) {
    const known = listRoutines().map(r => r.name);
    return { text: `batch: no routine named "${name}". ${known.length ? `Saved: ${known.join(', ')}.` : 'None is saved yet.'}`, isError: true };
  }
  let vars: Record<string, unknown> = {};
  if (typeof rawVars === 'string') {
    try { vars = JSON.parse(rawVars); } catch { return { text: 'batch: `vars` must be an object.', isError: true }; }
  } else if (rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)) vars = rawVars as Record<string, unknown>;
  const filled = fillVars(routine.steps, vars);
  if ('missing' in filled) return { text: `batch: routine "${name}" needs vars ${filled.missing.join(', ')}; nothing ran.`, isError: true };
  const cap = typeof rawMax === 'number' ? rawMax : Infinity;
  if (filled.steps.length > cap) return { text: `batch: routine "${name}" has ${filled.steps.length} steps, over maxSteps ${cap}; nothing ran.`, isError: true };
  const result = await executeBatch(filled.steps, ctx, { retryMisses: true });
  const head = result.allDone
    ? `Replayed routine "${name}".`
    : `Replayed routine "${name}" up to step ${result.stoppedAt! + 1}: carry on by hand from there, then save it again if the app changed.`;
  return {
    text: `${head}\n${renderResult(result)}`,
    isError: !result.allDone,
    ...(result.image ? { image: result.image } : {}),
    steps: result.steps.map(s => {
      const a = filled.steps[s.i].arguments?.action;
      return { tool: bareStepName(filled.steps[s.i].name), ...(typeof a === 'string' ? { action: a } : {}), status: s.status, text: s.text, pressedKeys: s.pressedKeys,
        ...(s.app ? { app: s.app } : {}), ...(s.appPid ? { appPid: s.appPid } : {}), ...(s.appHandle ? { appHandle: s.appHandle } : {}) };
    }),
  };
}
