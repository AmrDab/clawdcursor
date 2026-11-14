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
import { fenceActive, fenceCheck, fenceInput, isFenceRefusal } from './fence';
import { freshHostedAppOf, isFrameHost } from '../platform/frame-host';
import { appLabel } from './app-label';
import * as fs from 'fs';
import { quoteScreenText } from './untrusted-screen-content';
import * as path from 'path';
import { DATA_DIR } from '../paths';
import { logger } from './observability/logger';
import { setInputGuard, isOwnUiPid, type WindowQuery } from '../platform/pointer-guard';
import { windowTextIncludes } from '../platform/window-text';
import { aiHostKind, sameApp } from './ai-hosts';

// Off under the test runner unless a test points it somewhere: tests must not write into the user's real data dir.
let dir: string | null = process.env.VITEST ? null : DATA_DIR;
const stopFile = () => (dir ? path.join(dir, 'stopped.json') : null);
/** Only where the stop file cannot be written: then this process at least stays stopped. Otherwise the file is the truth. */
let stoppedHere = false;

export function __setControlDirForTests(d: string | null): void { dir = d; stoppedHere = false; resetBinding(); }

/** The user took control back. Every clawdcursor process sees it; it survives a restart. */
export function stopControl(by: string): void {
  logger.warn('control.stop', { by, pid: process.pid });
  const file = stopFile();
  if (!file || !dir) { stoppedHere = true; return; }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ by, pid: process.pid, at: Date.now() }));
  } catch { stoppedHere = true; }
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
 */
export function resumeControl(by: string): void {
  logger.info('control.resume', { by, pid: process.pid });
  stoppedHere = false;
  const file = stopFile();
  if (file) { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } }
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

// ── The window the agent is working in ──

interface Foreground { processId: number; processName: string; appName?: string; title?: string; handle?: number | string; guessed?: boolean;
  /** For the fence (fence.ts): the app a Store app's frame hosts, and where the window is. */
  hostedProcessId?: number; bounds?: { x: number; y: number; width: number; height: number };
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
 * How long after the agent's own focus-moving input a new window in front is still its doing (a launch, a dialog, an
 * activation that lags). Past it, a change is the user's. The issue's switch came during a 30 s wait.
 */
const OWN_MOVE_MS = 5_000;
/** How long the next input waits for a window the agent just focused to come to the front. */
const FOCUS_ARRIVAL_MS = 1_000;

function resetBinding(): void { lease = undefined; acted = undefined; working = undefined; pending = null; movedAt = 0; leaseExplicit = false; openedName = null; }

const platformForeground = async (): Promise<Foreground | null> => {
  const { getPlatform } = await import('../platform');
  const w = await (await getPlatform()).getActiveWindow();
  return w && w.processId ? { processId: w.processId, processName: w.processName || `pid ${w.processId}`, appName: w.appName, title: w.title || undefined, handle: w.handle, guessed: w.guessed, hostedProcessId: w.hostedProcessId, bounds: w.bounds } : null;
};
// Off under the test runner unless a test sets a reader: a unit test must not start the real platform to ask.
let readForeground: () => Promise<Foreground | null> = process.env.VITEST ? async () => null : platformForeground;
type ListedWindow = { processId: number; processName: string; appName?: string; hostedProcessId?: number; hostedProcessName?: string; hostedAppName?: string };
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
const matches = (q: WindowQuery, f: Foreground) =>
  (q.processId !== undefined && (q.processId === f.processId || q.processId === f.hostedProcessId))
  || (!!q.processName && lower(f.processName).includes(lower(q.processName)))
  || (!!q.title && !!f.title && windowTextIncludes(f.title, q.title));

function stopCheck(): void {
  if (isStopped()) throw new Error(STOPPED_TEXT);
}

/** One foreground read per input, before it. */
async function before(): Promise<void> {
  stopCheck();
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
      throw new Error(`foreground changed: you ${pending.opened ? 'opened' : 'focused'} ${quoteScreenText(pending.processName ?? pending.title ?? `pid ${pending.processId}`)}, but ${name(now)} is in front — nothing was sent. Focus it again.`);
    }
    pending = null;
    explicit = true;
  } else if (lease && !sameTarget(lease, now) && !ownMove) {
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
}

const AI_HOST_REFUSAL = (n: string, kind: 'list' | 'ancestor') =>
  `the window in front is ${kind === 'list' ? `${n}, an AI assistant` : `the app this agent runs in (${n})`} — nothing was sent. ` +
  'Focus your target window first: window {"action":"focus","title":"…"}. ' +
  "If this assistant's window IS your target, focus it with window focus and retry.";

/**
 * Is this error one of the guard's refusals (stopped, foreground changed, an AI assistant in front, held by confirm mode)? A tool that catches
 * errors from the input layer to try another way must let these through unchanged: the call was refused, it did not fail.
 */
export function isGuardRefusal(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return m.startsWith('stopped by the user') || m.startsWith('foreground changed: ') || isFenceRefusal(err)
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
  const explicit = (!!pending && matches(pending, now)) || openedBy(now) || (leaseExplicit && !!lease && sameTarget(lease, now));
  await refuseAiHost(now, explicit);
  const at: Foreground = { ...now, actPid: await verifiedPid(now, decided) };
  acted = at;
  working = at;
}

/** App names by process id: a process keeps its name, so the window list is read once per process. */
// shortcut: a pid the OS reuses for another app keeps the old name; key by pid + start time if that ever shows up in a log.
const pidNames = new Map<number, { processName: string; appName?: string }>();

/**
 * An act that went to a process, not to the window in front — a by-name act on a background window, a page act over CDP
 * (#365): the session log names that process's app (as on the pill), never the app that happens to be in front. A Store
 * app is named as the app its frame hosts. Nothing else changes: the window input is bound to stays where it is.
 */
async function byProcess(pid: number | null | undefined): Promise<void> {
  if (!pid) return;
  let n = pidNames.get(pid);
  if (!n) {
    const w = (await readWindows().catch(() => [])).find(w => w.processId === pid || w.hostedProcessId === pid);
    if (w) {
      n = w.hostedProcessId === pid
        ? { processName: w.hostedProcessName || w.processName, appName: w.hostedAppName || w.appName }
        : { processName: w.processName, appName: w.appName };
      pidNames.set(pid, n);
    }
  }
  acted = { processId: pid, processName: n?.processName || `pid ${pid}`, appName: n?.appName, actPid: pid };
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
    if (mine(now)) { working = now; return; }
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

setInputGuard({ stopCheck, before, done, focused, launched, byName, byProcess });

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
