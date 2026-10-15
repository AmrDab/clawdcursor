/**
 * Unit tests for getProcessStartTime() in src/surface/pidfile.ts.
 *
 * The function shells out to `powershell` (Win32_Process.CreationDate) on
 * Windows or `ps -o lstart=` on POSIX to read a PID's actual start time
 * from the OS. It's the second half of the recycled-PID guard: the
 * lockfile records start time at claim, and on every reclaim attempt the
 * recorded value is compared against this function's output for the live
 * PID. A mismatch (or a null return for a dead PID) means the lock is
 * stale and may be overwritten.
 *
 * Tests here cover the function in isolation rather than through the
 * lockfile; the integration is exercised by tests/pidfile.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { getProcessStartTime } from '../src/surface/pidfile';

// Skip the suite if the platform-specific binary isn't on PATH. Stripped-
// down container images (Alpine without procps, Windows nano-server without
// PowerShell) do exist and should be a clean skip rather than a hard fail.
function platformBinaryAvailable(): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 5000 });
    } else {
      execFileSync('ps', ['-p', String(process.pid)], { stdio: 'ignore', timeout: 5000 });
    }
    return true;
  } catch {
    return false;
  }
}

const HAS_BIN = platformBinaryAvailable();

// Under full-suite load (many vitest workers spawning processes at once) a
// cold PowerShell + Win32_Process query can exceed the production 5 s budget,
// at which point getProcessStartTime gives up and returns null. These tests
// check the real lookup, not the budget, so give it plenty of room. The
// vitest timeout must exceed it: execFileSync blocks the event loop, so the
// per-test timer can't fire until the shell-out returns anyway.
const LOOKUP_TIMEOUT_MS = 30_000;

describe('getProcessStartTime', { timeout: LOOKUP_TIMEOUT_MS + 10_000 }, () => {
  it.skipIf(!HAS_BIN)('returns a finite positive number for the current process', () => {
    const t = getProcessStartTime(process.pid, LOOKUP_TIMEOUT_MS);
    expect(t).not.toBeNull();
    expect(typeof t).toBe('number');
    expect(Number.isFinite(t as number)).toBe(true);
    expect(t as number).toBeGreaterThan(0);
  });

  it.skipIf(!HAS_BIN)('matches the test runner\'s actual start time within ±10s', () => {
    // process.uptime() is seconds since this Node process started; multiplying
    // by 1000 and subtracting from now gives the wall-clock instant Node
    // started. The OS-reported start time should match this within timer
    // jitter — pidfile.ts uses a 5s tolerance internally; we double it here
    // so coarse Linux jiffy precision (~10ms) plus busy-CI clock skew
    // doesn't make the test flake.
    const expected = Date.now() - process.uptime() * 1000;
    const actual = getProcessStartTime(process.pid, LOOKUP_TIMEOUT_MS);
    expect(actual).not.toBeNull();
    expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(10_000);
  });

  it.skipIf(!HAS_BIN)('returns null for a clearly-dead PID', () => {
    // 999999 is well outside the live PID range on every supported host
    // (Windows caps PIDs at ~2^32 but doesn't reuse aggressively; Linux
    // default kernel.pid_max is 32768; macOS uses 99999). The same value
    // is used as the canonical "dead PID" sentinel in pidfile.test.ts.
    expect(getProcessStartTime(999999, LOOKUP_TIMEOUT_MS)).toBeNull();
  });
});
