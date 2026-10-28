/**
 * Runs before every synthetic mouse press, drag or scroll.
 *
 * clawdcursor's own "desktop control in progress" pill (top centre) is a real window that takes mouse events, so an agent's
 * click under it landed on the pill instead of the app — exactly where browsers keep their tab strip and address bar
 * (live macOS run 2026-10-19: a target under the pill got 0 clicks). The banner registers a hook that hides the pill for
 * the moment of the press; the platform layer only calls it, so it does not depend on the overlay.
 */
import { AsyncLocalStorage } from 'async_hooks';

let hook: (() => Promise<void>) | null = null;

export function setBeforePointerPress(h: (() => Promise<void>) | null): void {
  hook = h;
}

/** Never throws: a failed dodge must not stop the click. */
export async function beforePointerPress(): Promise<void> {
  if (!hook) return;
  try { await hook(); } catch { /* cosmetic */ }
}

/**
 * Runs around every synthetic key, type, click, drag and scroll, in both input layers (the platform adapter and
 * NativeDesktop): core/control.ts refuses input while the user has stopped clawdcursor, or when the window in front is not
 * the one the agent was working in (#294). Unlike the hooks above it throws — a refusal sends nothing. Releases (mouseUp,
 * keyUp) are never refused: a button or key the agent holds must always be let go.
 */
/** A window the agent asked for by process, name or title. */
export interface WindowQuery { processId?: number; processName?: string; title?: string }
interface InputGuard {
  /** Throws while the user has stopped clawdcursor. */
  stopCheck(): void;
  /** Before an input: throws while stopped, or when the agent's window is no longer in front. */
  before(): Promise<void>;
  /** After an input; `movesFocus` when it could bring another window up (a click, Return, a shortcut). */
  done(movesFocus: boolean): void;
  /** The agent brought a window up on purpose: the next input binds to it. */
  focused(q: WindowQuery): void;
  /** The agent launched an app: the next input binds to its window (by pid or title), or to whatever opens when unknown. */
  launched(r?: { pid?: number; title?: string }): void;
}
let inputGuard: InputGuard | null = null;
/** Inside a guarded call ('agent': its inner steps are already covered), or clawdcursor's own housekeeping ('user'). */
const inInput = new AsyncLocalStorage<'agent' | 'user'>();

export function setInputGuard(g: InputGuard | null): void {
  inputGuard = g;
}

/** For clawdcursor's own housekeeping on the user's behalf (giving the keyboard back after a pause): not agent input. */
export function unguarded<R>(fn: () => R): R {
  return inInput.run('user', fn);
}

/** Synthetic keyboard and mouse input: refused while stopped, and when the agent's window is no longer in front. */
const INPUT_METHODS = [
  'mouseClick', 'mouseDoubleClick', 'mouseRightClick', 'mouseDrag', 'mouseScroll', 'mouseDown',
  'typeText', 'keyPress', 'keyDown', 'executeMouseAction', 'executeKeyboardAction',
];
/**
 * Acts that do not go through the window in front — by element (accessibility), on a window by handle, or in a page
 * (CDP) — still stop when the user does: a handler already running when they stop must not carry on (#294).
 */
const STOP_METHODS = [
  'invokeElement', 'setWindowState', 'setWindowBounds', 'maximizeWindow', 'restoreWindow',
  'navigate', 'click', 'clickByText', 'typeInField', 'typeByLabel', 'fillFormByLabels', 'focus', 'selectOption', 'pressKey',
];

/**
 * Route an input layer's methods through the guard: the platform adapter, NativeDesktop, the accessibility bridge and the
 * CDP driver. One check per outermost call: a method that calls another (typeText → keyPress for a paste) is one input.
 */
