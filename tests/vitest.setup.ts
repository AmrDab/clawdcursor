import { vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// Tests never touch the owner's real home: os.homedir() (and so ~/.clawdcursor: the auth token, consent, pidfile, stop flag)
// resolves under a private temp directory. Set before any module computes a path from it. Child processes inherit it.
// The real home is kept only so home-isolation.test.ts can prove nothing was written there.
if (!process.env.CLAWD_TEST_REAL_HOME) {
  process.env.CLAWD_TEST_REAL_HOME = os.homedir();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-test-home-'));
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
}
// Keep test runs out of the user's real ~/.clawdcursor: the structured logger
// and the MCP session log write here instead.
process.env.CLAWDCURSOR_LOG_DIR ??= path.join(os.tmpdir(), `clawdcursor-test-logs-${process.pid}`);
// PowerShell children run from a private directory under the home dir (platform/ps-spawn.ts): tests get their own.
process.env.CLAWDCURSOR_RUN_DIR ??= path.join(os.tmpdir(), `clawdcursor-test-run-${process.pid}`);
// Windows system programs are started by absolute path under %SystemRoot% (platform/ps-spawn.ts). Tests that mock the Windows
// adapters on Linux / macOS need a SystemRoot that has them: an empty stand-in, never executed (child_process is mocked there).
if (process.platform !== 'win32' && !process.env.SystemRoot) {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-test-sysroot-'));   // private (0700), unguessable
  for (const rel of [['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'], ['System32', 'reg.exe'], ['System32', 'tasklist.exe'],
    ['System32', 'taskkill.exe'], ['System32', 'netstat.exe'], ['System32', 'rundll32.exe'], ['explorer.exe']]) {
    const f = path.join(fakeRoot, ...rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
  }
  process.env.SystemRoot = fakeRoot;
}
process.env.CLAWDCURSOR_SESSION_DIR ??= path.join(os.tmpdir(), `clawdcursor-test-sessions-${process.pid}`);
// Tests fake the UI tree; a thin fake must not make every read wait for an app to "wake" (the wake tests pass their own budget).
process.env.CLAWDCURSOR_WAKE_BUDGET_MS ??= '0';
// A pause would put the real overlay on screen and wait for a human. Off by
// default; the pause tests turn it on with a fake banner spawner.
process.env.CLAWD_NO_PAUSE ??= '1';
// Same for the overlay itself (pill + glow): tests that need it enable it with fake spawners.
process.env.CLAWD_NO_BANNER ??= '1';
// The compiled macOS accessibility helper (scripts/mac/ax-helper.swift) reads the REAL desktop — never in unit
// tests, where a Mac that happens to have it built would otherwise change what the osascript-path tests see.
// Tests of the client inject a fake runner; the live helper has its own darwin-only test.
process.env.CLAWD_NO_MAC_AX ??= '1';

// The PowerShell bridge drives the REAL pointer and captures the REAL screen —
// never in unit tests. Default: bridge down (callers fall back). Tests that
// exercise bridge behaviour mock '../platform/ps-runner' themselves.
vi.mock('../src/platform/ps-runner', () => ({
  psRunner: {
    run: vi.fn(async () => { throw new Error('PowerShell bridge is not available in unit tests'); }),
    start: vi.fn(async () => {}),
    stop: vi.fn(),
  },
  PSRunner: class {},
}));

// Global nut-js mock for CI/test environments that don't provide desktop libs
// (e.g. Linux missing libXtst/libxdo). Individual tests can still override
// behavior via local vi.mock + vi.mocked exports.
vi.mock('@nut-tree-fork/nut-js', () => {
  const noop = vi.fn(async () => {});
  const screenGrab = vi.fn(async () => ({ width: 1, height: 1, data: Buffer.alloc(4) }));

  // Method names must match what production code in src/platform/native-desktop.ts
  // actually calls — that file uses `mouse.click` (not just `leftClick`) and
  // `screen.grabRegion`. Existing per-test `vi.mock(...)` declarations override
  // this global mock, so the gap matters mostly for future tests that rely on
  // the global fallback without their own override.
  return {
    mouse: {
      config: { autoDelayMs: 0 },
      setPosition: noop,
      move: noop,
      click: noop,
      leftClick: noop,
      rightClick: noop,
      doubleClick: noop,
      pressButton: noop,
      releaseButton: noop,
      scrollUp: noop,
      scrollDown: noop,
      getPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    },
    keyboard: {
      config: { autoDelayMs: 0 },
      type: noop,
      pressKey: noop,
      releaseKey: noop,
    },
    screen: {
      config: { autoHighlight: false },
      width: vi.fn(async () => 1920),
      height: vi.fn(async () => 1080),
      grab: screenGrab,
      grabRegion: screenGrab,
    },
    Point: class Point { constructor(public x: number, public y: number) {} },
    Region: class Region { constructor(public left: number, public top: number, public width: number, public height: number) {} },
    Button: { LEFT: 'LEFT', RIGHT: 'RIGHT', MIDDLE: 'MIDDLE' },
    Key: new Proxy({}, { get: (_target, prop) => String(prop) }),
    straightTo: vi.fn(() => ({})),
    centerOf: vi.fn(() => ({ x: 0, y: 0 })),
  };
});
