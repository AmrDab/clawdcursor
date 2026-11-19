/**
 * Who has control of the desktop — the agent, or the user who stopped it (#294).
 *
 * Found live (2026-10-28): a batch [wait 30 s → key ctrl+l → type url↵] kept going after the user stopped clawdcursor and
 * switched apps; the keys and the URL landed in the Claude app and every step said ok. Two causes:
 *  - "stop" was not a state. The pill's double-click ended the stdio server, the host started a fresh one on the agent's
 *    next call, and that one knew nothing of the stop.
 *  - input went to whatever window was in front. Nothing checked that it was still the one the agent was working in.
 *
 * So:
 *  - STOPPED is a file shared by every clawdcursor process, set by any stop (the pill, `clawdcursor stop`, the daemon's
 *    /stop) and outliving a restart. While it is set, own-ui-guard refuses every call except asking the user, and every act
 *    in the input layers is refused (pointer-guard.ts). Only the user's Resume on a pause prompt, `clawdcursor resume` or
 *    starting the daemon clears it. An agent confined to the tools cannot; one with a shell of its own is not confined.
 *  - every synthetic key, type, click, drag and scroll is refused when the window in front is not the one the agent was
 *    working in. A change right after the agent's own focus-moving input (a click, Return, a shortcut) or focus call is
 *    its own doing; a change after a gap — a wait, a pause between calls — is the user's.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { fenceActive, fenceCheck, fenceInput, isFenceRefusal } from './fence';
import { freshHostedAppOf, isFrameHost } from '../platform/frame-host';
import { appLabel } from './app-label';
import * as fs from 'fs';
import { quoteScreenText } from './untrusted-screen-content';
import * as path from 'path';
import { DATA_DIR } from '../paths';
import { logger } from './observability/logger';
import { setInputGuard, setAfterOwnInput, isOwnUiPid, ownInputAt, gestureInProgress, type WindowQuery } from '../platform/pointer-guard';
import { inForegroundBurst, setUserTurns } from '../platform/foreground-burst';
import { windowTextIncludes } from '../platform/window-text';
import { aiHostKind, sameApp } from './ai-hosts';

// Off under the test runner unless a test points it somewhere: tests must not write into the user's real data dir.
let dir: string | null = process.env.VITEST ? null : DATA_DIR;
const stopFile = () => (dir ? path.join(dir, 'stopped.json') : null);
/** Only where the stop file cannot be written: then this process at least stays stopped. Otherwise the file is the truth. */
let stoppedHere = false;

export function __setControlDirForTests(d: string | null): void { dir = d; stoppedHere = false; heldHere = null; resumedAt = 0; pillHeld = false; ownBase = Promise.resolve(null); resetBinding(); }

/** The user took control back. Every clawdcursor process sees it; it survives a restart. */
export function stopControl(by: string): void {
  logger.warn('control.stop', { by, pid: process.pid });
  const file = stopFile();
  if (!file || !dir) stoppedHere = true;
  else {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ by, pid: process.pid, at: Date.now() }));
    } catch { stoppedHere = true; }
  }
  // A stop ends a hold: the waiting acts are refused as stopped now.
  const wasHeld = isHeld();
  dropHold();
  if (wasHeld || pillHeld) tell('resumed');
}

/** Read on every call, never cached: another process's stop, or resume, must reach this one at once. */
export function isStopped(): boolean {
  if (stoppedHere) return true;
  const file = stopFile();
  return !!file && fs.existsSync(file);
}

/**
 * Only the user gives control back: a Resume click on a pause prompt, `clawdcursor resume`, or starting the daemon. The
 * window binding is kept: if the user left another app in front, the agent's next input is refused until it focuses its own.
 * It ends a hold too (the pill's Pause).
 */
export function resumeControl(by: string): void {
  logger.info('control.resume', { by, pid: process.pid });
  stoppedHere = false;
  const file = stopFile();
  if (file) { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } }
  releaseHold(by);
}

/** `clawdcursor resume`: ends a stop and a hold, whichever is set. False when there was neither. */
export function giveControlBack(by: string): boolean {
  if (!isStopped() && !isHeld()) return false;
  resumeControl(by);
  return true;
}

// The tool's own name, not one surface's call syntax: tool text is renamed per surface (compact.ts toCompactNames), and a
// literal `system {"action":"pause_for_user"}` came out mangled inside a batch step on the real Mac. The exact call is in the
// result line's `next` (result-codes.ts STOPPED).
export const STOPPED_TEXT =
  'stopped by the user — they took control back, and nothing runs until they give it back. Do not retry. ' +
  'To ask for it, call pause_for_user with a message saying what you want to do next: their Resume click gives control back.';

