/**
 * The guards every tool call passes, direct or as a batch step, in one place: the screenshot binding (screen-guard),
 * clawdcursor's own UI and the user's stop and pause (own-ui-guard), and the order they run in (call-guards).
 */

import type { ToolContext, ToolResult } from './types';
import { checkImagePointer, recordShot, latestShotGuardsWindows, type ShotWindow } from '../core/screen-binding';
import { compactCall } from './compact-routes';
import { controlBanner } from '../core/banner';
import { pauseGate } from '../core/pause-gate';
import { foreignOverlayState } from '../core/overlay-state';
import { isStopped, STOPPED_TEXT } from '../core/control';
import { isActingAction } from '../core/result-codes';
import { ocrEngine } from '../platform/ocr-engine';

// ─── screen-guard ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where screenshot binding (core/screen-binding.ts) meets the tools: which calls take a full screenshot, which are
 * image-space pointer actions, and the windows through the platform adapter. Used by the MCP wrapper and by batch
 * steps, so a batch of clicks read off one screenshot is checked step by step too.
 */
/** `computer` actions that point at coordinates; a granular tool is one when its route is (compactCall). */
const POINTER_ACTIONS = new Set(['click', 'double_click', 'right_click', 'middle_click', 'triple_click', 'hover', 'move', 'mouse_move',
  'scroll', 'scroll_horizontal', 'drag', 'drag_path']);

/** A platform read is bounded: a hung bridge must not hold up a click — on timeout the window check is skipped. */
const READ_MS = 1500;
function bounded<T>(p: Promise<T> | undefined): Promise<T | null> {
  if (!p) return Promise.resolve(null);
  return Promise.race([p.catch(() => null), new Promise<null>(r => { const t = setTimeout(() => r(null), READ_MS); t.unref?.(); })]);
}

/** An image-space pointer action with coordinates (not `space:"screen"`, not one at the cursor). */
export function isImagePointerCall(tool: string, action: string | undefined, args: Record<string, unknown>): boolean {
  const c = compactCall(tool, action);
  const pointer = c.tool === 'computer' && POINTER_ACTIONS.has(c.action ?? '');
  if (!pointer || args.space === 'screen') return false;
  // drag_path's `path` is a JSON string on the wire; mouse_drag also takes x1/y1/x2/y2; compact.ts turns computer-use's
  // `coordinate:[x,y]` into x/y after the guards, so it is checked here as x/y would be.
  return typeof args.x === 'number' || typeof args.startX === 'number' || typeof args.x1 === 'number'
    || typeof args.path === 'string' || Array.isArray(args.path) || Array.isArray(args.coordinate);
}

/** High-security mode (ctx.disableVision): why a call that returned an image is refused — a direct call or a batch step. */
export const VISION_DISABLED_REFUSAL = 'vision is disabled on this server (--no-vision / CLAWD_DISABLE_VISION), so no ' +
  'screenshot is sent to the model. Read the screen without one: the accessibility tree, or OCR text.';

/**
 * A full screenshot — the frame image coordinates refer to: `computer screenshot` (desktop_screenshot), or screenshot_full,
 * which no compound routes to. Zoom / region crops keep the frame they came from.
 */
export function isFullScreenshotCall(tool: string, action: string | undefined): boolean {
  const c = compactCall(tool, action);
  return (c.tool === 'computer' && c.action === 'screenshot') || tool === 'screenshot_full';
}

const toShot = (w: { processId?: number; title?: string; handle?: number | string }): ShotWindow =>
  ({ processId: w.processId, title: w.title, ...(w.handle !== undefined ? { handle: w.handle } : {}) });

export async function frontWindow(ctx: ToolContext): Promise<ShotWindow | null> {
  const w = await bounded(ctx.platform?.getActiveWindow());
  return w ? toShot(w as { processId?: number; title?: string; handle?: number | string }) : null;
}

/** Before an image-space pointer action: null to go ahead, or why not. */
export async function imagePointerRefusal(ctx: ToolContext, args: Record<string, unknown>): Promise<string | null> {
  return checkImagePointer(args.shot, await frontWindow(ctx));
}

