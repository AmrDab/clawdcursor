/**
 * The pidfile lock against real processes: a live pid is only "ours" when the OS start time matches the lock's
 * (a recycled pid is stale, a real duplicate is refused), and `stop` / `uninstall` signal only a holder the lock proves.
 * Every case starts a node child and reads its start time from the OS (PowerShell + WMI on Windows).
 * The lock-file cases with no live process are in pidfile.test.ts.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, type ChildProcess } from 'child_process';

// pidfile.ts resolves PID_DIR at import time from os.homedir(), which
// itself honors HOME (POSIX) and USERPROFILE (Windows). Setting both env
// vars *before* the dynamic import gives every test its own home dir.
async function loadPidfileWithHome(home: string) {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
  const mod = await import('../src/surface/pidfile');
  return { mod, restore: () => { process.env.HOME = prev.HOME; process.env.USERPROFILE = prev.USERPROFILE; } };
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-pidfile-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// A cold PowerShell + WMI start-time query can take seconds.
const LOOKUP_MS = 30_000;
const spawnIdleChild = (): ChildProcess => spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });

describe('claimPidFile against a live pid', () => {
  it('overwrites a recycled-PID lockfile (live PID, wrong start time)', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    const child = spawnIdleChild();
    try {
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('mcp'), JSON.stringify({ v: 1, pid: child.pid, startTime: 1_000_000_000_000, mode: 'mcp' }));
      expect(mod.claimPidFile('mcp')).toBeNull();
      expect(JSON.parse(fs.readFileSync(mod.pidFilePath('mcp'), 'utf-8')).pid).toBe(process.pid);
    } finally { child.kill(); restore(); }
  });

  it('refuses a genuine duplicate (live PID, matching start time): returns its pid and leaves its lock', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    const child = spawnIdleChild();
    try {
      const startTime = mod.getProcessStartTime(child.pid!, LOOKUP_MS);
      expect(startTime).not.toBeNull();
      const lock = JSON.stringify({ v: 1, pid: child.pid, startTime, mode: 'mcp' });
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('mcp'), lock);
      expect(mod.claimPidFile('mcp')).toBe(child.pid);
      expect(fs.readFileSync(mod.pidFilePath('mcp'), 'utf-8')).toBe(lock);
    } finally { child.kill(); restore(); }
  });
});

// `stop` / `uninstall` signal the pid a lock names. Locks go stale and pids get reused, so only a lock that proves its
// process (full JSON lock + matching OS start time) may be signalled; anything else is deleted untouched.
describe('stopLockHolder', () => {
  function writeLock(mod: { pidFilePath: (m: 'start') => string }, body: string): string {
    const file = mod.pidFilePath('start');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  }

  it('does not signal a live pid whose start time does not match, and removes the lock', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    const child = spawnIdleChild();
    try {
      const kill = vi.spyOn(process, 'kill');
      // A reused pid: alive, but not the process that wrote the lock (start time far in the past).
      const file = writeLock(mod, JSON.stringify({ v: 1, pid: child.pid, startTime: 1_000_000_000_000, mode: 'start' }));
      await expect(mod.stopLockHolder('start', LOOKUP_MS)).resolves.toEqual({ outcome: 'stale' });
      expect(kill.mock.calls.filter(([, sig]) => sig !== 0)).toEqual([]);   // liveness probes only
      expect(fs.existsSync(file)).toBe(false);
      expect(mod.isProcessAlive(child.pid!)).toBe(true);
    } finally { child.kill(); restore(); }
  }, 60_000);

  it('does not signal the parent process named by a wrong-start-time lock', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      const kill = vi.spyOn(process, 'kill');
      const file = writeLock(mod, JSON.stringify({ v: 1, pid: process.ppid, startTime: 1_000_000_000_000, mode: 'start' }));
      await expect(mod.stopLockHolder('start', LOOKUP_MS)).resolves.toEqual({ outcome: 'stale' });
      expect(kill.mock.calls.filter(([, sig]) => sig !== 0)).toEqual([]);
      expect(fs.existsSync(file)).toBe(false);
    } finally { restore(); }
  }, 60_000);

  it('removes a legacy bare-integer lock without signalling anything', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    const child = spawnIdleChild();
    try {
      const kill = vi.spyOn(process, 'kill');
      const file = writeLock(mod, String(child.pid));
      await expect(mod.stopLockHolder('start', LOOKUP_MS)).resolves.toEqual({ outcome: 'stale' });
      expect(kill).not.toHaveBeenCalled();
      expect(fs.existsSync(file)).toBe(false);
      expect(mod.isProcessAlive(child.pid!)).toBe(true);
    } finally { child.kill(); restore(); }
  }, 60_000);

  it('signals the holder when the lock proves it, and removes the lock', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    const child = spawnIdleChild();
    try {
      const startTime = mod.getProcessStartTime(child.pid!, LOOKUP_MS);
      expect(startTime).not.toBeNull();
      const file = writeLock(mod, JSON.stringify({ v: 1, pid: child.pid, startTime, mode: 'start' }));
      const exited = new Promise(r => child.once('exit', r));
      const kill = vi.spyOn(process, 'kill');
      await expect(mod.stopLockHolder('start', LOOKUP_MS)).resolves.toEqual({ outcome: 'stopped', pid: child.pid });
      expect(kill).toHaveBeenCalledWith(child.pid, 'SIGTERM');
      await exited;
      expect(fs.existsSync(file)).toBe(false);
    } finally { child.kill(); restore(); }
  }, 60_000);

  it('reports none when there is no lock', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      await expect(mod.stopLockHolder('start')).resolves.toEqual({ outcome: 'none' });
    } finally { restore(); }
  });
});

describe('sweepAllLocks (`stop` and `uninstall`)', () => {
  it('stops only a holder its lock proves; a live pid under a wrong start time is left alone; every lock is removed', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    const ours = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
    const stranger = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
    try {
      const startTime = mod.getProcessStartTime(ours.pid!, LOOKUP_MS);
      expect(startTime).not.toBeNull();
      fs.mkdirSync(path.dirname(mod.pidFilePath('start')), { recursive: true });
      expect(mod.claimPidFile(mod.DAEMON_LOCK)).toBeNull();                            // this process: removed, not killed
      fs.writeFileSync(mod.pidFilePath('serve'), JSON.stringify({ v: 1, pid: ours.pid, startTime, mode: 'serve' }));
      // A reused pid: alive, but not the process that wrote the lock.
      fs.writeFileSync(mod.pidFilePath('mcp'), JSON.stringify({ v: 1, pid: stranger.pid, startTime: 1_000_000_000_000, mode: 'mcp' }));
      const exited = new Promise(r => ours.once('exit', r));
      const kill = vi.spyOn(process, 'kill');
      expect(await mod.sweepAllLocks(LOOKUP_MS)).toEqual([
        { mode: 'start', outcome: 'stale' },
        { mode: 'mcp', outcome: 'stale' },
        { mode: 'serve', outcome: 'stopped', pid: ours.pid },
      ]);
      expect(kill.mock.calls.filter(([pid, sig]) => sig !== 0 && pid !== ours.pid)).toEqual([]);
      await exited;
      expect(mod.isProcessAlive(stranger.pid!)).toBe(true);
      for (const mode of ['start', 'mcp', 'serve'] as const) expect(fs.existsSync(mod.pidFilePath(mode))).toBe(false);
    } finally { ours.kill('SIGKILL'); stranger.kill('SIGKILL'); restore(); }
  }, 60_000);
});