/** Sleep that ends early when the user stops clawdcursor. True when it was cut short. */
export async function sleepUnlessStopped(ms: number): Promise<boolean> {
  settle();
  const end = Date.now() + ms;
  for (;;) {
    if (isStopped()) return true;
    const left = end - Date.now();
    if (left <= 0) return false;
    await new Promise(r => setTimeout(r, Math.min(left, 250)));
  }
}

// ── The user's turn (owner, 2026-11-18) ──
//
// Real input (a key, a click, a drag, a move, a focus, a launch: anything that takes the user's mouse, keyboard or front
// window) waits until the user is idle: the agent never moves the mouse or types while their hands are on it. When they
// take over (busy when the agent wants to start, or their input in the middle of a foreground burst), nothing more is
// sent; after `takeoverMs` it carries on by itself if they are idle, and if they are still working clawdcursor is HELD
// until they click Resume on the pill (or Stop). The pill's Pause holds it too. While held every act waits, background
// ones included, `waitMs` per call; then the call returns the HELD waiting reply and the agent calls the same step again.
// Reads are not held.

/**
 * idleMs: no input for this long is idle; takeoverMs: how long a takeover waits before it looks again; waitMs: how long
 * one call waits while held (some hosts time a tool call out at 60 s); graceMs: input this soon after the pill's Resume
 * is the user's hand leaving it. Tests shorten them.
 */
export const turnTiming = { idleMs: 1000, takeoverMs: 5000, waitMs: 50_000, pollMs: 200, graceMs: 1500 };
/** Only where the input clock could not be read after the agent's input: its own input ends a moment before its clock reads it. */
const OWN_SLACK_MS = 100;
/** Two reads of the same last input: equal on Windows (GetLastInputInfo's tick), within a ms or two on macOS. */
const TICK_SLACK_MS = 2;
/**
 * The OS's input clock, read right after the agent's own last input (pointer-guard.ts tells): unchanged at the next check,
 * nothing came since, so the last input was the agent's. Changed, someone else's input came after it: the user's. Exact,
 * where a time window would hide a user who keeps working through a quick run of the agent's inputs (a batch).
 */
let ownBase: Promise<number | null> = Promise.resolve(null);

/**
 * The hold is a file every clawdcursor process reads on every check, as the stop is: the Pause on one process's pill holds
 * an agent working through another. Only where the file cannot be written does this process keep it to itself.
 */
const holdFile = () => (dir ? path.join(dir, 'held.json') : null);
let heldHere: { by: string; since: number } | null = null;
/** Can the user's pill show here (banner.ts sets it)? Without it nobody can click Resume, so a takeover never holds. */
let pillCanShow: () => boolean = () => true;
export function setPillAvailable(f: (() => boolean) | null): void { pillCanShow = f ?? (() => true); }
const aliveProcess = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
/** When the user last clicked Resume on the pill, or this process saw a hold end. */
let resumedAt = 0;
/** This process's pill was told 'held' (it offers Resume): it is told 'resumed' when the hold ends, wherever it ended. */
let pillHeld = false;

/** takeover: the user's turn, waiting `takeoverMs`; held: until their Resume; resumed: the agent's turn again. */
export type HoldEvent = 'takeover' | 'held' | 'resumed';
let onHold: ((e: HoldEvent) => void) | null = null;
/** The indicator (banner.ts): the pill says "Paused", shows Resume while held, and the glow is down. */
export function setOnHold(f: ((e: HoldEvent) => void) | null): void { onHold = f; }
const tell = (e: HoldEvent) => {
  if (e !== 'takeover') pillHeld = e === 'held';
  try { onHold?.(e); } catch { /* cosmetic */ }
};

/**
 * The hold now, read fresh: another process's Pause or Resume must reach this one at once. A hold whose writer process is
 * gone has no pill left to Resume it: it is removed here, so a new session never inherits it.
 */
function holdInfo(): { by: string; since: number } | null {
  if (heldHere) return heldHere;
  const file = holdFile();
  if (!file) return null;
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }   // no file: not held
  let h: { by?: unknown; at?: unknown; pid?: unknown };
  try { h = JSON.parse(raw); } catch { return { by: '', since: Date.now() }; }
  if (typeof h?.pid === 'number' && !aliveProcess(h.pid)) { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } return null; }
  return { by: String(h?.by ?? ''), since: Number(h?.at) || Date.now() };
}

export function isHeld(): boolean { return holdInfo() !== null; }

function dropHold(): void {
  heldHere = null;
  const file = holdFile();
  if (file) { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } }
}

