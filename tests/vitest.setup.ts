import { vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

// Keep test runs out of the user's real ~/.clawdcursor: the structured logger
// and the MCP session log write here instead.
process.env.CLAWDCURSOR_LOG_DIR ??= path.join(os.tmpdir(), `clawdcursor-test-logs-${process.pid}`);
process.env.CLAWDCURSOR_SESSION_DIR ??= path.join(os.tmpdir(), `clawdcursor-test-sessions-${process.pid}`);

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
