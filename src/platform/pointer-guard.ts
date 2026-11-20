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
import { fenceActive, fencePointer, pointerPoints } from '../core/fence';

let hook: (() => Promise<void>) | null = null;

export function setBeforePointerPress(h: (() => Promise<void>) | null): void {
  hook = h;
}

/** Never throws: a failed dodge must not stop the click. */
export async function beforePointerPress(): Promise<void> {
  if (!hook) return;
  try { await hook(); } catch { /* cosmetic */ }
}

/** A window the agent asked for by process, name or title, or by its handle (Windows only: the fence, a Store app's frame). */
export interface WindowQuery { processId?: number; processName?: string; title?: string; handle?: number }
/**
 * Runs around every synthetic key, type, click, drag and scroll, in both input layers (the platform adapter and
 * NativeDesktop): core/control.ts refuses input while the user has stopped clawdcursor, or when the window in front is not
 * the one the agent was working in (#294). Unlike the hooks above it throws — a refusal sends nothing. Releases (mouseUp,
 * keyUp) are never refused: a button or key the agent holds must always be let go.
 */
interface InputGuard {
  /** Throws while the user has stopped clawdcursor. */
  stopCheck(): void;
  /**
   * Before an act: waits while the user holds clawdcursor (the pill's Pause, or a takeover they kept working through), and
   * for `real` input (the mouse, the keyboard, the front window) until the user is idle. Throws the held waiting reply or
   * STOPPED. (before() and byName() run it themselves.)
   */
  turn?(real: boolean): Promise<void>;
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
  /**
   * Before a read or an act by element: throws when it would go to clawdcursor's own UI: the process named or, with
   * none named, the window in front (a host app's own window can be in front, after the user clicked it).
   */
  notOwnUi?(processId?: number): Promise<void>;
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
/**
 * Told where a BACKGROUND act that passed the guard lands on screen (an element acted on by name): the ghost cursor is drawn
 * there. Never for real mouse input: that moves the user's own cursor, and the ghost must not follow it.
 */
let onAgentPoint: ((x: number, y: number) => void) | null = null;
export function setOnAgentPoint(f: ((x: number, y: number) => void) | null): void {
  onAgentPoint = f;
}
const pointAt = (x: unknown, y: unknown) => {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
  try { onAgentPoint?.(Math.round(x), Math.round(y)); } catch { /* cosmetic */ }
};
/**
 * Told when the agent starts waiting, and when it stops (null): a wait it asked for, or an app it started that is still
 * coming up. The pill says "waiting" then (owner, 2026-11-19), not "running in background".
 */
let onAgentWait: ((what: string | null) => void) | null = null;
export function setOnAgentWait(f: ((what: string | null) => void) | null): void { onAgentWait = f; }
export function agentWaiting(what: string | null): void {
  try { onAgentWait?.(what); } catch { /* cosmetic */ }
}
/** Told before every agent act, as the pill is: what was read from the screen before it is stale (ocr-engine.ts). */
const actListeners: Array<() => void> = [];
export function onAgentAct(f: () => void): void {
  actListeners.push(f);
}
const announce = (m: string) => {
  for (const f of actListeners) f();
  try { onAgentInput?.(m); } catch { /* cosmetic */ }
};

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

/**
 * Every guarded method of the input layers, by name, with what the running pill says while it runs (banner.ts). Each one is
 * in one of the two modes the user sees:
 *  - `foreground`: real keyboard and mouse input (SendInput and its macOS/Linux kin). It lands in the window in front, so
 *    it is refused while stopped and when the agent's window is no longer in front. The user sees the full-screen amber
 *    glow and the pill "requires foreground"; the pill also names that window's app.
 *  - `background`: acts that do not go through the window in front: by element (accessibility), on a window by handle
 *    (window messages), in a page (CDP). The user sees only the amber outline round the agent's window and the pill
 *    "running in background". They still stop when the user does: a handler already running when they stop must not
 *    carry on (#294). writeClipboard, evaluate (any page script) and switchTab act too (audit 2026-11-05). Putting the
 *    user's own clipboard back after a paste is not agent input: those restores run unguarded().
 *  - every other pointer method (`pointerMethods`: mouseMove — hover opens menus — and mouseMoveRelative) is guarded by
 *    rule rather than by name, so a new one is not left moving after a Stop. It moves the user's real cursor, so the user
 *    sees it as foreground (isForegroundInput).
 *  - `launch`: launchApp, wrapped on its own below (it rebinds the window the agent works in).
 */
export const GUARDED_METHODS: Readonly<Record<string, { kind: 'foreground' | 'background' | 'launch'; activity?: string }>> = {
  mouseClick: { kind: 'foreground', activity: 'Clicking' }, mouseDoubleClick: { kind: 'foreground', activity: 'Clicking' },
  mouseRightClick: { kind: 'foreground', activity: 'Clicking' }, mouseDown: { kind: 'foreground', activity: 'Clicking' },
  mouseDrag: { kind: 'foreground', activity: 'Dragging' }, mouseScroll: { kind: 'foreground', activity: 'Scrolling' },
  typeText: { kind: 'foreground', activity: 'Typing' }, keyPress: { kind: 'foreground', activity: 'Pressing keys' },
  keyDown: { kind: 'foreground', activity: 'Pressing keys' },
  invokeElement: { kind: 'background', activity: 'Clicking' }, deliverToWindow: { kind: 'background', activity: 'Typing' }, scrollIntoView: { kind: 'background', activity: 'Scrolling' },
  setWindowState: { kind: 'background', activity: 'Arranging windows' }, setWindowBounds: { kind: 'background', activity: 'Arranging windows' },
  navigate: { kind: 'background', activity: 'Opening a page' }, click: { kind: 'background', activity: 'Clicking' },
  clickByText: { kind: 'background', activity: 'Clicking' }, typeInField: { kind: 'background', activity: 'Typing' },
  typeByLabel: { kind: 'background', activity: 'Typing' }, focus: { kind: 'background', activity: 'Clicking' },
  selectOption: { kind: 'background', activity: 'Choosing an option' }, pressKey: { kind: 'background', activity: 'Pressing keys' },
  writeClipboard: { kind: 'background' }, evaluate: { kind: 'background' }, switchTab: { kind: 'background' },
  launchApp: { kind: 'launch', activity: 'Opening an app' },
};
const methodsOf = (kind: 'foreground' | 'background') => Object.keys(GUARDED_METHODS).filter(m => GUARDED_METHODS[m].kind === kind);
const FOREGROUND_METHODS = methodsOf('foreground');
const BACKGROUND_METHODS = methodsOf('background');
/**
 * Input the user sees as the foreground mode: the listed foreground methods, and every pointer move (a hover moves their
 * real cursor), which is guarded by rule, not by name, below.
 */
export const isForegroundInput = (method: string): boolean => GUARDED_METHODS[method]?.kind === 'foreground' || /^mouse[A-Z]/.test(method);

/**
 * When the agent's own synthetic input last ended (a key, a click, a move, a focus, putting the user's window back): the OS
 * counts every process's input in its idle time, ours too, and the idle check (core/control.ts) must not read ours as the
 * user's.
 */
let ownInputEnd = 0;
export const ownInputAt = (): number => ownInputEnd;
/** Told right after each input of the agent's was sent: the idle check reads the OS's input clock then (core/control.ts). */
let afterOwnInput: (() => void) | null = null;
export function setAfterOwnInput(f: (() => void) | null): void { afterOwnInput = f; }
/** The agent pressed a mouse button (mouseDown) and has not let it go: a drag in progress. */
let buttonDown = false;
/**
 * A gesture of the agent's is in progress: a button or a key it holds down. It is finished before the user's turn begins
 * (core/control.ts), never left pressed while they move their own mouse or type.
 */
export const gestureInProgress = (): boolean => buttonDown || heldKeys.size > 0;
/** Innermost, so it is noted only for input that was really sent (a refusal sends nothing). */
function noteOwnInput(target: object): void {
  const t = target as Record<string, unknown>;
  for (const m of new Set([...FOREGROUND_METHODS, ...pointerMethods(target), 'keyUp', 'focusWindow', 'launchApp', 'restoreForeground'])) {
    const f = t[m];
    if (typeof f !== 'function') continue;
    t[m] = async (...args: unknown[]) => {
      try {
        const r = await f.apply(target, args);
        ownInputEnd = Date.now();
        if (m === 'mouseDown') buttonDown = true;
        try { afterOwnInput?.(); } catch { /* the idle check falls back to the time */ }
        return r;
      } finally {
        if (m === 'mouseUp') buttonDown = false;
      }
    };
  }
}

/** Every pointer method of the object (a move, press, release, click, drag, scroll), its prototypes' included. */
function pointerMethods(target: object): string[] {
  const names = new Set<string>();
  for (let o: object | null = target; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) if (/^mouse[A-Z]/.test(k)) names.add(k);
  }
  return [...names];
}

