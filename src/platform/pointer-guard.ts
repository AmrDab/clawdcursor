/**
 * Runs before every synthetic mouse press, drag or scroll.
 *
 * clawdcursor's own "desktop control in progress" pill (top centre) is a real window that takes mouse events, so an agent's
 * click under it landed on the pill instead of the app — exactly where browsers keep their tab strip and address bar
 * (live macOS run 2026-10-19: a target under the pill got 0 clicks). The banner registers a hook that hides the pill for
 * the moment of the press; the platform layer only calls it, so it does not depend on the overlay.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { hardKeyRefusal, keysOf } from './hard-keys';
import { fenceActive, fencePointer } from '../core/fence';

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
  focused(q: WindowQuery): Promise<void>;
  /** The agent launched an app: the next input binds to its window (by pid or title), or to whatever opens when unknown. */
  launched(r?: { pid?: number; title?: string }, appName?: string): Promise<void>;
  /** Before an act on an element by name: stopped, or the window it would resolve to is an AI assistant nobody chose. */
  byName(processId?: number): Promise<void>;
  /** An act went to this process, not to the window in front (a page act over CDP): the session log names its app (#365). */
  byProcess?(pid: number | null | undefined): Promise<void>;
}
let inputGuard: InputGuard | null = null;
/** Inside a guarded call ('agent': its inner steps are already covered), or clawdcursor's own housekeeping ('user'). */
const inInput = new AsyncLocalStorage<'agent' | 'user'>();

export function setInputGuard(g: InputGuard | null): void {
  inputGuard = g;
}

/** Told which guarded method the agent is about to run (once it passed the guard): the pill says what is happening. */
let onAgentInput: ((method: string) => void) | null = null;
export function setOnAgentInput(f: ((method: string) => void) | null): void {
  onAgentInput = f;
}
const announce = (m: string) => { try { onAgentInput?.(m); } catch { /* cosmetic */ } };

/** For clawdcursor's own housekeeping on the user's behalf (giving the keyboard back after a pause): not agent input. */
export function unguarded<R>(fn: () => R): R {
  return inInput.run('user', fn);
}

/**
 * Run `send` as ONE guarded input: the checks a direct keyPress gets (stop, clawdcursor's own control, the window the agent works
 * in). For an accessibility action that has to finish with a key - a web <summary> opens on Return - which runs inside an
 * already guarded invokeElement, whose nested calls are not checked again (below). Passes straight through where no guard is set.
 */
export async function guardedInput<R>(method: string, args: unknown[], send: () => Promise<R>): Promise<R> {
  const g = inputGuard;
  if (!g || inInput.getStore() === 'user') return send();
  await g.before();
  announce(method);
  const r = await send();
  g.done(movesFocus(method, args));
  return r;
}

/** Synthetic keyboard and mouse input: refused while stopped, and when the agent's window is no longer in front. */
const INPUT_METHODS = [
  'mouseClick', 'mouseDoubleClick', 'mouseRightClick', 'mouseDrag', 'mouseScroll', 'mouseDown',
  'typeText', 'keyPress', 'keyDown', 'executeMouseAction', 'executeKeyboardAction',
];
/**
 * Acts that do not go through the window in front — by element (accessibility), on a window by handle, or in a page
 * (CDP) — still stop when the user does: a handler already running when they stop must not carry on (#294).
 * mouseMove (hover opens menus), writeClipboard, evaluate (any page script) and switchTab act too (audit 2026-11-05).
 * Putting the user's own clipboard back after a paste is not agent input: those restores run unguarded().
 */
const STOP_METHODS = [
  'invokeElement', 'scrollIntoView', 'setWindowState', 'setWindowBounds', 'maximizeWindow', 'restoreWindow',
  'navigate', 'click', 'clickByText', 'typeInField', 'typeByLabel', 'fillFormByLabels', 'focus', 'selectOption', 'pressKey',
  'mouseMove', 'writeClipboard', 'evaluate', 'switchTab',
];

/**
 * Route an input layer's methods through the guard: the platform adapter, NativeDesktop, the accessibility bridge and the
 * CDP driver. One check per outermost call: a method that calls another (typeText → keyPress for a paste) is one input.
 */
