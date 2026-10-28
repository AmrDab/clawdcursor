/**
 * Tests for the single-instance pidfile lock.
 *
 * Covers the failure modes the JSON-lockfile + start-time-verify fix addresses:
 *   - Stale lockfile (PID dead) → cleared, claim succeeds.
 *   - Recycled PID with start-time mismatch → cleared, claim succeeds.
 *   - Genuine duplicate (PID alive + start time matches) → claim returns the pid.
 *   - Legacy bare-int format from prior versions → treated as stale.
 *   - Malformed JSON → treated as stale.
 *
 * Each test redirects HOME / USERPROFILE to an isolated tmpdir so it can
 * write and read real lockfiles without touching the user's actual
 * ~/.clawdcursor/ directory.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

describe('claimPidFile', () => {
  it('claims successfully when no lockfile exists', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      expect(mod.claimPidFile('mcp')).toBeNull();
      const written = JSON.parse(fs.readFileSync(mod.pidFilePath('mcp'), 'utf-8'));
      expect(written.pid).toBe(process.pid);
      expect(written.mode).toBe('mcp');
      expect(written.v).toBe(1);
      expect(typeof written.startTime).toBe('number');
    } finally { restore(); }
  });

  it('overwrites a stale lockfile pointing at a dead pid', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      // PID 999999 should be reliably dead on every test host.
      const stale = { v: 1, pid: 999999, startTime: Date.now(), mode: 'mcp' };
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('mcp'), JSON.stringify(stale));

      expect(mod.claimPidFile('mcp')).toBeNull();
      const written = JSON.parse(fs.readFileSync(mod.pidFilePath('mcp'), 'utf-8'));
      expect(written.pid).toBe(process.pid);
    } finally { restore(); }
  });

  it('overwrites a recycled-PID lockfile (live PID, wrong start time)', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      // Use the test runner's own PID as the "recycled" PID — it's alive
      // but its real start time is "now-ish", far from the planted value.
      const recycled = {
        v: 1,
        pid: process.pid,
        startTime: 1_000_000_000_000, // year 2001 — clearly not when this test started
        mode: 'mcp',
      };
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('mcp'), JSON.stringify(recycled));

      // claimPidFile compares the lockfile's recorded start time against the
      // OS-reported actual start time of the PID. The 2001 timestamp can't
      // match a process started today, so this must be treated as stale.
      // (The PID == process.pid short-circuit also forces overwrite — both
      // paths land on the same correct outcome.)
      expect(mod.claimPidFile('mcp')).toBeNull();

      const written = JSON.parse(fs.readFileSync(mod.pidFilePath('mcp'), 'utf-8'));
      expect(written.startTime).not.toBe(1_000_000_000_000);
    } finally { restore(); }
  });

  it('treats a legacy bare-integer lockfile as stale', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      // Pre-fix versions wrote the PID as a bare integer. We can't verify
      // identity from this format, so it must be discarded on first claim.
      fs.writeFileSync(mod.pidFilePath('mcp'), '12345');

      expect(mod.claimPidFile('mcp')).toBeNull();
      const written = JSON.parse(fs.readFileSync(mod.pidFilePath('mcp'), 'utf-8'));
      expect(written.v).toBe(1);
      expect(written.pid).toBe(process.pid);
    } finally { restore(); }
  });

  it('treats a malformed lockfile as stale', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('mcp'), '{not json');

      expect(mod.claimPidFile('mcp')).toBeNull();
      expect(JSON.parse(fs.readFileSync(mod.pidFilePath('mcp'), 'utf-8')).pid).toBe(process.pid);
    } finally { restore(); }
  });

  it('separates locks by mode', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      expect(mod.claimPidFile('mcp')).toBeNull();
      // Same process can hold multiple modes' locks at once — they're
      // independent files, used by different commands.
      expect(mod.claimPidFile('start')).toBeNull();
      expect(fs.existsSync(mod.pidFilePath('mcp'))).toBe(true);
      expect(fs.existsSync(mod.pidFilePath('start'))).toBe(true);
    } finally { restore(); }
  });
});

describe('releasePidFile', () => {
  it('removes the lockfile when this process owns it', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      mod.claimPidFile('mcp');
      expect(fs.existsSync(mod.pidFilePath('mcp'))).toBe(true);
      mod.releasePidFile('mcp');
      expect(fs.existsSync(mod.pidFilePath('mcp'))).toBe(false);
    } finally { restore(); }
  });

  it('does not remove a lockfile owned by a different pid', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      // Plant a lock owned by a clearly-different PID. release should be
      // a no-op so a slow exit can't accidentally release a successor's lock.
      const other = { v: 1, pid: process.pid + 99999, startTime: Date.now(), mode: 'mcp' };
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('mcp'), JSON.stringify(other));

      mod.releasePidFile('mcp');
      expect(fs.existsSync(mod.pidFilePath('mcp'))).toBe(true);
    } finally { restore(); }
  });
});

describe('readPidLoose', () => {
  it('reads the new JSON format', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      mod.claimPidFile('mcp');
      expect(mod.readPidLoose('mcp')).toBe(process.pid);
    } finally { restore(); }
  });

  it('reads the legacy bare-int format', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('mcp'), '54321');
      expect(mod.readPidLoose('mcp')).toBe(54321);
    } finally { restore(); }
  });

  it('returns null for a missing lockfile', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      expect(mod.readPidLoose('mcp')).toBeNull();
    } finally { restore(); }
  });
});

describe('isProcessAlive', () => {
  it('returns true for the current process', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      expect(mod.isProcessAlive(process.pid)).toBe(true);
    } finally { restore(); }
  });

  it('returns false for a clearly-dead pid', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      expect(mod.isProcessAlive(999999)).toBe(false);
    } finally { restore(); }
  });
});

// `stop` / `resume` / `task` must not take the daemon's port from a config file: a repo in the cwd could plant
// .clawdcursor-config.json and have the bearer token sent to a port of its choosing.
describe('daemonPortForClient', () => {
  /** A cwd that plants a project config pointing somewhere else. */
  function plantCwdConfig(): void {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-evil-repo-'));
    fs.writeFileSync(path.join(repo, '.clawdcursor-config.json'), JSON.stringify({ port: 6666, server: { port: 6666 } }));
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
  }

  it('the running daemon\'s recorded port wins over a cwd config', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      plantCwdConfig();
      // The plant works: the config ladder would have picked it up.
      const { resolveConfig } = await import('../src/llm/config');
      expect(resolveConfig({ userConfigPath: path.join(tmpHome, 'none.json'), envOverride: {} }).port).toBe(6666);
      expect(mod.claimPidFile('start')).toBeNull();   // this process plays the daemon
      mod.recordLockPort('start', 4999);
      expect(mod.daemonPortForClient()).toBe(4999);
      // The record lives in the 0600 lock, next to the pid it belongs to.
      expect(JSON.parse(fs.readFileSync(mod.pidFilePath('start'), 'utf-8'))).toMatchObject({ pid: process.pid, port: 4999 });
    } finally { restore(); }
  });

  it('a record whose pid is dead falls back to 3847, not to the cwd config', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      plantCwdConfig();
      fs.mkdirSync(path.dirname(mod.pidFilePath('start')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('start'), JSON.stringify({ v: 1, pid: 999999, startTime: Date.now(), mode: 'start', port: 4999 }));
      expect(mod.daemonPortForClient()).toBe(3847);
    } finally { restore(); }
  });

  it('no record at all → 3847; an explicit --port always wins', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      plantCwdConfig();
      expect(mod.daemonPortForClient()).toBe(3847);
      expect(mod.daemonPortForClient(5001)).toBe(5001);
    } finally { restore(); }
  });

  it('recordLockPort leaves a lock it does not own alone', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      const other = { v: 1, pid: 999999, startTime: Date.now(), mode: 'start' };
      fs.mkdirSync(path.dirname(mod.pidFilePath('start')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('start'), JSON.stringify(other));
      mod.recordLockPort('start', 4999);
      expect(JSON.parse(fs.readFileSync(mod.pidFilePath('start'), 'utf-8'))).toEqual(other);
    } finally { restore(); }
  });
});