/**
 * Opt-in confirm mode (core/confirm-mode.ts, #373): CLAWD_CONFIRM=1 holds an act that looks irreversible until the user
 * answers on the pause card. Off by default; loaded only when on. Asked before the window check, which then reads the
 * window in front as it is after the user's answer.
 */
async function confirmCheck(method: string, args: unknown[], target: object): Promise<void> {
  if (!/^(1|true)$/i.test((process.env.CLAWD_CONFIRM ?? '').trim())) return;
  // The held keys as the agent named them: on Windows NativeDesktop holds `meta` as Ctrl, the adapter as the Windows key.
  await (await import('../core/confirm-mode')).confirmBefore(method, args, [...heldKeys.keys()], target);
}

/**
 * Route an input layer's methods through the guard: the platform adapter, NativeDesktop, the accessibility bridge and the
 * CDP driver. One check per outermost call: a method that calls another (typeText → keyPress for a paste) is one input.
 */
export function guardInputMethods<T extends object>(target: T, actedPid?: () => Promise<number | null>): T {
  noteOwnInput(target);
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
  for (const m of FOREGROUND_METHODS) {
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
      g.stopCheck();
      await confirmCheck(m, args, target);
      await g.before();
      announce(m);
      // No ghost here: real input moves the user's own cursor, and a second one drawn next to it (owner, 2026-11-19) only
      // says the same thing twice. The ghost is the background mode's pointer alone (invokeElement below).
      const r = await f(...args);
      g.done(movesFocus(m, args));
      return r;
    });
  }
  // By-name acts on the window in front are checked like input; reading a value is not an act.
  wrap('invokeElement', async (g, f, args, nested) => {
    const q = (args[0] ?? {}) as { processId?: number; action?: string };
    if (!nested) {
      g.stopCheck();
      await g.notOwnUi?.(q.processId);
      if (q.action !== 'get-value') { await confirmCheck('invokeElement', args, target); await g.byName(q.processId); }
      announce('invokeElement');
    }
    const r = await f(...args) as { success?: boolean; bounds?: { x: number; y: number; width: number; height: number } } | undefined;
    const b = r?.bounds;
    if (!nested && q.action !== 'get-value' && r?.success !== false && b && b.width > 0 && b.height > 0) pointAt(b.x + b.width / 2, b.y + b.height / 2);
    return r;
  });
  // Reads by element take a process id, or with none the window in front: never clawdcursor's own UI either way.
  for (const m of ['getUiTree', 'getScreenContext', 'findElements', 'findElement', 'getPageText']) {
    wrap(m, async (g, f, args, nested) => {
      const a = args[0];
      if (!nested) await g.notOwnUi?.(typeof a === 'number' ? a : (a as { processId?: number } | undefined)?.processId);
      return f(...args);
    });
  }
  // A release (mouseUp) is never refused; the window-checked pointer input is wrapped above.
  const pointerOnly = pointerMethods(target).filter(m => m !== 'mouseUp' && !FOREGROUND_METHODS.includes(m));
  const stopOnly = [...BACKGROUND_METHODS, ...pointerOnly];
  for (const m of stopOnly.filter(m => m !== 'invokeElement')) {
    wrap(m, async (g, f, args, nested) => {
      if (nested) return f(...args);
      g.stopCheck();
      // A move is the user's pointer too: it waits for them to be idle. Background acts only wait out a hold.
      await g.turn?.(pointerOnly.includes(m));
      await confirmCheck(m, args, target);
      announce(m);
      // `actedPid`: the process these acts go to (the CDP driver's browser), told once the act ran (a navigate may connect first).
      try { return await f(...args); } finally {
        if (actedPid) {
          await g.byProcess?.(await actedPid().catch(() => null)).catch(() => {});
          // The browser it went to is known only now: the pill and the outline follow it at once, not at the next act.
          try { onAgentInput?.(m); } catch { /* cosmetic */ }
        }
      }
    });
  }
  // The agent's own focus and launches rebind the window it works in, nested or not (a navigate raises its browser).
  // The platform adapter takes a query and answers true/false; the accessibility bridge takes (title, processId) and
  // answers {success}.
  wrap('focusWindow', async (g, f, args, nested) => {
    // Bringing a window to the front takes the user's keyboard: it waits for them to be idle.
    if (!nested) { g.stopCheck(); await g.turn?.(true); }
    const r = await f(...args) as boolean | { success?: boolean } | undefined;
    const q: WindowQuery = typeof args[0] === 'object' && args[0] !== null
      ? args[0] as WindowQuery
      : { title: args[0] as string | undefined, processId: args[1] as number | undefined };
    // Told after `focused` has the window: the outline goes to it now, not at the next act.
    if (r === true || (typeof r === 'object' && r?.success)) { await g.focused(q); announce('focusWindow'); }
    return r;
  });
  // A launch types into the Start menu / Spotlight itself: its own keys run inside this one guarded call.
  wrap('launchApp', async (g, f, args, nested) => {
    if (!nested) { g.stopCheck(); await g.turn?.(true); announce('launchApp'); }
    // The launch waits for the app's window: the pill says so ("waiting for Designcenter to load") until it is up.
    const app = typeof args[0] === 'string' && args[0].trim() ? args[0].trim().slice(0, 40) : 'the app';
    if (!nested) agentWaiting(`waiting for ${app} to load`);
    let r: { pid?: number; title?: string } | undefined;
    try { r = await f(...args) as { pid?: number; title?: string } | undefined; } finally { if (!nested) agentWaiting(null); }
    await g.launched(r, typeof args[0] === 'string' ? args[0] : undefined);
    announce('launchApp');  // again, now that the launched window is known: the outline goes to it
    return r;
  });
  guardHardKeys(target);
  fencePointerMethods(target);
  ownUiPointerMethods(target);
  return target;
}

