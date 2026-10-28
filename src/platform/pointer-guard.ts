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
interface InputGuard { before(): Promise<void>; after(): Promise<void>; rebind(): void }
let inputGuard: InputGuard | null = null;
const inInput = new AsyncLocalStorage<true>();

export function setInputGuard(g: InputGuard | null): void {
  inputGuard = g;
}

const INPUT_METHODS = [
  'mouseClick', 'mouseDoubleClick', 'mouseRightClick', 'mouseDrag', 'mouseScroll', 'mouseDown',
  'typeText', 'keyPress', 'keyDown', 'executeMouseAction', 'executeKeyboardAction',
];

/**
 * Route an input layer's methods through the guard. One check per outermost call: a method that calls another
 * (typeText → keyPress for a paste) is one input. focusWindow binds the agent to the window it brought up; openApp leaves
 * the next input to bind to whatever opens.
 */
export function guardInputMethods<T extends object>(target: T): T {
  const t = target as unknown as Record<string, unknown>;
  for (const m of INPUT_METHODS) {
    const f = t[m];
    if (typeof f !== 'function') continue;
    t[m] = (...args: unknown[]) => {
      if (!inputGuard || inInput.getStore()) return f.apply(target, args);
      const g = inputGuard;
      return inInput.run(true, async () => {
        await g.before();
        const r = await f.apply(target, args);
        await g.after();
        return r;
      });
    };
  }
  const focus = t.focusWindow;
  if (typeof focus === 'function') {
    t.focusWindow = async (...args: unknown[]) => {
      const ok = await focus.apply(target, args);
      if (ok && inputGuard) await inputGuard.after();
      return ok;
    };
  }
  const open = t.openApp;
  if (typeof open === 'function') {
    t.openApp = async (...args: unknown[]) => {
      const r = await open.apply(target, args);
      inputGuard?.rebind();
      return r;
    };
  }
  return target;
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
