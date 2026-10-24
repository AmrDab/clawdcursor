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
 *   - Every step routes through the SAME `evaluateToolCall` safety gate and the
 *     SAME `getTool().handler` execution path the MCP server uses per call.
 *   - Between steps the executor RE-PERCEIVES to check each step's `expect`
 *     guard; on any guard miss / safety stop / step error it HALTS and returns
 *     a structured trace so the caller re-plans from real state (the morph
 *     ladder's recovery, just coarser).
 *
 * This is the "batched planning" middle path: most of Code Mode's efficiency,
 * none of the sandbox's hard problems (see the architecture review).
 */
import { getTool, getCompactTools } from './registry';
import { evaluateToolCall } from './safety-gate';
import { windowTextIncludes } from './window-text';
import type { ToolContext, ToolResult, ToolDefinition } from './types';
import { isImagePointerCall, isFullScreenshotCall, imagePointerRefusal, noteScreenshot } from './screen-guard';
import { ownUiRefusal } from '../core/own-ui-guard';
import { actsOnDesktop } from './compact';

/** Resolve a step's tool by name from EITHER surface — a granular tool
 *  (`mouse_click`, `open_app`, …) or a compound tool (`computer`, `window`, …)
 *  — so a batch works whether the caller drives the 97-tool or 6-compound API. */
function resolveAnyTool(name: string): ToolDefinition | undefined {
  return getTool(name) ?? getCompactTools().find(t => t.name === name);
}

/**
 * Whether the OPERATOR has opted into letting a batch auto-satisfy confirm-tier
 * steps. Security boundary (GHSA-3v3f-5rwv-whc9): the per-call `allowConfirm`
 * JSON field is caller-controlled — any bearer-token holder or a compromised/
 * malicious agent could set it and execute confirm-gated actions (e.g. `open_uri
 * file:` launching an arbitrary handler) that a direct tools/call would halt on.
 * The confirm tier exists precisely to require a human, and the caller IS the
 * (untrusted) agent, so caller-supplied consent is not consent. We therefore
 * only honor `allowConfirm` when the human running the daemon has enabled it
 * out-of-band via CLAWD_BATCH_ALLOW_CONFIRM=1 (or =true). Default: OFF — a batch
 * halts at a confirm step exactly like a direct call, and reports how to enable
 * it deliberately. This does not weaken the block tier (never bypassable) and
 * does not touch benign/allow-tier steps.
 */
export function batchAutoConfirmEnabled(): boolean {
  const v = (process.env.CLAWD_BATCH_ALLOW_CONFIRM || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
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

type StepStatus = 'ok' | 'guard_failed' | 'blocked' | 'needs_confirm' | 'error' | 'unknown_tool' | 'skipped';

export interface StepOutcome { i: number; label: string; status: StepStatus; text: string; }

export interface BatchResult {
  total: number;
  completed: number;
  allDone: boolean;
  stoppedAt?: number;
  stopReason?: string;
  steps: StepOutcome[];
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
        return { ok: false, detail: `foreground window is not "${guard.window}" (got: ${(r.text || '').slice(0, 90)})` };
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
 * safety stop, or step error. Reuses the real safety gate + tool handlers.
 */
export async function executeBatch(
  steps: BatchStep[],
  ctx: ToolContext,
  opts: { allowConfirm?: boolean; maxSteps?: number } = {},
): Promise<BatchResult> {
  const cap = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const outcomes: StepOutcome[] = [];
  let completed = 0;

  const halt = (i: number, reason: string): BatchResult =>
    ({ total: steps.length, completed, allDone: false, stoppedAt: i, stopReason: reason, steps: outcomes });

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
    if (guard) {
      const g = await checkGuard(guard, ctx);
      if (!g.ok) {
        outcomes.push({ i, label, status: 'guard_failed', text: `precondition failed: ${g.detail}` });
        return halt(i, `precondition failed at step ${i} — re-plan from current state`);
      }
    }

    const args = stepArgs(step);

    // Safety — identical gate to a normal tools/call (incl. el_NN → label
    // resolution via the shared holder, same as the direct MCP path).
    const safetyErr = evaluateToolCall(tool, args, { uiMaps: ctx.uiMaps });
    if (safetyErr) {
      const isConfirm = (safetyErr.text || '').includes('safety confirm');
      // `allowConfirm` is only effective when the OPERATOR enabled it out-of-band
      // (CLAWD_BATCH_ALLOW_CONFIRM=1). A caller-supplied allowConfirm alone can
      // NOT satisfy a confirm-tier step — see GHSA-3v3f-5rwv-whc9. Block tier is
      // never bypassable.
      const mayAutoConfirm = isConfirm && opts.allowConfirm && batchAutoConfirmEnabled();
      if (!mayAutoConfirm) {
        outcomes.push({ i, label, status: isConfirm ? 'needs_confirm' : 'blocked', text: safetyErr.text });
        const confirmHint = opts.allowConfirm
          ? `step ${i} needs confirmation — allowConfirm is ignored unless the operator sets CLAWD_BATCH_ALLOW_CONFIRM=1 on the daemon`
          : `step ${i} needs confirmation (a confirm-tier step cannot run in a batch unless the operator enables CLAWD_BATCH_ALLOW_CONFIRM=1 AND you pass allowConfirm:true)`;
        return halt(i, isConfirm ? confirmHint : `step ${i} blocked by safety`);
      }
    }

    const stepAction = typeof args.action === 'string' ? args.action : undefined;
    // The user's own controls are never a target, and nothing acts while a pause waits (own-ui-guard.ts).
    const ownUi = ownUiRefusal(args, actsOnDesktop(tool, stepAction));
    if (ownUi) {
      outcomes.push({ i, label, status: 'blocked', text: ownUi });
      return halt(i, `step ${i} (${label}): ${ownUi}`);
    }

    // Screenshot-bound: a later click in the batch whose screen changed under it (a dialog opened) is refused.
    if (isImagePointerCall(tool.name, stepAction, args)) {
      const why = await imagePointerRefusal(ctx, args);
      if (why) {
        outcomes.push({ i, label, status: 'error', text: why.slice(0, 200) });
        return halt(i, `step ${i} (${label}): ${why}`);
      }
    }

    // Execute via the real handler.
    let res: ToolResult;
    try {
      res = await tool.handler(args, ctx);
    } catch (e) {
      res = { text: `threw: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
    if (res.isError) {
      outcomes.push({ i, label, status: 'error', text: (res.text || '').slice(0, 200) });
      return halt(i, `step ${i} (${label}) errored`);
    }

    // A screenshot step names its id first, so it survives the step text's truncation.
    const shotNote = isFullScreenshotCall(tool.name, stepAction) ? `${(await noteScreenshot(ctx)).split(' — ')[0]} · ` : '';
    outcomes.push({ i, label, status: 'ok', text: `${shotNote}${(res.text || '').slice(0, 160)}` });
    completed++;
  }

  return { total: steps.length, completed, allDone: completed === steps.length, steps: outcomes };
}

/** Pre-flight: scan each step's safety tier WITHOUT executing. */
function dryRunScan(steps: BatchStep[]): { i: number; label: string; gate: string }[] {
  return steps.map((step, i) => {
    const label = labelFor(step);
    const tool = resolveAnyTool(step.name);
    if (!tool) return { i, label, gate: 'unknown-tool' };
    const err = evaluateToolCall(tool, stepArgs(step));
    const gate = !err ? 'allow' : (err.text.includes('safety confirm') ? 'confirm' : 'block');
    return { i, label, gate };
  });
}

function renderResult(r: BatchResult): string {
  const lines = r.steps.map(s => `  ${s.i}. [${s.status}] ${s.label} — ${s.text}`);
  const head = r.allDone
    ? `batch: all ${r.total} steps completed.`
    : `batch: ${r.completed}/${r.total} completed, halted at step ${r.stoppedAt} — ${r.stopReason}`;
  return `${head}\n${lines.join('\n')}`;
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
        'failed precondition, safety stop, or step error and returns a per-step trace so you re-plan from real ' +
        'state. Every step goes through the same safety gate as a direct call. Use `expect` to guarantee you ' +
        'act on the right window/element instead of guessing. Set dryRun:true to pre-scan safety tiers without ' +
        'executing. A confirm-tier step still HALTS the batch by default; ' +
        'allowConfirm:true only proceeds if the operator started the daemon with ' +
        'CLAWD_BATCH_ALLOW_CONFIRM=1 (otherwise it is ignored — confirm-tier stays gated).',
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
        allowConfirm: { type: 'boolean', description: 'Request that confirm-tier steps proceed. Only effective if the operator enabled CLAWD_BATCH_ALLOW_CONFIRM=1 on the daemon; otherwise ignored and the batch halts at the confirm step. Never bypasses block-tier.', required: false },
        dryRun: { type: 'boolean', description: 'Only report each step\'s safety tier; do not execute.', required: false },
        maxSteps: { type: 'number', description: `Hard cap on executed steps (default ${DEFAULT_MAX_STEPS}).`, required: false },
      },
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 0, // the batch itself is inert; each STEP is gated individually at runtime.
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

        if (params.dryRun) {
          const scan = dryRunScan(steps);
          const willStop = scan.find(s => s.gate === 'confirm' || s.gate === 'block' || s.gate === 'unknown-tool');
          return {
            text:
              `batch (dry run): ${steps.length} steps.\n` +
              scan.map(s => `  ${s.i}. [${s.gate}] ${s.label}`).join('\n') +
              (willStop
                ? `\nNote: the batch would halt at step ${willStop.i} ([${willStop.gate}]).` +
                  (willStop.gate === 'confirm'
                    ? (batchAutoConfirmEnabled()
                        ? ' Pass allowConfirm:true to proceed (operator has enabled it).'
                        : ' Confirm-tier steps cannot run in a batch on this daemon (operator has not set CLAWD_BATCH_ALLOW_CONFIRM=1).')
                    : '')
                : '\nAll steps would be allowed.'),
          };
        }

        const result = await executeBatch(steps, ctx, {
          allowConfirm: params.allowConfirm === true,
          maxSteps: typeof params.maxSteps === 'number' ? params.maxSteps : undefined,
        });
        return {
          text: renderResult(result),
          isError: !result.allDone,
          steps: result.steps.map(s => {
            const a = stepArgs(steps[s.i]).action;
            return { tool: steps[s.i].name, ...(typeof a === 'string' ? { action: a } : {}), status: s.status, text: s.text };
          }),
        };
      },
    },
  ];
}
