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
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../paths';
import { setInputGuard, isOwnUiPid, type WindowQuery } from '../platform/pointer-guard';

// Off under the test runner unless a test points it somewhere: tests must not write into the user's real data dir.
let dir: string | null = process.env.VITEST ? null : DATA_DIR;
const stopFile = () => (dir ? path.join(dir, 'stopped.json') : null);
/** Only where the stop file cannot be written: then this process at least stays stopped. Otherwise the file is the truth. */
let stoppedHere = false;

export function __setControlDirForTests(d: string | null): void { dir = d; stoppedHere = false; resetBinding(); }

/** The user took control back. Every clawdcursor process sees it; it survives a restart. */
export function stopControl(by: string): void {
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
export function resumeControl(): void {
  stoppedHere = false;
  const file = stopFile();
  if (file) { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } }
}

export const STOPPED_TEXT =
  'stopped by the user — they took control back, and nothing runs until they give it back. Do not retry. ' +
  'To ask for it, call system {"action":"pause_for_user","message":"<what you want to do next>"}: their Resume click gives control back.';

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

interface Foreground { processId: number; processName: string; title?: string }
/** undefined = not bound yet: the next input binds to whatever is in front. */
let lease: Foreground | undefined;
/** A window the agent focused: bound when it is in front (activation can lag the focus call). */
let pending: WindowQuery | null = null;
/** When the agent's last focus-moving input or focus call ended. */
let movedAt = 0;
/**
 * How long after the agent's own focus-moving input a new window in front is still its doing (a launch, a dialog, an
 * activation that lags). Past it, a change is the user's. The issue's switch came during a 30 s wait.
 */
const OWN_MOVE_MS = 5_000;
/** How long the next input waits for a window the agent just focused to come to the front. */
const FOCUS_ARRIVAL_MS = 1_000;

function resetBinding(): void { lease = undefined; pending = null; movedAt = 0; }

const platformForeground = async (): Promise<Foreground | null> => {
  const { getPlatform } = await import('../platform');
  const w = await (await getPlatform()).getActiveWindow();
  return w && w.processId ? { processId: w.processId, processName: w.processName || `pid ${w.processId}`, title: w.title || undefined } : null;
};
// Off under the test runner unless a test sets a reader: a unit test must not start the real platform to ask.
let readForeground: () => Promise<Foreground | null> = process.env.VITEST ? async () => null : platformForeground;

export function __setForegroundReaderForTests(f: (() => Promise<Foreground | null>) | null, reset = true): void {
  if (f) readForeground = f;
  if (reset) resetBinding();
}

const name = (f: Foreground) => `${f.processName} (pid ${f.processId})`;
const lower = (s: string) => s.toLowerCase().replace(/\.(exe|app)$/, '');
const matches = (q: WindowQuery, f: Foreground) =>
  (q.processId !== undefined && q.processId === f.processId)
  || (!!q.processName && lower(f.processName).includes(lower(q.processName)))
  || (!!q.title && !!f.title && f.title.toLowerCase().includes(q.title.toLowerCase()));

function stopCheck(): void {
  if (isStopped()) throw new Error(STOPPED_TEXT);
}

/** One foreground read per input, before it. */
async function before(): Promise<void> {
  stopCheck();
  let now = await readForeground().catch(() => null);
  if (!now) return;  // this OS cannot say what is in front: nothing to compare
  // A window the agent just focused may take a moment to come up (macOS activation, a window manager).
  for (const until = Date.now() + FOCUS_ARRIVAL_MS; pending && !matches(pending, now) && Date.now() < until;) {
    await new Promise(r => setTimeout(r, 100));
    now = (await readForeground().catch(() => null)) ?? now;
  }
  if (isOwnUiPid(now.processId)) throw new Error(`foreground changed: clawdcursor's own on-screen control is in front, not ${lease ? name(lease) : 'an app'} — nothing was sent. Wait for the user, then focus your window with window {"action":"focus"}.`);
  const ownMove = Date.now() - movedAt < OWN_MOVE_MS;
  if (pending) {
    // Waited for it above: if it is still not in front, the focus did not take (or the user switched), whatever the clock says.
    if (!matches(pending, now)) {
      throw new Error(`foreground changed: you focused ${pending.processName ?? pending.title ?? `pid ${pending.processId}`}, but ${name(now)} is in front — nothing was sent. Focus it again.`);
    }
    pending = null;
  } else if (lease && lease.processId !== now.processId && !ownMove) {
    throw new Error(
      `foreground changed: you were working in ${name(lease)}, but ${name(now)} is in front now — the user may have switched. ` +
      'Nothing was sent. If you meant to work there, focus it with window {"action":"focus"} first; otherwise focus your own window again.');
  }
  lease = now;
}

/** After the input: no read. A focus-moving one opens the window in which a new window in front is the agent's own doing. */
function done(movesFocus: boolean): void {
  if (movesFocus) movedAt = Date.now();
}

/** The agent focused a window: the next input binds to it, not to whatever else is in front. */
function focused(q: WindowQuery): void {
  pending = q;
  movedAt = Date.now();
}

/**
 * The agent launched an app: its next input binds to the launched window, matched by pid OR title — the window often
 * belongs to another process than the one started (a UWP host, a browser's existing instance, an Electron launcher), and
 * the adapters report the title of the window that came up. When a launch reports neither, the next input binds to
 * whatever opens.
 */
function launched(r?: { pid?: number; title?: string }): void {
  movedAt = Date.now();
  if (r?.pid || r?.title) { pending = { processId: r.pid || undefined, title: r.title || undefined }; return; }
  lease = undefined;
  pending = null;
}

/** A wait: the agent declares it does nothing, so a window that comes up during it is the user's, not the agent's (#294). */
function settle(): void {
  movedAt = 0;
}

setInputGuard({ stopCheck, before, done, focused, launched });
