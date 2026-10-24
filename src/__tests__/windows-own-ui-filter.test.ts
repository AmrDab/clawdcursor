/**
 * On Windows the pill runs as powershell.exe — the same name as the user's shells — and window lookups match process names
 * by substring. `focus {processName:"powershell"}` must never resolve to the pill: its pid is filtered out of the window list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public l: number, public t: number, public w: number, public h: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const runCalls: Array<Record<string, unknown>> = [];
const PILL = { processId: 777, processName: 'powershell', title: '', bounds: { x: 900, y: 0, width: 430, height: 40 }, isMinimized: false };
const SHELL = { processId: 888, processName: 'powershell', title: 'Windows PowerShell', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false };

vi.mock('../platform/ps-runner', () => ({
  psRunner: {
    run: (payload: Record<string, unknown>) => {
      runCalls.push(payload);
      if (payload.cmd === 'get-screen-context') return Promise.resolve({ windows: [PILL, SHELL] });
      if (payload.cmd === 'focus-window') return Promise.resolve({ success: true, foreground: true, processId: payload.processId });
      return Promise.resolve({});
    },
    start: vi.fn(), stop: vi.fn(),
  },
}));

import { WindowsAdapter } from '../platform/windows';
import { AccessibilityBridge } from '../platform/accessibility';
import { setOwnUiPids } from '../platform/pointer-guard';

beforeEach(() => { runCalls.length = 0; setOwnUiPids(() => [PILL.processId]); });

describe('Windows: the pill is never a lookup candidate', () => {
  it('the window list leaves the overlay out', async () => {
    const wins = await new WindowsAdapter().listWindows();
    expect(wins.map(w => w.processId)).toEqual([SHELL.processId]);
  });

  it('focus by the shared interpreter name lands on the user\'s shell, never the pill', async () => {
    expect(await new WindowsAdapter().focusWindow({ processName: 'powershell' })).toBe(true);
    const focus = runCalls.find(c => c.cmd === 'focus-window');
    expect(focus?.processId).toBe(SHELL.processId);
  });

  // The focus_window tool resolves names through the a11y bridge, not the adapter: the filter sits at the source.
  it.runIf(process.platform === 'win32')('the a11y bridge window list leaves the overlay out too', async () => {
    const wins = await new AccessibilityBridge().getWindows(true);
    expect(wins.map(w => w.processId)).toEqual([SHELL.processId]);
  });
});