export function guardInputMethods<T extends object>(target: T): T {
  const t = target as unknown as Record<string, unknown>;
  // `nested`: called from inside another guarded call (a paste's keyPress, navigate raising the browser), already checked.
  type Run = (g: InputGuard, f: (...a: unknown[]) => unknown, args: unknown[], nested: boolean) => unknown;
  const wrap = (m: string, run: Run) => {
    const f = t[m];
    if (typeof f !== 'function') return;
    const bound = (...a: unknown[]) => f.apply(target, a);
    t[m] = (...args: unknown[]) => {
      const store = inInput.getStore();
      if (!inputGuard || store === 'user') return bound(...args);
      if (store === 'agent') return run(inputGuard, bound, args, true);
      const g = inputGuard;
      return inInput.run('agent', () => run(g, bound, args, false));
    };
  };
  for (const m of INPUT_METHODS) {
    wrap(m, async (g, f, args, nested) => {
      if (nested) return f(...args);
      await g.before();
      const r = await f(...args);
      g.done(movesFocus(m, args));
      return r;
    });
  }
  for (const m of STOP_METHODS) wrap(m, async (g, f, args, nested) => { if (!nested) g.stopCheck(); return f(...args); });
  // The agent's own focus and launches rebind the window it works in, nested or not (a navigate raises its browser).
  // The platform adapter takes a query and answers true/false; the accessibility bridge takes (title, processId) and
  // answers {success}.
  wrap('focusWindow', async (g, f, args, nested) => {
    if (!nested) g.stopCheck();
    const r = await f(...args) as boolean | { success?: boolean } | undefined;
    const q: WindowQuery = typeof args[0] === 'object' && args[0] !== null
      ? args[0] as WindowQuery
      : { title: args[0] as string | undefined, processId: args[1] as number | undefined };
    if (r === true || (typeof r === 'object' && r?.success)) g.focused(q);
    return r;
  });
  // A launch types into the Start menu / Spotlight itself: its own keys run inside this one guarded call.
  for (const m of ['openApp', 'launchApp']) {
    wrap(m, async (g, f, args, nested) => {
      if (!nested) g.stopCheck();
      const r = await f(...args) as { pid?: number; title?: string } | undefined;
      g.launched(r);
      return r;
    });
  }
  return target;
}

/**
 * Could this input bring ANOTHER APP's window to the front? A press of the pointer; Return or Escape; switching apps
 * (alt/cmd+tab); the system launcher (the Windows key, Win+R, cmd+space); typed text ending in a newline. Not plain typing,
 * scrolling, or a shortcut such as ctrl+l / ctrl+t / cmd+n, which opens a window in the same app — no new process to excuse.
 */
function movesFocus(method: string, args: unknown[]): boolean {
  if (method === 'typeText') return /\r?\n$/.test(String(args[0] ?? ''));
  if (method === 'mouseScroll') return false;
  if (method === 'keyPress' || method === 'keyDown') {
    const k = String(args[0] ?? '').toLowerCase().replace(/\s+/g, '');
    return /(^|\+)(return|enter|escape|esc)$/.test(k)
      || /(alt|cmd|command|super|win|meta)\+(shift\+)?tab$/.test(k)
      || /^(super|win|meta)(\+|$)/.test(k)
      || /^(cmd|command|mod|super)\+space$/.test(k);
  }
  return true;  // clicks, drags, a held button, the composite execute* actions
}

/**
 * Runs before every screen capture (screenshot, OCR). The pill and glow are for the person at the screen, never part of
 * what the agent sees: where the OS can exclude a window from capture (Windows, macOS) the overlay does so itself, and
 * the banner registers no hook; elsewhere (Linux) the hook hides the pill for the moment of the capture.
 */
let captureHook: (() => Promise<void>) | null = null;

export function setBeforeCapture(h: (() => Promise<void>) | null): void {
  captureHook = h;
}

/** Never throws: a failed hide must not stop the capture. */
export async function beforeCapture(): Promise<void> {
  if (!captureHook) return;
  try { await captureHook(); } catch { /* cosmetic */ }
}

/**
 * clawdcursor's own overlay processes (the pill, the glow) are the user's: never a window or app that a lookup by name, title
 * or pid resolves to. Window lookups match process names by substring, and on Windows and Linux the overlay runs under a
 * shared interpreter (powershell, python3), so `focus {processName:"powershell"}` could land on the pill. The banner
 * registers its live pids; the platform layer filters them out of its window and app lists.
 */
let ownUiPids: () => readonly number[] = () => [];

export function setOwnUiPids(f: () => readonly number[]): void {
  ownUiPids = f;
}

export function isOwnUiPid(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { return ownUiPids().includes(pid); } catch { return false; }
}