/** After a full screenshot: record it with the windows that exist now, and return the line naming it. */
export async function noteScreenshot(ctx: ToolContext): Promise<string> {
  // The window in front at capture is on the screenshot too: an untitled one (frameless app, picture-in-picture) is
  // never in a window list, and without it every click on it would be refused, screenshot after screenshot.
  const [list, front] = await Promise.all([bounded(ctx.platform?.listWindows()), frontWindow(ctx)]);
  const windows = (list ?? []).map(w => toShot(w as { processId?: number; title?: string; handle?: number | string }));
  if (front && windows.length > 0) windows.push(front);
  const id = recordShot(windows);
  const guard = latestShotGuardsWindows()
    ? 'an image-space click is refused if a window it did not show comes to the front'
    : 'the window list was unavailable, so image-space clicks from it are checked by screenshot id only';
  return `Screenshot id: ${id} — ${guard}; computer clicks may pass shot:"${id}".`;
}

// ─── own-ui-guard ────────────────────────────────────────────────────────────────────────────────────────

/**
 * clawdcursor's own on-screen controls (the pill, its pause prompt, the window outline) are the USER's: the agent never reads,
 * presses or types into them. Found live on macOS (2026-10-24): `accessibility read_tree {processId:<overlay pid>}` returned
 * the pill's tree, the pause prompt's Resume button was findable and invokable by name — faking the user's answer — and
 * nothing stopped an agent from acting while a pause waited.
 *
 * One check, called before every tool runs (MCP wrapper, batch executor):
 *  - while the user has stopped clawdcursor (control.ts), every call is refused except asking them for control back;
 *  - a call aimed at an overlay process (by pid, or by the overlay's process name) is refused;
 *  - while a pause is pending, EVERY call is refused except the few that wait on, end or report it. Deny by default: the
 *    pause prompt's buttons and reply box exist only while paused, and the reply box takes the keyboard and the foreground
 *    then (on every OS), so any read with no target, any key, click or script could reach it. Nothing else needs doing
 *    while the user has the screen.
 */
const PID_ARGS = ['processId', 'pid', 'process_id'];
const READ_ARGS = ['expect', 'assertions'];
const NAME_ARGS = ['processName', 'process_name', 'app', 'appName'];
/** The macOS overlay's process name (cached as clawd-overlay-<hash>). On Windows and Linux it runs under a shared interpreter. */
const OVERLAY_NAME = /^clawd-overlay(-[0-9a-f]+)?$/i;

/**
 * Calls that wait on, end or report a pause, in compact names (`tool:action`, or a granular tool no compound routes to);
 * a granular call counts as its route (tools/compact-routes.ts compactCall). `resume` is recorded as unverified — it cannot
 * pass for the user's answer.
 */
const PAUSE_SAFE = new Set([
  'system:pause_for_user', 'resume_task',
  // Waiting and reporting touch nothing on screen.
  'computer:wait', 'system:report',
  // Turning off error reports touches nothing on screen either.
  'system:telemetry_optout',
]);

/** `tool` / `action` in compact names (tools/compact-routes.ts compactCall). */
export function isPauseSafeCall(toolName: string, action?: string): boolean {
  return PAUSE_SAFE.has(action ? `${toolName}:${action}` : toolName);
}

/** While the user has stopped clawdcursor: only asking them for control back, and reporting. Not even waiting or reading. */
const STOP_SAFE = new Set(['system:pause_for_user', 'system:report', 'system:telemetry_optout']);

/** `tool` / `action` in compact names (tools/compact-routes.ts compactCall). */
export function isStopSafeCall(toolName: string, action?: string): boolean {
  return STOP_SAFE.has(action ? `${toolName}:${action}` : toolName);
}

const OWN = (what: string) => `${what} is clawdcursor's own on-screen control — it is the user's, never read or acted on. Target the app instead.`;

/**
 * `acts`: the call sends real input or changes a window (result-codes.ts isActingAction). Another clawdcursor process's pause
 * stops those only: this process's agent can still read, and a card its own asker abandoned never locks the reads out.
 */
export function ownUiRefusal(args: Record<string, unknown> | undefined, pauseSafe: boolean, stopSafe = false, acts = true): string | null {
  // The user stopped clawdcursor (control.ts): nothing runs until they give control back.
  if (!stopSafe && isStopped()) return STOPPED_TEXT;
  // This process's overlay, and every other live clawdcursor process's (a daemon's pause is the user's to a stdio server too).
  const foreign = foreignOverlayState();
  const pids = [...controlBanner.overlayPids(), ...foreign.pids];
  for (const k of PID_ARGS) {
    const v = Number(args?.[k]);
    if (Number.isInteger(v) && pids.includes(v)) return OWN(`pid ${v}`);
  }
  for (const k of NAME_ARGS) {
    const v = args?.[k];
    if (typeof v === 'string' && OVERLAY_NAME.test(v.trim())) return OWN(`"${v.trim()}"`);
  }
  // An `expect` (the post-check) or `verify`'s `assertions` make any call a screen read — OCR, element reads — so never pause-safe.
  const safe = pauseSafe && READ_ARGS.every(k => args?.[k] === undefined || args?.[k] === null);
  if (!safe && (pauseGate.current() || (foreign.paused && acts))) {
    const whose = !pauseGate.current() && foreign.pausedBy ? ` (shown by clawdcursor process ${foreign.pausedBy})` : '';
    return `paused — a pause is waiting for the user on screen${whose}, and nothing runs until they answer it. Keep waiting; do not read, press, type or click.`;
  }
  return null;
}

