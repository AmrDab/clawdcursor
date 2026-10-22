/**
 * Where screenshot binding (core/screen-binding.ts) meets the tools: which calls take a full screenshot, which are
 * image-space pointer actions, and the window in front through the platform adapter. Used by the MCP wrapper and by
 * batch steps, so a batch of clicks read off one screenshot is checked step by step too.
 */
import type { ToolContext } from './types';
import { checkImagePointer, recordShot, type ShotWindow } from '../core/screen-binding';

const POINTER_ACTIONS = new Set(['click', 'double_click', 'right_click', 'middle_click', 'triple_click', 'hover', 'move',
  'scroll', 'scroll_horizontal', 'drag', 'drag_path', 'mouse_down', 'mouse_up']);
const POINTER_TOOLS = new Set(['mouse_click', 'mouse_double_click', 'mouse_right_click', 'mouse_middle_click',
  'mouse_triple_click', 'mouse_hover', 'mouse_scroll', 'mouse_scroll_horizontal', 'mouse_drag', 'mouse_drag_stepped',
  'mouse_down', 'mouse_up']);

/** An image-space pointer action with coordinates (not `space:"screen"`, not a pointer action at the cursor). */
export function isImagePointerCall(tool: string, action: string | undefined, args: Record<string, unknown>): boolean {
  const pointer = tool === 'computer' ? POINTER_ACTIONS.has(action ?? '') : POINTER_TOOLS.has(tool);
  if (!pointer || args.space === 'screen') return false;
  return typeof args.x === 'number' || typeof args.startX === 'number' || Array.isArray(args.path);
}

/** A full screenshot — the frame image coordinates refer to. Zoom / region crops keep the frame they came from. */
export function isFullScreenshotCall(tool: string, action: string | undefined): boolean {
  return (tool === 'computer' && action === 'screenshot') || tool === 'desktop_screenshot';
}

export async function frontWindow(ctx: ToolContext): Promise<ShotWindow | null> {
  try {
    const w = await ctx.platform?.getActiveWindow();
    if (!w) return null;
    const handle = (w as { handle?: number | string }).handle;
    return { processId: w.processId, title: w.title, ...(handle !== undefined ? { handle } : {}) };
  } catch {
    return null;
  }
}

/** Before an image-space pointer action: null to go ahead, or why not. */
export async function imagePointerRefusal(ctx: ToolContext, args: Record<string, unknown>): Promise<string | null> {
  return checkImagePointer(args.shot, await frontWindow(ctx));
}

/** After a full screenshot: record it and return the line naming it. */
export async function noteScreenshot(ctx: ToolContext): Promise<string> {
  const id = recordShot(await frontWindow(ctx));
  return `Screenshot id: ${id} — image-space clicks are refused once the screen behind it changes; computer clicks may pass shot:"${id}".`;
}
