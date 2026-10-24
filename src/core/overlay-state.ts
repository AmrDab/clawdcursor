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

// Off under the test runner unless a test points it somewhere: tests must not write into the user's real data dir.
let dir: string | null = process.env.VITEST ? null : path.join(DATA_DIR, 'overlay');
const own = () => (dir ? path.join(dir, `${process.pid}.json`) : null);

export function __setOverlayStateDirForTests(d: string | null): void { dir = d; cache = null; }

/** Never throws: a failed write leaves the other processes without this one's overlay, not this process broken. */
export function publishOverlayState(s: OverlayState): void {
  const file = own();
  if (!file || !dir) return;
  try {
    if (!s.pids.length && !s.paused) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  } catch { /* best effort */ }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

// Every publish is a create, rename or delete in the directory, which moves its mtime: a cache keyed on it sees a new pause or
// pill on the very next call. The age limit only re-checks that writers are still alive — staler means refusing longer, never less.
let cache: { at: number; mtime: number; state: OverlayState } | null = null;
const LIVENESS_MS = 2_000;

/** The overlays of OTHER live clawdcursor processes, merged. */
export function foreignOverlayState(): OverlayState {
  let mtime = -1;
  try { if (dir) mtime = fs.statSync(dir).mtimeMs; } catch { /* no overlays yet */ }
  if (cache && cache.mtime === mtime && Date.now() - cache.at < LIVENESS_MS) return cache.state;
  const state: OverlayState = { pids: [], paused: false };
  if (dir) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { /* no overlays yet */ }
    for (const name of names) {
      const writer = Number(/^(\d+)\.json$/.exec(name)?.[1]);
      if (!writer || writer === process.pid || !alive(writer)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Partial<OverlayState>;
        if (Array.isArray(s.pids)) state.pids.push(...s.pids.filter((p): p is number => Number.isInteger(p)));
        if (s.paused === true) state.paused = true;
      } catch { /* half-written or gone */ }
    }
  }
  cache = { at: Date.now(), mtime, state };
  return state;
}