// ─── call-guards ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The checks every tool call passes, in one order, whether the MCP server received it or it is a step of a batch.
 *
 * Before it runs: the user's Stop first (an agent told "no screenshot taken" would never learn the user took control
 * back), then a screenshot-bound pointer call whose screen has changed since (screen-binding.ts), then clawdcursor's own
 * on-screen controls and a pending pause (call-guards.ts) — last, so a pause that came up during the checks above still
 * stops the call. After it ran: the OCR cache is emptied if the call acted, then high-security mode's no-image rule, then
 * the record of a full screenshot the model has seen.
 */
export interface Refusal { guard: 'stopped' | 'screen_binding' | 'own_ui' | 'no_vision'; why: string }

export interface GuardedCall {
  tool: string;
  action: string | undefined;
  args: Record<string, unknown>;
  /** Allowed while a pause waits / while the user has stopped clawdcursor (call-guards.ts). */
  pauseSafe: boolean;
  stopSafe: boolean;
  /** Sends input or changes a window: another process's pause card holds these, and only these (call-guards.ts). */
  acts: boolean;
}

/**
 * Under another process's pause card these act too, though no outcome line counts them: a pointer move (it moves the user's
 * cursor), a page script (it can click and type in the page) and a browser connect (it can start a browser).
 */
const ALSO_ACTS = new Set(['computer.hover', 'computer.move', 'computer.mouse_move', 'computer.move_relative', 'browser.evaluate', 'browser.connect']);

/**
 * A call as the guards see it. Allowed while paused / stopped by its compact name; never a batch step with a
 * precondition, which reads the screen.
 */
export function guardedCall(tool: string, action: string | undefined, args: Record<string, unknown>, precondition = false): GuardedCall {
  const c = compactCall(tool, action);
  return {
    tool, action, args,
    pauseSafe: !precondition && isPauseSafeCall(c.tool, c.action), stopSafe: !precondition && isStopSafeCall(c.tool, c.action),
    acts: isActingAction(c.tool, c.action) || ALSO_ACTS.has(`${c.tool}.${c.action}`),
  };
}

/** Why the call may not run, or null. `passedStop` runs once the call is known not to be stopped (the MCP server shows the pill there). */
export async function refusalBefore(c: GuardedCall, ctx: ToolContext, passedStop?: () => void): Promise<Refusal | null> {
  if (!c.stopSafe && isStopped()) return { guard: 'stopped', why: STOPPED_TEXT };
  passedStop?.();
  if (isImagePointerCall(c.tool, c.action, c.args)) {
    const why = await imagePointerRefusal(ctx, c.args);
    if (why) return { guard: 'screen_binding', why };
  }
  const ownUi = ownUiRefusal(c.args, c.pauseSafe, c.stopSafe, c.acts);
  return ownUi ? { guard: 'own_ui', why: ownUi } : null;
}

/**
 * A call that acts may have changed the screen: empty the OCR cache. Input empties it in the input layer; an act done by
 * starting a process (open_url, open_app's fallbacks, relaunch_with_cdp) sends no input, and neither does cdp_connect,
 * which can launch a browser window (it is no acting call for the outcome line: it changes no page). Also after a call
 * that failed or threw: a failed launch can still have opened a window.
 */
export function forgetScreenIfActed(c: GuardedCall): void {
  const cc = compactCall(c.tool, c.action);
  if (isActingAction(cc.tool, cc.action) || (cc.tool === 'browser' && cc.action === 'connect')) ocrEngine().invalidateCache();
}

/** After the call: refused when it returned an image with vision off, else the line naming a full screenshot (null for any other call). */
export async function afterCall(c: GuardedCall, result: ToolResult, ctx: ToolContext): Promise<Refusal | { screenshotNote: string | null }> {
  forgetScreenIfActed(c);
  if (ctx.disableVision && result.image) return { guard: 'no_vision', why: VISION_DISABLED_REFUSAL };
  return { screenshotNote: !result.isError && isFullScreenshotCall(c.tool, c.action) ? await noteScreenshot(ctx) : null };
}