export function guardInputMethods<T extends object>(target: T, actedPid?: () => Promise<number | null>): T {
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
      // Under the test fence, text with Enter or Tab is sent a piece at a time: either key can move the focus to another
      // window, and the foreground is checked again before the next piece goes out.
      if (m === 'typeText' && fenceActive() && /[\r\n\t]/.test(String(args[0] ?? ''))) {
        let last: unknown;
        for (const piece of String(args[0]).match(/[^\r\n\t]*(?:\r\n|[\r\n\t])|[^\r\n\t]+$/g) ?? []) {
          await g.before();
          announce(m);
          last = await f(piece, ...args.slice(1));
          g.done(movesFocus(m, [piece]));
        }
        return last;
      }
      await g.before();
      announce(m);
      const r = await f(...args);
      g.done(movesFocus(m, args));
      return r;
    });
  }
  // By-name acts on the window in front are checked like input; reading a value is not an act.
  wrap('invokeElement', async (g, f, args, nested) => {
    const q = (args[0] ?? {}) as { processId?: number; action?: string };
    if (!nested) {
      if (q.action === 'get-value') g.stopCheck(); else await g.byName(q.processId);
      announce('invokeElement');
    }
    return f(...args);
  });
  for (const m of STOP_METHODS.filter(m => m !== 'invokeElement')) {
    wrap(m, async (g, f, args, nested) => {
      if (nested) return f(...args);
      g.stopCheck();
      announce(m);
      // `actedPid`: the process these acts go to (the CDP driver's browser), told once the act ran (a navigate may connect first).
      try { return await f(...args); } finally { if (actedPid) await g.byProcess?.(await actedPid().catch(() => null)).catch(() => {}); }
    });
  }
  // The agent's own focus and launches rebind the window it works in, nested or not (a navigate raises its browser).
  // The platform adapter takes a query and answers true/false; the accessibility bridge takes (title, processId) and
  // answers {success}.
  wrap('focusWindow', async (g, f, args, nested) => {
    if (!nested) g.stopCheck();
    const r = await f(...args) as boolean | { success?: boolean } | undefined;
    const q: WindowQuery = typeof args[0] === 'object' && args[0] !== null
      ? args[0] as WindowQuery
      : { title: args[0] as string | undefined, processId: args[1] as number | undefined };
    // Told after `focused` has the window: the outline goes to it now, not at the next act.
    if (r === true || (typeof r === 'object' && r?.success)) { await g.focused(q); announce('focusWindow'); }
    return r;
  });
  // A launch types into the Start menu / Spotlight itself: its own keys run inside this one guarded call.
  for (const m of ['openApp', 'launchApp']) {
    wrap(m, async (g, f, args, nested) => {
      if (!nested) { g.stopCheck(); announce(m); }
      const r = await f(...args) as { pid?: number; title?: string } | undefined;
      await g.launched(r, typeof args[0] === 'string' ? args[0] : undefined);
      announce(m);  // again, now that the launched window is known: the outline goes to it
      return r;
    });
  }
  guardHardKeys(target);
  fencePointerMethods(target);
  return target;
}

/**
 * The test fence (core/fence.ts): every pointer method of this object (a move, a press, a release, a click, a drag, a
 * scroll) is checked before it runs: the pointer may only be inside the fenced window in front. Outermost, so a move
 * followed by a bare press cannot reach another window. With no fence nothing is wrapped.
 */
function fencePointerMethods(target: object): void {
  if (!fenceActive()) return;   // no fence: the methods stay exactly as they are
  const names = new Set<string>();
  for (let o: object | null = target; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) if (/^mouse[A-Z]/.test(k) || k === 'executeMouseAction') names.add(k);
  }
  const t = target as Record<string, unknown>;
  for (const m of names) {
    const f = t[m];
    if (typeof f !== 'function') continue;
    t[m] = async (...args: unknown[]) => {
      if (inInput.getStore() !== 'user') await fencePointer(m, args);
      return f.apply(target, args);
    };
  }
}

/**
 * Keys the agent holds down (key_down without its key_up yet), in both input layers: they are one keyboard. Keyed by the
 * key AS THE AGENT NAMED IT (lower case), with the key it stands for: `key_up rwin` lets go of the right Windows key and
 * must not make clawdcursor forget the `win` it is still holding. Per server process: a key held through one clawdcursor
 * process is not known to another.
 */
const heldKeys = new Map<string, string>();
const namedKeys = (combo: unknown): string[] => String(combo ?? '').split('+').map(k => k.trim().toLowerCase()).filter(Boolean);

/**
 * The hard key list (hard-keys.ts) — its ONE call site. Outermost and unconditional: it runs for nested calls, for
 * clawdcursor's own housekeeping and with no input guard installed, because no caller has a reason to lock the machine.
 *  - A key held with key_down counts toward the next press (key_down "win", then key_press "l").
 *  - So does typed text: with a key held, every typed character is a press of that key with it (key_down "win", type "l").
 *  - key_up forgets a key only when it names that ONE key, exactly as it was held, and only after the executor released
 *    it. The executors throw on a chord or an unknown name in key_down / key_up, so nothing is recorded or forgotten for one.
 */
function guardHardKeys(target: object): void {
  const t = target as Record<string, unknown>;
  for (const m of ['keyPress', 'keyDown', 'keyUp', 'typeText']) {
    const f = t[m];
    if (typeof f !== 'function') continue;
    t[m] = async (...args: unknown[]) => {
      if (m === 'keyUp') {
        const r = await f.apply(target, args);
        // One key, by the name it was held under, and only now that the executor released it. A chord ("win+x"), or
        // any other name, is not a release of a held key: the executors refuse those, and if one did not, nothing is
        // forgotten here either.
        const named = namedKeys(args[0]);
        if (named.length === 1 && !String(args[0]).includes('+')) heldKeys.delete(named[0]);
        return r;
      }
      const held = [...new Set(heldKeys.values())];
      // Typed text only matters while something is held: each character is then a chord with the held keys.
      const presses = m === 'typeText' ? (held.length ? [...String(args[0] ?? '')] : []) : [args[0]];
      for (const press of presses) {
        const why = hardKeyRefusal(press, held);
        if (why) throw new Error(why);
      }
      const r = await f.apply(target, args);
      if (m === 'keyDown') namedKeys(args[0]).forEach((k, i) => heldKeys.set(k, keysOf(args[0])[i] ?? k));
      return r;
    };
  }
}

/** For tests: forget the held keys. */
export function _resetHeldKeys(): void {
  heldKeys.clear();
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
 * Runs before every screen capture (screenshot, OCR). The pill and outline are for the person at the screen, never part of
 * what the agent sees: where the OS can exclude a window from capture (Windows, macOS) the overlay does so itself;
 * elsewhere (Linux, Windows 10 before 2004) the banner's hook hides them for the moment of the capture.
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
 * clawdcursor's own overlay processes (the pill, the outline) are the user's: never a window or app that a lookup by name, title
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