/** The process of the top-level window at a screen point (the pointer's own position for null); null when it cannot be told. */
type PointPid = (at: { x: number; y: number } | null) => Promise<number | null>;
/** Windows: WindowFromPoint, its root window, that window's process (the bridge's pid-at-point). Not read on macOS or Linux yet. */
const platformPointPid: PointPid = async at => {
  if (process.platform !== 'win32') return null;
  const { psRunner } = await import('./ps-runner');
  const r = await psRunner.run({ cmd: 'pid-at-point', ...(at ? { x: Math.round(at.x), y: Math.round(at.y) } : {}) }) as { processId?: number };
  return typeof r?.processId === 'number' && r.processId > 0 ? r.processId : null;
};
let pointPid: PointPid = process.env.VITEST ? async () => null : platformPointPid;
/** For tests: what is at a point. */
export function __setPointPidReaderForTests(f: PointPid | null): void {
  pointPid = f ?? platformPointPid;
}

/**
 * A press, drag or scroll at coordinates lands on whatever window is at that point, in front or not: a host app's own
 * card (CLAWD_OWN_UI_PIDS, docs/pill-host.md) has the user's Yes button on it, and a blind click there would answer for
 * them. Before every pointer method of this object but a move or a release, the window at each of its points (both
 * ends of a drag; the pointer's own position when it names none) must not be own UI. Outermost, like the fence, so a
 * move followed by a bare press is checked where the pointer is. Only read when a host named its own UI: the built-in
 * pill steps out of the way of a press instead (beforePointerPress). A point that cannot be read is let through.
 */
