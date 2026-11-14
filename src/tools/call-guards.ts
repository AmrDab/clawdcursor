/**
 * The checks every tool call passes, in one order, whether the MCP server received it or it is a step of a batch.
 *
 * Before it runs: the user's Stop first (an agent told "no screenshot taken" would never learn the user took control
 * back), then a screenshot-bound pointer call whose screen has changed since (screen-binding.ts), then clawdcursor's own
 * on-screen controls and a pending pause (own-ui-guard.ts) — last, so a pause that came up during the checks above still
 * stops the call. After it ran: the OCR cache is emptied if the call acted, then high-security mode's no-image rule, then
 * the record of a full screenshot the model has seen.
 */
import type { ToolContext, ToolResult } from './types';
import { isImagePointerCall, isFullScreenshotCall, imagePointerRefusal, noteScreenshot, VISION_DISABLED_REFUSAL } from './screen-guard';
import { ownUiRefusal, isPauseSafeCall, isStopSafeCall } from '../core/own-ui-guard';
import { compactCall } from './compact';
import { isStopped, STOPPED_TEXT } from '../core/control';
import { isActingAction } from '../core/result-codes';
import { ocrEngine } from '../platform/ocr-engine';

export interface Refusal { guard: 'stopped' | 'screen_binding' | 'own_ui' | 'no_vision'; why: string }

export interface GuardedCall {
  tool: string;
  action: string | undefined;
  args: Record<string, unknown>;
  /** Allowed while a pause waits / while the user has stopped clawdcursor (own-ui-guard.ts). */
  pauseSafe: boolean;
  stopSafe: boolean;
}

/**
 * A call as the guards see it. Allowed while paused / stopped by its compact name; never a batch step with a
 * precondition, which reads the screen.
 */
export function guardedCall(tool: string, action: string | undefined, args: Record<string, unknown>, precondition = false): GuardedCall {
  const c = compactCall(tool, action);
  return {
    tool, action, args,
    pauseSafe: !precondition && isPauseSafeCall(c.tool, c.action), stopSafe: !precondition && isStopSafeCall(c.tool, c.action),
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
  const ownUi = ownUiRefusal(c.args, c.pauseSafe, c.stopSafe);
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
