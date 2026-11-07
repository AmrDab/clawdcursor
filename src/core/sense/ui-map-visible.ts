/**
 * Make an element visible before a coordinate act. A ref's element can sit inside its window yet outside the visible part
 * of it — below the fold of a long web form, past the end of a list. Its bounds are then off the window rect, which is NOT
 * the same as being in another window: scroll it into view with the platform's own call (UIA ScrollItemPattern, AXScrollToVisible,
 * AT-SPI scroll_to), read where it is now, and act on that. Refuse only when it truly belongs to another window, when the
 * platform cannot scroll, or when the scroll did not bring it into view — and say which.
 *
 * Scrolling sends no input and must not change the foreground window, so the window binding is untouched: the active window
 * is read again after the scroll and the act is refused if its handle, title or bounds differ. The platform finds the element
 * by name and last-seen bounds and refuses an ambiguous one; this module then checks the element it scrolled IS the one
 * referenced (name, role, size) — one check for every caller. The safety gates (own UI, the foreground guard, destructive
 * labels) run where they always did: before the tool, and on the click after.
 *
 * Names, titles and platform messages are screen content: they enter error text wrapped, never bare.
 */
import type { PlatformAdapter } from '../../platform/types';
import { isOwnUiPid } from '../../platform/pointer-guard';
import { wrapUntrustedScreenContent } from '../untrusted-screen-content';

export interface Rect { x: number; y: number; width: number; height: number }
interface Win { processId: number; title: string; bounds: Rect; handle?: number | string }

export type VisibleResult =
  | { ok: true; bounds: Rect; scrolled: boolean }
  | { ok: false; error: string };

type Scroller = Pick<PlatformAdapter, 'scrollIntoView' | 'getActiveWindow'> & Partial<Pick<PlatformAdapter, 'listWindows'>>;

const centre = (b: Rect) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const hasPoint = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
export function rectInside(b: Rect, w: Rect): boolean {
  return b.x >= w.x && b.y >= w.y && b.x + b.width <= w.x + w.width && b.y + b.height <= w.y + w.height;
}
const fmt = (b: Rect) => `${b.x},${b.y} ${b.width}×${b.height}`;
/** The same window: by handle when both sides have one, else by title. */
const sameWindow = (a: { handle?: number | string; title: string }, b: { handle?: number | string; title: string }) =>
  a.handle !== undefined && b.handle !== undefined ? String(a.handle) === String(b.handle) : a.title === b.title;
