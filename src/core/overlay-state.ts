/**
 * Every clawdcursor process publishes its overlay (pill / glow pids, and whether a pause is up) so the OTHERS honour it: the
 * daemon's pause prompt is the user's even to a separate stdio MCP server, which has no pids or pause of its own (review of
 * the own-UI guard, 2026-10-24). One file per process — `<DATA_DIR>/overlay/<pid>.json` — so writers never race; a file
 * whose writer has exited is ignored.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../paths';

export interface OverlayState { pids: number[]; paused: boolean }
/** The merged view also names a process whose pause is up, for the refusal text. */
export interface ForeignOverlayState extends OverlayState { pausedBy?: number }

// A writer that died without its exit hook (force-kill, power loss) leaves its file behind, and its pid can be reused. While a
// process has anything on screen it rewrites its file every HEARTBEAT_MS; readers ignore one older than STALE_MS.
const HEARTBEAT_MS = 5_000;
// Generous: a live writer whose event loop stalls (a long sync call, sleep/wake) must not have its real pause ignored.
const STALE_MS = 45_000;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let last: OverlayState = { pids: [], paused: false };

// Off under the test runner unless a test points it somewhere: tests must not write into the user's real data dir.
let dir: string | null = process.env.VITEST ? null : path.join(DATA_DIR, 'overlay');
const own = () => (dir ? path.join(dir, `${process.pid}.json`) : null);

export function __setOverlayStateDirForTests(d: string | null): void { dir = d; }

/** Never throws: a failed write leaves the other processes without this one's overlay, not this process broken. */
export function publishOverlayState(s: OverlayState): void {
  last = s;
  const empty = !s.pids.length && !s.paused;
  if (empty && heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  if (!empty && !heartbeat && dir) {
    heartbeat = setInterval(() => write(last), HEARTBEAT_MS);
    heartbeat.unref?.();
  }
  write(s);
}

function write(s: OverlayState): void {
  const file = own();
  if (!file || !dir) return;
  try {
    if (!s.pids.length && !s.paused) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...s, at: Date.now() }));
    fs.renameSync(tmp, file);
  } catch { /* best effort */ }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** The overlays of OTHER live clawdcursor processes, merged. */
// Read on every call, never cached: a timestamp- or TTL-keyed cache hid a pause published in the same clock tick (NTFS ~2 ms,
// HFS+ 1 s) for up to its lifetime. The directory holds a few tiny files; reading them costs microseconds.
export function foreignOverlayState(): ForeignOverlayState {
  const state: ForeignOverlayState = { pids: [], paused: false };
  if (dir) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { /* no overlays yet */ }
    for (const name of names) {
      const writer = Number(/^(\d+)\.json$/.exec(name)?.[1]);
      if (!writer || writer === process.pid || !alive(writer)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Partial<OverlayState> & { at?: number };
        if (typeof s.at !== 'number' || Date.now() - s.at > STALE_MS) continue;  // its writer stopped beating
        if (Array.isArray(s.pids)) state.pids.push(...s.pids.filter((p): p is number => Number.isInteger(p)));
        if (s.paused === true) { state.paused = true; state.pausedBy ??= writer; }
      } catch { /* half-written or gone */ }
    }
  }
  return state;
}

/** Resolves once no other clawdcursor process has a pause up (or the signal aborts): a second prompt never stacks on one. */
export async function untilNoForeignPause(signal?: AbortSignal, pollMs = 500): Promise<void> {
  while (foreignOverlayState().paused && !signal?.aborted) await new Promise(r => setTimeout(r, pollMs));
}