/** The user holds clawdcursor: the pill's Pause, or a takeover they kept working through. Every act waits until releaseHold. */
export function holdControl(by: string): void {
  if (isStopped()) return;
  if (isHeld()) { if (!pillHeld) tell('held'); return; }   // held from another process: this pill offers Resume too
  const at = Date.now();
  const file = holdFile();
  if (!file || !dir) heldHere = { by, since: at };
  else {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ by, pid: process.pid, at }));
    } catch { heldHere = { by, since: at }; }
  }
  logger.info('control.hold', { by, pid: process.pid });
  tell('held');
}

/** The user's Resume on the pill: the waiting acts go on (in every process), and their click on it is not a takeover. */
export function releaseHold(by: string): void {
  if (!isHeld()) { if (pillHeld) tell('resumed'); return; }
  dropHold();
  resumedAt = Date.now();
  logger.info('control.release', { by, pid: process.pid });
  tell('resumed');
}

// Not a guard refusal's "Do not retry": the agent must call the same step again, as with pause_for_user's waiting reply.
// The Pause button says "paused by the user"; a takeover is the user at work, not a Pause they pressed, and says so.
const waitedFor = (since: number) => `(waitedSec: ${Math.round((Date.now() - since) / 1000)}).`;
const NO_GIVING_UP = 'Do not end the task, give up or act some other way meanwhile ';
const heldText = (since: number, by: string) => by === 'takeover'
  ? 'the user is using the computer — clawdcursor is waiting for them, and nothing was sent. Waiting is normal: call the same step again ' +
    `to keep waiting; it runs once they click Resume on the pill. ${NO_GIVING_UP}${waitedFor(since)}`
  : 'paused by the user — they have the desktop, and nothing was sent. Waiting is normal: call the same step again to keep ' +
    `waiting; it runs the moment they click Resume on the pill. ${NO_GIVING_UP}${waitedFor(since)}`;
// No pill to Resume from: nothing is held, the call only waits for the user to be idle.
const activeText = (since: number) =>
  'the user is using the computer — clawdcursor is waiting for them, and nothing was sent. Waiting is normal: call the same step again ' +
  `to keep waiting; it runs once they are idle. ${NO_GIVING_UP}${waitedFor(since)}`;

type Idle = { tick: number; idleMs: number } | null;
// Off under the test runner unless a test sets a reader. Null: this OS cannot tell (Linux), and then nothing waits.
let readIdle: () => Promise<Idle> = process.env.VITEST ? async () => null : async () => {
  const { getPlatform } = await import('../platform');
  const p = await getPlatform();
  return (await p.userIdle?.()) ?? null;
};
export function __setIdleReaderForTests(f: (() => Promise<Idle>) | null): void {
  readIdle = f ?? (async () => null);
}

/**
 * Is the user idle: no input for idleMs, or none since the agent's own last input (the OS counts ours too) or since the
 * user's Resume click, with a little grace. Unreadable: idle, since it cannot be told.
 */
