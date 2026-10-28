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
 *  - STOPPED is a file shared by every clawdcursor process, set by any stop (the pill, `clawdcursor stop`) and outliving a
 *    restart. While it is set, own-ui-guard refuses every call except asking the user; only the user's Resume on a pause
 *    prompt (or `clawdcursor resume`) clears it — an agent cannot.
 *  - every synthetic key, type, click, drag and scroll first runs `guardInput` (pointer-guard.ts, called by both input
 *    layers): refused while stopped, and refused when the window in front is not the one the agent's own last input or
 *    focus left there — someone else moved focus in between. Nothing is sent; the agent is told what changed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../paths';
import { setInputGuard, isOwnUiPid } from '../platform/pointer-guard';

// Off under the test runner unless a test points it somewhere: tests must not write into the user's real data dir.
let dir: string | null = process.env.VITEST ? null : DATA_DIR;
const stopFile = () => (dir ? path.join(dir, 'stopped.json') : null);
let stoppedHere = false;  // in-process copy: a stop holds even where the file cannot be written

export function __setControlDirForTests(d: string | null): void { dir = d; stoppedHere = false; lease = undefined; }

/** The user took control back. Every clawdcursor process sees it; it survives a restart. */
export function stopControl(by: string): void {
  stoppedHere = true;
  const file = stopFile();
  if (!file || !dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ by, pid: process.pid, at: Date.now() }));
  } catch { /* the in-process flag still holds */ }
}

/** Read on every call, never cached: another process's stop must reach this one at once. */
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
  const end = Date.now() + ms;
  for (;;) {
    if (isStopped()) return true;
    const left = end - Date.now();
    if (left <= 0) return false;
    await new Promise(r => setTimeout(r, Math.min(left, 250)));
  }
}

// ── The window the agent is working in ──

interface Foreground { processId: number; processName: string }
/** undefined = not bound yet: the next input binds to whatever is in front. */
let lease: Foreground | undefined;

const platformForeground = async (): Promise<Foreground | null> => {
  const { getPlatform } = await import('../platform');
  const w = await (await getPlatform()).getActiveWindow();
  return w && w.processId ? { processId: w.processId, processName: w.processName || `pid ${w.processId}` } : null;
};
// Off under the test runner unless a test sets a reader: a unit test must not start the real platform to ask.
let readForeground: () => Promise<Foreground | null> = process.env.VITEST ? async () => null : platformForeground;

export function __setForegroundReaderForTests(f: (() => Promise<Foreground | null>) | null, reset = true): void {
  if (f) readForeground = f;
  if (reset) lease = undefined;
}

/** The agent focused or launched a window on purpose: its next input binds to whatever is in front then. */
export function rebindForeground(): void {
  lease = undefined;
}

const name = (f: Foreground) => `${f.processName} (pid ${f.processId})`;

async function before(): Promise<void> {
  if (isStopped()) throw new Error(STOPPED_TEXT);
  const now = await readForeground().catch(() => null);
  if (!now) return;  // this OS cannot say what is in front: nothing to compare
  if (isOwnUiPid(now.processId)) throw new Error(`foreground changed: clawdcursor's own on-screen control is in front, not ${lease ? name(lease) : 'an app'} — nothing was sent. Wait for the user, then focus your window with window {"action":"focus"}.`);
  if (lease && lease.processId !== now.processId) {
    throw new Error(
      `foreground changed: you were working in ${name(lease)}, but ${name(now)} is in front now — the user may have switched. ` +
      'Nothing was sent. If you meant to work there, focus it with window {"action":"focus"} first; otherwise focus your own window again.');
  }
  lease = now;
}

/** After the agent's own input: it may have moved focus itself (a click on another window, Return opening a dialog). */
async function after(): Promise<void> {
  const now = await readForeground().catch(() => null);
  if (now && !isOwnUiPid(now.processId)) lease = now;
}

setInputGuard({ before, after, rebind: rebindForeground });