const sameRect =(a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Screen content (a title, an element name, a platform message) inside error text: one capped line, in the untrusted block. */
export function untrusted(s: unknown): string {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return wrapUntrustedScreenContent(one.length > 100 ? `${one.slice(0, 99)}…` : one);
}

const norm = (s: string) => s.replace(/&/g, '').replace(/\s+/g, ' ').trim().replace(/[:：]$/, '').trim().toLowerCase();
/** The kinds of role a UIMap role may be reported as by UIA ("ControlType.Edit"), AX ("AXTextField") or AT-SPI ("entry"). Others: unchecked. */
const ROLE_FAMILY: Record<string, RegExp> = {
  input: /edit|text ?(field|area|box|view|entry)|^text$|entry|combo|search|password|document|spin|slider/i,
  button: /button|menu ?item|hyperlink|link/i,
  link: /link|hyperlink|button/i,
  checkbox: /check|radio|toggle|switch|button/i,
  listitem: /list ?item|row|cell|item|option/i,
  tab: /tab/i,
};
const SIZE_SLACK = (n: number) => Math.max(8, n * 0.15);

/**
 * `target.bounds` is where the element was last seen (screen space), `target.role` its UIMap role, `win` the active window it
 * must be in. Resolves to the bounds to act on: unchanged when the element was already inside the window, else its place
 * after the scroll.
 */
export async function ensureVisible(
  platform: Scroller,
  target: { name?: string; role?: string; bounds: Rect },
  win: Win,
  holder?: { invalidate(): void },
): Promise<VisibleResult> {
  if (rectInside(target.bounds, win.bounds)) return { ok: true, bounds: target.bounds, scrolled: false };

  // Truly another window? One of the SAME app's other windows holds the element's centre and the active window does not.
  // (A different app's window cannot hold it: the map's pid was checked against the active window's already.)
  const c = centre(target.bounds);
  if (!hasPoint(win.bounds, c)) {
    const others = (await platform.listWindows?.().catch(() => []) ?? [])
      .filter(w => w.processId === win.processId && !w.isMinimized && w.bounds.width > 0 && hasPoint(w.bounds, c)
        && !sameWindow(w, win));
    if (others.length > 0) {
      return { ok: false, error: `element belongs to another window of this app (${untrusted(others[0].title)}), not the active one (${untrusted(win.title)}) — focus that window and call compile_ui again` };
    }
  }

  if (isOwnUiPid(win.processId)) return { ok: false, error: 'element is in clawdcursor\'s own window — not scrolled' };
  if (!platform.scrollIntoView) {
    return { ok: false, error: 'element is outside the visible part of the window (scrolled out of view) and this platform cannot scroll it into view — scroll with computer scroll, then call compile_ui again' };
  }

  const res = await platform.scrollIntoView({
    name: target.name, processId: win.processId,
    ...(win.handle !== undefined ? { windowHandle: win.handle } : {}), bounds: target.bounds,
  }).catch((e: unknown) => ({ success: false as const, error: (e as Error)?.message }));
  // The scroll ran (or may have, partly): every other ref in the snapshot now points at where things WERE. Whatever the
  // verdict below, none of them may be used — the next one must be compiled afresh.
  holder?.invalidate();

  // Scrolling must not move the window binding: look again, whatever the platform said.
  const after = await platform.getActiveWindow().catch(() => null);
  if (!after || after.processId !== win.processId || after.title !== win.title
      || (win.handle !== undefined && after.handle !== undefined && String(after.handle) !== String(win.handle))
      || !sameRect(after.bounds, win.bounds)) {
    return { ok: false, error: `the active window changed while scrolling (was ${untrusted(win.title)}, now ${untrusted(after?.title ?? 'none')}) — nothing was done; call compile_ui again` };
  }

  if (!res.success) {
    return { ok: false, error: `element is outside the visible part of the window and could not be scrolled into view (${untrusted(res.error ?? 'the platform declined')}) — scroll with computer scroll, then call compile_ui again` };
  }
  if (!res.bounds || res.bounds.width <= 0 || res.bounds.height <= 0) {
    return { ok: false, error: 'scrolled the element, but could not read where it ended up — call compile_ui again' };
  }

  // Is what moved the element that was referenced? Same name, a role of the same kind, about the same size.
  const got = 'name' in res || 'role' in res ? res as { name?: string; role?: string } : {};
  if (target.name && got.name !== undefined && got.name.trim() !== '' && norm(got.name) !== norm(target.name)) {
    return { ok: false, error: `scrolled a different element (${untrusted(got.name)}) than the one referenced (${untrusted(target.name)}) — nothing was done; call compile_ui again` };
  }
  const family = target.role ? ROLE_FAMILY[target.role] : undefined;
  if (family && got.role && !family.test(got.role)) {
    return { ok: false, error: `scrolled a different element (role ${untrusted(got.role)}) than the one referenced (${untrusted(target.role)}) — nothing was done; call compile_ui again` };
  }
  if (Math.abs(res.bounds.width - target.bounds.width) > SIZE_SLACK(target.bounds.width)
      || Math.abs(res.bounds.height - target.bounds.height) > SIZE_SLACK(target.bounds.height)) {
    return { ok: false, error: `scrolled an element of a different size (${fmt(res.bounds)}, the referenced one was ${target.bounds.width}×${target.bounds.height}) — nothing was done; call compile_ui again` };
  }

  if (!hasPoint(win.bounds, centre(res.bounds))) {
    return { ok: false, error: `scrolled but still not visible (the element is at ${fmt(res.bounds)}, the window is ${fmt(win.bounds)}) — scroll with computer scroll, then call compile_ui again` };
  }
  return { ok: true, bounds: res.bounds, scrolled: true };
}
