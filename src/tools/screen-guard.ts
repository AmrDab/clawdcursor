/**
 * Where screenshot binding (core/screen-binding.ts) meets the tools: which calls take a full screenshot, which are
 * image-space pointer actions, and the windows through the platform adapter. Used by the MCP wrapper and by batch
 * steps, so a batch of clicks read off one screenshot is checked step by step too.
 */
import type { ToolContext } from './types';
import { checkImagePointer, recordShot, latestShotGuardsWindows, type ShotWindow } from '../core/screen-binding';

const POINTER_ACTIONS = new Set(['click', 'double_click', 'right_click', 'middle_click', 'triple_click', 'hover', 'move',
  'scroll', 'scroll_horizontal', 'drag', 'drag_path']);
const POINTER_TOOLS = new Set(['mouse_click', 'mouse_double_click', 'mouse_right_click', 'mouse_middle_click',
  'mouse_triple_click', 'mouse_hover', 'mouse_scroll', 'mouse_scroll_horizontal', 'mouse_drag', 'mouse_drag_stepped']);
const SCREENSHOT_TOOLS = new Set(['desktop_screenshot', 'screenshot_full']);

/** A platform read is bounded: a hung bridge must not hold up a click — on timeout the window check is skipped. */
const READ_MS = 1500;
function bounded<T>(p: Promise<T> | undefined): Promise<T | null> {
  if (!p) return Promise.resolve(null);
  return Promise.race([p.catch(() => null), new Promise<null>(r => { const t = setTimeout(() => r(null), READ_MS); t.unref?.(); })]);
}

/** An image-space pointer action with coordinates (not `space:"screen"`, not one at the cursor). */
export function isImagePointerCall(tool: string, action: string | undefined, args: Record<string, unknown>): boolean {
  const pointer = tool === 'computer' ? POINTER_ACTIONS.has(action ?? '') : POINTER_TOOLS.has(tool);
  if (!pointer || args.space === 'screen') return false;
  // drag_path's `path` is a JSON string on the wire; mouse_drag also takes x1/y1/x2/y2.
  return typeof args.x === 'number' || typeof args.startX === 'number' || typeof args.x1 === 'number'
    || typeof args.path === 'string' || Array.isArray(args.path);
}

/** A full screenshot — the frame image coordinates refer to. Zoom / region crops keep the frame they came from. */
export function isFullScreenshotCall(tool: string, action: string | undefined): boolean {
  return (tool === 'computer' && action === 'screenshot') || SCREENSHOT_TOOLS.has(tool);
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
  const list = await bounded(ctx.platform?.listWindows());
  const id = recordShot((list ?? []).map(w => toShot(w as { processId?: number; title?: string; handle?: number | string })));
  const guard = latestShotGuardsWindows()
    ? 'an image-space click is refused if a window it did not show comes to the front'
    : 'the window list was unavailable, so image-space clicks from it are checked by screenshot id only';
  return `Screenshot id: ${id} — ${guard}; computer clicks may pass shot:"${id}".`;
}