function ownUiPointerMethods(target: object): void {
  const t = target as Record<string, unknown>;
  for (const m of pointerMethods(target)) {
    if (m === 'mouseUp' || m === 'mouseMove' || m === 'mouseMoveRelative') continue;
    const f = t[m];
    if (typeof f !== 'function') continue;
    t[m] = async (...args: unknown[]) => {
      if (inInput.getStore() !== 'user' && (process.env.CLAWD_OWN_UI_PIDS || process.env.CLAWD_OWN_UI_PIDS_FILE)) {
        const points: Array<{ x: number; y: number } | null> = pointerPoints(m, args);
        for (const at of points.length ? points : [null]) {
          const pid = await pointPid(at).catch(() => null);
          if (pid !== null && isOwnUiPid(pid)) {
            throw new Error(`${at ? `the point (${Math.round(at.x)}, ${Math.round(at.y)})` : 'the point under the pointer'} is clawdcursor's own on-screen control — it is the user's, never read or acted on. Target the app instead.`);
          }
        }
      }
      return f.apply(target, args);
    };
  }
}

/**
 * The test fence (core/fence.ts): every pointer method of this object (a move, a press, a release, a click, a drag, a
 * scroll) is checked before it runs: the pointer may only be inside the fenced window in front. Outermost, so a move
 * followed by a bare press cannot reach another window. With no fence nothing is wrapped.
 */
function fencePointerMethods(target: object): void {
  if (!fenceActive()) return;
  const t = target as Record<string, unknown>;
  for (const m of pointerMethods(target)) {
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
  buttonDown = false;
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
  return true;  // clicks, drags, a held button
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
