/**
 * Proof that what the agent acts on is the benchmark's own fixture: by PROCESS, never by an app name alone.
 *
 * A fixture is the process (or processes) the benchmark started for this task, and their children. After each acting
 * call the watchdog asks: does the keyboard focus belong to one of them? For a Store app the window belongs to
 * ApplicationFrameHost, so the frame counts only when it hosts a process the benchmark started and has the exact title.
 * Every probe fails CLOSED: no answer means "not ours".
 */
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { FENCE_ENV, inFence } from '../../src/core/fence';
import { POWERSHELL, tryRun } from './proc';

/** The fence's variable for these pids, exactly as the daemon is started with it (isolated.ts). An empty list fences everything out. */
export const fenceEnv = (pids: number[]): NodeJS.ProcessEnv => ({ [FENCE_ENV]: pids.join(',') || 'none' });

/**
 * Was the process an act went to one the benchmark started, or a child of one? The fence's own answer (`inFence`) over
 * the pids the daemon was fenced to: the watchdog and the fence share one identity and cannot disagree. Asking again
 * by command line, as the watchdog did, made a second identity that a slow scan could answer with nothing.
 */
export const inFixtureFence = (fencePids: number[]) => (pid: number): Promise<boolean> => inFence(pid, fenceEnv(fencePids));

export interface Focus {
  /** The focused process, then its parent, grandparent, ... */
  chain: number[];
  /** A Store app frame in front: the processes it hosts and its title. */
  frame?: { hosted: number[]; title: string };
}

const pidsOf = (s: string) => s.trim().split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0);

/** The output of fixtures/apps/focus-probe.ps1. */
export function parseFocus(out: string): Focus | null {
  const line = (key: string) => out.split(/\r?\n/).find(l => l.startsWith(`${key} `) || l === key)?.slice(key.length + 1);
  const chain = line('chain');
  if (chain === undefined || !pidsOf(chain).length) return null;
  const hosted = line('frame');
  return { chain: pidsOf(chain), ...(hosted !== undefined ? { frame: { hosted: pidsOf(hosted), title: (line('title') ?? '').trim() } } : {}) };
}

/** Does the focus belong to a process the benchmark started (`roots`), or to a child of one? */
export function ownsFocus(focus: Focus | null, roots: number[], frameTitle?: string): boolean {
  if (!focus || !roots.length) return false;
  if (focus.chain.some(p => roots.includes(p))) return true;
  // The frame of a Store app: only with the exact title, and only when it hosts a process of ours.
  return !!focus.frame && frameTitle !== undefined && focus.frame.title === frameTitle && focus.frame.hosted.some(p => roots.includes(p));
}

/** Which process has the focus now. null when it cannot be told (the guard then stops the run). */
export async function readFocus(platform: string = process.platform): Promise<Focus | null> {
  if (platform === 'win32') {
    const out = await tryRun(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'fixtures', 'apps', 'focus-probe.ps1')]);
    return out === null ? null : parseFocus(out);
  }
  const front = platform === 'darwin'
    ? await tryRun('osascript', ['-e', 'tell application "System Events" to get unix id of first process whose frontmost is true'])
    : await tryRun('xdotool', ['getactivewindow', 'getwindowpid']);
  const pid = front === null ? NaN : Number(front.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const chain = [pid];
  for (let p = pid; chain.length < 12;) {
    const parent = Number((await tryRun('ps', ['-o', 'ppid=', '-p', String(p)]))?.trim());
    if (!Number.isInteger(parent) || parent <= 1 || chain.includes(parent)) break;
    chain.push(parent);
    p = parent;
  }
  return { chain };
}

export const portOpen = (port: number) => new Promise<boolean>(resolve => {
  const s = net.connect({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

/** The debug port a browser the OWNER put on the wire would use: clawdcursor tries it after its own. */
export const USER_CDP_PORT = 9223;

/** The port a Chromium instance says it listens on: the first line of DevToolsActivePort in ITS profile directory. */
export function profileDebugPort(profileDir: string): number | null {
  try {
    const port = Number(fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch { return null; }
}

/**
 * Is the only browser clawdcursor's `browser` tool can reach the fixture's own instance? True when
 *   - nothing listens on the owner's debug port (clawdcursor tries it second),
 *   - the browser running on the fixture's temp profile says, in that profile, that it listens on the fixture's port
 *     (a port has one listener, so whatever answers there is that browser),
 *   - a process on that profile is alive, and the port answers.
 */
export async function cdpIsFixture(o: { cdpPort: number; profileDir: string; browserPids: () => Promise<number[]> | number[] }): Promise<boolean> {
  if (await portOpen(USER_CDP_PORT)) return false;
  if (profileDebugPort(o.profileDir) !== o.cdpPort) return false;
  if (!(await o.browserPids()).length) return false;
  return portOpen(o.cdpPort);
}
