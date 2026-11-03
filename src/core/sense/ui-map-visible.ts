/**
 * Make an element visible before a coordinate act. A ref's element can sit inside its window yet outside the visible part
 * of it — below the fold of a long web form, past the end of a list. Its bounds are then off the window rect, which is NOT
 * the same as being in another window: scroll it into view with the platform's own call (UIA ScrollItemPattern, AXScrollToVisible,
 * AT-SPI scroll_to), read where it is now, and act on that. Refuse only when it truly belongs to another window, when the
 * platform cannot scroll, or when the scroll did not bring it into view — and say which.
 *
 * Scrolling sends no input and never changes the foreground window, so the window binding is untouched. The safety gates
 * (own UI, the foreground guard, destructive labels) run where they always did: before the tool, and on the click after.
 */
import type { PlatformAdapter } from '../../platform/types';
import { isOwnUiPid } from '../../platform/pointer-guard';

export interface Rect { x: number; y: number; width: number; height: number }
interface Win { processId: number; title: string; bounds: Rect }

export type VisibleResult =
  | { ok: true; bounds: Rect; scrolled: boolean }
  | { ok: false; error: string };

type Scroller = Pick<PlatformAdapter, 'scrollIntoView'> & Partial<Pick<PlatformAdapter, 'listWindows'>>;

const centre = (b: Rect) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const hasPoint = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
export function rectInside(b: Rect, w: Rect): boolean {
  return b.x >= w.x && b.y >= w.y && b.x + b.width <= w.x + w.width && b.y + b.height <= w.y + w.height;
}
const fmt = (b: Rect) => `${b.x},${b.y} ${b.width}×${b.height}`;

/**
 * `target.bounds` is where the element was last seen (screen space); `win` is the active window it must be in. Resolves to
 * the bounds to act on: unchanged when the element was already inside the window, else its place after the scroll.
 */
export async function ensureVisible(
  platform: Scroller,
  target: { name?: string; controlType?: string; bounds: Rect },
  win: Win,
): Promise<VisibleResult> {
  if (rectInside(target.bounds, win.bounds)) return { ok: true, bounds: target.bounds, scrolled: false };

  // Truly another window? One of the SAME app's other windows holds the element's centre and the active window does not.
  // (A different app's window cannot hold it: the map's pid was checked against the active window's already.)
  const c = centre(target.bounds);
  if (!hasPoint(win.bounds, c)) {
    const others = (await platform.listWindows?.().catch(() => []) ?? [])
      .filter(w => w.processId === win.processId && !w.isMinimized && w.title !== win.title && w.bounds.width > 0 && hasPoint(w.bounds, c));
    if (others.length > 0) {
      return { ok: false, error: `element belongs to another window of this app ("${others[0].title}"), not the active one ("${win.title}") — focus that window and call compile_ui again` };
    }
  }

  if (isOwnUiPid(win.processId)) return { ok: false, error: 'element is in clawdcursor\'s own window — not scrolled' };
  if (!platform.scrollIntoView) {
    return { ok: false, error: 'element is outside the visible part of the window (scrolled out of view) and this platform cannot scroll it into view — scroll with computer scroll, then call compile_ui again' };
  }

  const res = await platform.scrollIntoView({ name: target.name, controlType: target.controlType, processId: win.processId, bounds: target.bounds })
    .catch((e: unknown) => ({ success: false as const, error: (e as Error)?.message }));
  if (!res.success) {
    return { ok: false, error: `element is outside the visible part of the window and could not be scrolled into view (${res.error ?? 'the platform declined'}) — scroll with computer scroll, then call compile_ui again` };
  }
  if (!res.bounds || res.bounds.width <= 0 || res.bounds.height <= 0) {
    return { ok: false, error: 'scrolled the element, but could not read where it ended up — call compile_ui again' };
  }
  if (!hasPoint(win.bounds, centre(res.bounds))) {
    return { ok: false, error: `scrolled but still not visible (the element is at ${fmt(res.bounds)}, the window is ${fmt(win.bounds)}) — scroll with computer scroll, then call compile_ui again` };
  }
  return { ok: true, bounds: res.bounds, scrolled: true };
}