async function userIsIdle(): Promise<boolean> {
  const i = await readIdle().catch(() => null);
  if (!i || i.idleMs >= turnTiming.idleMs) return true;
  const last = Date.now() - i.idleMs;   // the latest the last input can have been
  if (last <= resumedAt + turnTiming.graceMs) return true;   // the click on Resume
  const base = await ownBase;
  if (base !== null) return Math.abs(i.tick - base) <= TICK_SLACK_MS;
  return last <= ownInputAt() + OWN_SLACK_MS;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * One tool call's share of waiting for the user (mcp-server.ts runs every call in it): all its waits together, a burst's
 * takeover at the start and another after an interruption included, end by takeoverMs + waitMs from the call's start, so
 * the call returns its waiting reply before a host's 60 s limit, never acting later for a call the host gave up on.
 */
const callBudget = new AsyncLocalStorage<{ until: number }>();
export function withTurnBudget<R>(fn: () => R): R {
  return callBudget.run({ until: Date.now() + turnTiming.takeoverMs + turnTiming.waitMs }, fn);
}
const byDeadline = (until: number) => Math.min(until, callBudget.getStore()?.until ?? Infinity);

/** While held: wait, up to waitMs, for the user's Resume. Throws the waiting reply when it does not come, or STOPPED. */
async function waitWhileHeld(): Promise<void> {
  const until = byDeadline(Date.now() + turnTiming.waitMs);
  let waited = false;
  for (let h = holdInfo(); h; h = holdInfo()) {
    if (!pillHeld) tell('held');   // held from another process, or from before this one started: this pill offers Resume too
    waited = true;
    stopCheck();
    if (Date.now() >= until) throw new Error(heldText(h.since, h.by));
    await sleep(turnTiming.pollMs);
  }
  if (waited) {
    // Ended here or in another process: the Resume click is not a takeover, and this pill offers Pause again.
    resumedAt = Math.max(resumedAt, Date.now());
    if (pillHeld) tell('resumed');
  }
  stopCheck();
}

/** With no pill: wait, up to the call's budget, until the user is idle (true) or another process holds (false). Throws the waiting reply, or STOPPED. */
async function waitUntilIdle(since: number): Promise<boolean> {
  const until = byDeadline(Date.now() + turnTiming.waitMs);
  for (;;) {
    stopCheck();
    if (isHeld()) return false;
    if (await userIsIdle()) return true;
    if (Date.now() >= until) throw new Error(activeText(since));
    await sleep(turnTiming.pollMs);
  }
}

/**
 * The user took over: busy when the agent wanted to start, or their input in the middle of a burst (whose window and
 * cursor are already theirs again). Nothing is sent. After takeoverMs: idle → resolves, the step goes on; still working
 * → held until their Resume. Throws the waiting reply, or STOPPED.
 */
export async function takeover(): Promise<void> {
  if (!isHeld()) {
    const started = Date.now();
    tell('takeover');
    try {
      movedAt = 0;   // a window that comes up meanwhile is the user's doing, not the agent's
      for (const until = byDeadline(Date.now() + turnTiming.takeoverMs); !isHeld() && Date.now() < until;) {
        stopCheck();
        await sleep(Math.min(turnTiming.pollMs, Math.max(0, until - Date.now())));
      }
      stopCheck();
      if (!isHeld() && await userIsIdle()) return;
      if (pillCanShow()) holdControl('takeover');
      else if (await waitUntilIdle(started)) return;   // no Resume to click, so nothing is held: only their being idle lets it go
    } finally {
      // Not held (idle again, or stopped): the agent's turn again as far as the pill goes, never "your turn" left up.
      if (!isHeld()) tell('resumed');
    }
  }
  await waitWhileHeld();
}

/**
 * Before an act: wait while held; before real input also wait for the user to be idle (a takeover when they are not).
 * Not for this call's own acts inside a foreground burst, which keeps the same rule itself (foreground-burst.ts). Not in the
 * middle of a gesture of the agent's (a button or a key it holds down): it is finished, never left pressed while the user
 * works; its start (mouseDown, keyDown) waited for them.
 */
async function turn(real: boolean): Promise<void> {
  if (inForegroundBurst() || gestureInProgress()) return;
  if (isHeld()) await waitWhileHeld();
  if (real && !(await userIsIdle())) await takeover();
}

// A hold counts as busy: the burst then waits in takeover() for the Resume, and never starts under the pill's Pause.
setUserTurns({ idle: async () => !isHeld() && await userIsIdle(), takeover });
setAfterOwnInput(() => { ownBase = readIdle().then(i => i?.tick ?? null, () => null); });

// ── The window the agent is working in ──

interface Foreground { processId: number; processName: string; appName?: string; title?: string; handle?: number | string; guessed?: boolean;
  /** For the fence (fence.ts): the app a Store app's frame hosts, and where the window is. */
  hostedProcessId?: number; bounds?: { x: number; y: number; width: number; height: number };
  /** That app's process name ("CalculatorApp"): a focus by the app's own name matches it, as the Windows adapter's lookup does. */
  hostedProcessName?: string;
  /**
   * The process this act went to, VERIFIED when it was sent: the pid the fence allowed it by, else (no fence) the window's
   * own process, or for a Store app the process its frame hosts read fresh from the bridge. Never the display cache's
   * answer. Undefined when it could not be verified: the session log then records no process for the act.
   */
  actPid?: number }
/** undefined = not bound yet: the next input binds to whatever is in front. */
let lease: Foreground | undefined;
/** A window the agent focused or opened: bound when it is in front (activation can lag the call). */
let pending: (WindowQuery & { opened?: boolean }) | null = null;
/** The window in front was brought up by the agent (window focus, open_app): it may be an AI-assistant app. */
let leaseExplicit = false;
/** The name of an app the agent launched that surfaced no window: only a window of that app is the agent's doing. */
let openedName: string | null = null;
/** When the agent's last focus-moving input or focus call ended. */
let movedAt = 0;
/** The window the agent last acted in: an input, or an act by name on the window in front. A new read each time. */
let acted: Foreground | undefined;
/**
 * The window the outline goes around and the pill names: the one the agent's last input, or act by name on the window in
 * front, went to, or the one it focused or opened since. Not the lease: an act by name does not take the foreground, so it must not change what input is refused.
 */
let working: Foreground | undefined;
/**
 * The agent's windows (Plan (h)): the ones it opened, focused, worked in, or acted in by name or process. The lease above is
 * the one in front; input may also go to any other window in this set, and to no window outside it. The most recent few.
 */
const agentSet: Foreground[] = [];
const AGENT_WINDOWS_MAX = 8;
function remember(f: Foreground): void {
  if (isOwnUiPid(f.processId)) return;   // the pill, the outline: the user's controls, never a window the agent works in
  const at = agentSet.findIndex(w => sameTarget(w, f));
  const old = at >= 0 ? agentSet.splice(at, 1)[0] : undefined;
  agentSet.push({ ...f, handle: f.handle ?? old?.handle });
  if (agentSet.length > AGENT_WINDOWS_MAX) agentSet.shift();
}
/** The windows the agent has opened or worked in, oldest first. */
export function agentWindows(): readonly { processId: number; processName: string; appName?: string; handle?: number | string }[] {
  return agentSet.map(({ processId, processName, appName, handle }) => ({ processId, processName, appName, handle }));
}
/** Is this window (by handle, or by process) one of the agent's? */
export function isAgentWindow(q: { handle?: number | string; processId?: number }): boolean {
  return agentSet.some(w => (q.handle !== undefined && w.handle !== undefined && Number(w.handle) === Number(q.handle))
    || (q.processId !== undefined && (w.processId === q.processId || w.hostedProcessId === q.processId)));
}

/**
 * How long after the agent's own focus-moving input a new window in front is still its doing (a launch, a dialog, an
 * activation that lags). Past it, a change is the user's. The issue's switch came during a 30 s wait.
 */
const OWN_MOVE_MS = 5_000;
/** How long the next input waits for a window the agent just focused to come to the front. */
const FOCUS_ARRIVAL_MS = 1_000;

function resetBinding(): void { lease = undefined; acted = undefined; working = undefined; pending = null; movedAt = 0; leaseExplicit = false; openedName = null; agentSet.length = 0; }

const platformForeground = async (): Promise<Foreground | null> => {
  const { getPlatform } = await import('../platform');
  const w = await (await getPlatform()).getActiveWindow();
  return w && w.processId ? { processId: w.processId, processName: w.processName || `pid ${w.processId}`, appName: w.appName, title: w.title || undefined, handle: w.handle, guessed: w.guessed, hostedProcessId: w.hostedProcessId, hostedProcessName: w.hostedProcessName, bounds: w.bounds } : null;
};
// Off under the test runner unless a test sets a reader: a unit test must not start the real platform to ask.
let readForeground: () => Promise<Foreground | null> = process.env.VITEST ? async () => null : platformForeground;
type ListedWindow = { processId: number; handle?: number | string; processName: string; appName?: string; hostedProcessId?: number; hostedProcessName?: string; hostedAppName?: string };
let readWindows: () => Promise<ListedWindow[]> = process.env.VITEST ? async () => [] : async () => {
  const { getPlatform } = await import('../platform');
  return (await getPlatform()).listWindows();
};

/** The window in front now, a fresh read; null when it cannot be read. */
export const foregroundNow = (): Promise<Foreground | null> => readForeground().catch(() => null);

export function __setForegroundReaderForTests(f: (() => Promise<Foreground | null>) | null, reset = true): void {
  if (f) readForeground = f;
  if (reset) resetBinding();
}

export function __setWindowsReaderForTests(f: () => Promise<ListedWindow[]>): void {
  readWindows = f;
  pidNames.clear();
}

// A process name is the app's to choose (macOS localizedName, a Linux WM_CLASS): quoted like any other screen text.
// A Store app is named as the app its frame hosts: "ApplicationFrameHost (pid N)" is the same words for Calculator and Settings.
const name = (f: Foreground) => f.hostedProcessId
  ? `${quoteScreenText(String(f.appName ?? f.processName ?? ''))} (pid ${f.hostedProcessId})`
  : `${quoteScreenText(String(f.processName ?? ''))} (pid ${f.processId})`;
/**
 * Are these two foreground reads the same app? By the app's own process: for a Store app that is the process its frame
 * HOSTS (frame-host.ts), because every Store app's window belongs to the one ApplicationFrameHost process. Comparing
 * the window's process alone, a switch from Calculator to Settings between two calls looked like no switch at all,
 * and the next input went to Settings. The same window handle is the same window whatever it hosts by now (an app
 * still starting has no hosted process yet).
 */
const sameTarget = (a: Foreground, b: Foreground): boolean => {
  if ((a.hostedProcessId ?? a.processId) === (b.hostedProcessId ?? b.processId)) return true;
  // Both say which app they host, and they differ: another app, even in the very same frame window (a frame can come
  // to host another app, and a handle can be reused).
  if (a.hostedProcessId !== undefined && b.hostedProcessId !== undefined) return false;
  // One of them does not know its app yet (still starting): the same window of the same process is the same window.
  return a.handle !== undefined && a.handle === b.handle && a.processId === b.processId;
};

/**
 * The process an act is about to go to, verified now. `decided` is the fence's own answer when there is a fence. With
 * no fence: an ordinary window is its own process (this read IS the fresh one); a Store app frame is asked about again,
 * fresh, because what `now` carries may be the display cache's.
 */
async function verifiedPid(now: Foreground, decided: number | undefined): Promise<number | undefined> {
  if (decided !== undefined) return decided;
  if (!isFrameHost(now.processName)) return now.processId;
  return (await freshHostedAppOf(now).catch(() => undefined))?.processId;
}
const lower = (s: string) => s.toLowerCase().replace(/\.(exe|app)$/, '');
// A handle is that one window: only Windows puts one in a query (on macOS a window's handle is often its pid). A Store
// app's frame also answers to the app's own names, the ones the Windows adapter found it by (frame-host.ts processNamesOf).
const matches = (q: WindowQuery, f: Foreground) =>
  (q.handle !== undefined && f.handle !== undefined && Number(f.handle) === q.handle)
  || (q.processId !== undefined && (q.processId === f.processId || q.processId === f.hostedProcessId))
  || (!!q.processName && [f.processName, ...(f.hostedProcessId ? [f.hostedProcessName, f.appName] : [])]
    .some(n => !!n && lower(n).includes(lower(q.processName!))))
  || (!!q.title && !!f.title && windowTextIncludes(f.title, q.title));

function stopCheck(): void {
  if (isStopped()) throw new Error(STOPPED_TEXT);
}

/**
 * A read or an act by element goes to the process it names or, with none named, to the window in front. Neither may
 * be clawdcursor's own UI. The built-in pill never takes the front outside a pause (and then every call is refused,
 * own-ui-guard.ts), so the window in front is only read when a host app named its own UI (CLAWD_OWN_UI_PIDS): its
 * window is in front right after the user clicked it, and "invoke Yes" with no process would press the user's button.
 */
async function notOwnUi(processId?: number): Promise<void> {
  if (processId !== undefined) {
    if (isOwnUiPid(processId)) throw new Error(`pid ${processId} is clawdcursor's own on-screen control — it is the user's, never read or acted on. Target the app instead.`);
    return;
  }
  if (!process.env.CLAWD_OWN_UI_PIDS && !process.env.CLAWD_OWN_UI_PIDS_FILE) return;
  const now = await readForeground().catch(() => null);
  if (now && (isOwnUiPid(now.processId) || isOwnUiPid(now.hostedProcessId))) {
    throw new Error('the window in front is clawdcursor\'s own on-screen control — nothing was sent. Focus your target window first: window {"action":"focus","title":"…"}.');
  }
}

/** One foreground read per input, before it. */
async function before(): Promise<void> {
  stopCheck();
  await turn(true);
  let now = await readForeground().catch(() => null);
  // The fence (CLAWD_FENCE_PIDS): with no foreground to check, nothing is sent.
  if (!now) await fenceInput(null);
  if (!now) return;  // this OS cannot say what is in front: nothing to compare
  // A window the agent just focused may take a moment to come up (macOS activation, a window manager).
  for (const until = Date.now() + FOCUS_ARRIVAL_MS; pending && !matches(pending, now) && Date.now() < until;) {
    await new Promise(r => setTimeout(r, 100));
    now = (await readForeground().catch(() => null)) ?? now;
  }
  const decided = await fenceInput(now);   // the pointer's own bounds are checked where it moves and presses (pointer-guard.ts)
  if (isOwnUiPid(now.processId)) throw new Error(`foreground changed: clawdcursor's own on-screen control is in front, not ${lease ? name(lease) : 'an app'} — nothing was sent. Wait for the user, then focus your window with window {"action":"focus"}.`);
  const ownMove = Date.now() - movedAt < OWN_MOVE_MS;
  let explicit = false;
  if (pending) {
    // Waited for it above: if it is still not in front, the focus did not take (or the user switched), whatever the clock says.
    if (!matches(pending, now)) {
      throw new Error(`foreground changed: you ${pending.opened ? 'opened' : 'focused'} ${quoteScreenText(pending.processName ?? pending.title ?? (pending.processId !== undefined ? `pid ${pending.processId}` : `window ${pending.handle}`))}, but ${name(now)} is in front — nothing was sent. Focus it again.`);
    }
    pending = null;
    explicit = true;
  } else if (lease && !sameTarget(lease, now) && !ownMove && !agentSet.some(w => sameTarget(w, now))) {
    throw new Error(
      `foreground changed: you were working in ${name(lease)}, but ${name(now)} is in front now — the user may have switched. ` +
      'Nothing was sent. If you meant to work there, focus it with window {"action":"focus"} first; otherwise focus your own window again.');
  }
  explicit = explicit || openedBy(now) || (leaseExplicit && !!lease && sameTarget(lease, now));
  await refuseAiHost(now, explicit);
  openedName = null;
  leaseExplicit = explicit;
  const at: Foreground = { ...now, actPid: await verifiedPid(now, decided) };
  lease = at;
  acted = at;
  working = at;
  remember(at);
}

const AI_HOST_REFUSAL = (n: string, kind: 'list' | 'ancestor') =>
  `the window in front is ${kind === 'list' ? `${n}, an AI assistant` : `the app this agent runs in (${n})`} — nothing was sent. ` +
  'Focus your target window first: window {"action":"focus","title":"…"}. ' +
  "If this assistant's window IS your target, focus it with window focus and retry.";

/**
 * Is this error one of the guard's refusals (stopped, paused by the user, foreground changed, an AI assistant in front, held by confirm mode)? A tool that catches
 * errors from the input layer to try another way must let these through unchanged: the call was refused, it did not fail.
 */
export function isGuardRefusal(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return m.startsWith('stopped by the user') || m.startsWith('paused by the user') || m.startsWith('the user is using the computer') || m.startsWith('foreground changed: ') || isFenceRefusal(err)
    || / is clawdcursor's own on-screen control — /.test(m)
    || m.startsWith('held: confirm mode') || m.startsWith('not confirmed: confirm mode')
    || /^the window in front is .+ — nothing was sent. Focus your target window first/.test(m);
}

/**
 * An AI assistant's own window (the chat the agent runs in) takes nothing the agent did not ask for: a model that typed before
 * focusing anything sent its text there (eval 2026-11-08). Focusing or opening the app is asking. A foreground the adapter
 * only guessed at (Linux without xdotool) is not evidence of anything, so it never blocks.
 */
async function refuseAiHost(now: Foreground, explicit: boolean): Promise<void> {
  if (explicit || now.guessed) return;
  const kind = await aiHostKind(now);
  if (kind) throw new Error(AI_HOST_REFUSAL(quoteScreenText(String(now.processName ?? '')), kind));
}

/** A launch that surfaced no window excuses a window of the app it started, by name, and nothing else. */
const openedBy = (now: Foreground): boolean => sameApp(openedName, now.processName);

/**
 * An act on an element by name (accessibility set_value / invoke / toggle / select) with no process given acts on the window
 * in front: when that is an AI assistant the agent did not focus or open, it is the chat. A target in another process is
 * the agent's own choice.
 */
async function byName(processId?: number): Promise<void> {
  stopCheck();
  await turn(false);
  const now = await readForeground().catch(() => null);
  // The fence: the process named, else the window in front, must be inside it. Checked before the background-process return below.
  let decided: number | undefined;
  if (processId !== undefined) { await fenceCheck('act by name', { pid: processId }); if (fenceActive()) decided = processId; }
  else decided = await fenceInput(now);
  // A target in another process is the agent's own choice. (An element of a Store app may be named by the app's process or by its frame's.)
  // The session log names that process's app, not the one in front (#365).
  if (!now || (processId !== undefined && processId !== now.processId && processId !== now.hostedProcessId)) {
    if (processId !== undefined) await byProcess(processId);
    return;
  }
  if (isOwnUiPid(now.processId)) return;   // the user clicked or dragged the pill: nothing of the agent's, so never the working window
  const explicit = (!!pending && matches(pending, now)) || openedBy(now) || (leaseExplicit && !!lease && sameTarget(lease, now));
  await refuseAiHost(now, explicit);
  const at: Foreground = { ...now, actPid: await verifiedPid(now, decided) };
  acted = at;
  working = at;
  // Named by process: the agent's own choice of window. With none given it is just the window in front, nobody's but the user's.
  if (processId !== undefined) remember(at);
}

/** App names by process id: a process keeps its name, so the window list is read once per process. */
// shortcut: a pid the OS reuses for another app keeps the old name; key by pid + start time if that ever shows up in a log.
const pidNames = new Map<number, { processName: string; appName?: string; handle?: number | string }>();

/**
 * An act that went to a process, not to the window in front — a by-name act on a background window, a page act over CDP
 * (#365): the session log names that process's app (as on the pill), never the app that happens to be in front. A Store
 * app is named as the app its frame hosts. It is where the agent works now, so the outline goes round it and the pill names
 * it (background mode: an agent that never touched the window in front still gets its frame, macOS run 2026-11-18). The
 * window input is bound to (the lease) stays where it is.
 */
async function byProcess(pid: number | null | undefined): Promise<void> {
  if (!pid || isOwnUiPid(pid)) return;
  let n = pidNames.get(pid);
  if (!n) {
    const w = (await readWindows().catch(() => [])).find(w => w.processId === pid || w.hostedProcessId === pid);
    if (w) {
      n = w.hostedProcessId === pid
        ? { processName: w.hostedProcessName || w.processName, appName: w.hostedAppName || w.appName, handle: w.handle }
        : { processName: w.processName, appName: w.appName, handle: w.handle };
      pidNames.set(pid, n);
    }
  }
  acted = { processId: pid, processName: n?.processName || `pid ${pid}`, appName: n?.appName, actPid: pid };
  working = { ...acted, handle: n?.handle };
  remember(working);
}

/**
 * The app the agent last acted in, by input or by name (the session log names it). Each act keeps its own foreground
 * read, so the same object back means the agent did not act on the window in front in between.
 */
export function actedIn(): { processName: string; appName?: string; processId: number; handle?: number | string; hostedProcessId?: number; actPid?: number } | undefined {
  return acted;
}

/** The app the agent's last input or act by name went to (the pill names it), or undefined before the first one. */
export function workingIn(): { processName: string; appName?: string } | undefined {
  return working;
}

/** The window the agent's last input or act by name went to (the outline goes around it), or undefined before the first one. */
export function workingWindow(): { processId: number; handle?: number | string } | undefined {
  return working && { processId: working.processId, handle: working.handle };
}

/** After the input: no read. A focus-moving one opens the window in which a new window in front is the agent's own doing. */
function done(movesFocus: boolean): void {
  if (movesFocus) movedAt = Date.now();
}

/**
 * The window the agent just focused or opened is where it works now: the outline and the pill go to it once it is in
 * front, with no act needed (macOS eval 2026-11-10: after open_app or window focus the outline stayed on the previous app,
 * hidden, through every read that followed). Only `working` moves: the lease, and what the next input is refused for,
 * are still decided by before().
 */
async function arrived(): Promise<void> {
  const q = pending;
  const mine = (f: Foreground) => (q ? matches(q, f) : openedBy(f));
  for (let tries = FOCUS_ARRIVAL_MS / 100; ; tries--) {
    const now = await readForeground().catch(() => null);
    if (!now) return;
    if (mine(now) && !isOwnUiPid(now.processId)) { working = now; remember(now); return; }
    if (tries <= 0 || pending !== q) return;
    await new Promise(r => setTimeout(r, 100));
  }
}

/** The agent focused a window: the next input binds to it, not to whatever else is in front. */
async function focused(q: WindowQuery): Promise<void> {
  pending = q;
  movedAt = Date.now();
  await arrived();
}

/**
 * The agent launched an app: its next input binds to the launched window, matched by pid OR title — the window often
 * belongs to another process than the one started (a UWP host, a browser's existing instance, an Electron launcher), and
 * the adapters report the title of the window that came up. When a launch reports neither, the next input binds to
 * whatever opens; an AI-assistant window is excused only if it is the app that was launched (`appName`).
 */
async function launched(r?: { pid?: number; title?: string }, appName?: string): Promise<void> {
  movedAt = Date.now();
  if (r?.pid || r?.title) pending = { processId: r.pid || undefined, title: r.title || undefined, opened: true };
  else {
    lease = undefined;
    working = undefined;
    pending = null;
    openedName = appName?.trim() || null;
  }
  await arrived();
}

/** A wait: the agent declares it does nothing, so a window that comes up during it is the user's, not the agent's (#294). */
function settle(): void {
  movedAt = 0;
}

setInputGuard({ stopCheck, turn, before, done, focused, launched, byName, byProcess, notOwnUi });

/**
 * What an act that just ran went to, for the session log: the app's name as on the pill, the VERIFIED process (`actPid`)
 * and the window handle. `since` is `actedIn()` from before the call: the same object back means this call did not act
 * on a window, and there is nothing to record. A direct call and each step of a batch are recorded through this.
 */
export function actRecord(since: unknown): { app?: string; appPid?: number; appHandle?: number } {
  const w = acted;
  if (!w || w === since) return {};
  const id = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);
  const app = appLabel(w.processName, w.appName);
  const appPid = id(w.actPid);
  const appHandle = id(w.handle);
  return { ...(app ? { app } : {}), ...(appPid ? { appPid } : {}), ...(appHandle ? { appHandle } : {}) };
}
