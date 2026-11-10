/**
 * Multi-monitor: an element is on screen when its rect overlaps SOME monitor.
 *
 * Live Win11 2026-11-10: a second monitor ABOVE the primary (negative Y). The bridge blanked the bounds of every
 * element left of / above (-100,-100), so read_tree listed most of a window on that monitor as "offscreen" with no
 * position and the agent fell back to screenshots.
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

let replies: Record<string, unknown> = {};
vi.mock('../platform/ps-runner', () => ({
  psRunner: { run: (c: { cmd: string }) => Promise.resolve(replies[c.cmd]), start: vi.fn(), stop: vi.fn() },
}));

import { WindowsAdapter } from '../platform/windows';
import { onAnyDisplay } from '../platform/display-target';
import type { Display } from '../platform/types';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The owner's layout in physical pixels (what the bridge reports): primary 3840x2400 at 225%; a 1920x1080 monitor at
// 100% ABOVE it, shifted right — at (2796,-1080). Left of that monitor and right of the primary, no monitor covers.
const monitors = [
  { name: 'DISPLAY1', primary: true, x: 0, y: 0, width: 3840, height: 2400, scale: 2.25 },
  { name: 'DISPLAY2', primary: false, x: 2796, y: -1080, width: 1920, height: 1080, scale: 1 },
];
const displays: Display[] = monitors.map((m, index) => ({
  index, label: m.name, primary: m.primary, bounds: { x: m.x, y: m.y, width: m.width, height: m.height },
  physicalSize: { width: m.width, height: m.height }, dpiRatio: m.scale,
}));

const onSecond = { x: 2796, y: -905, width: 292, height: 839 };
const onPrimary = { x: 100, y: 100, width: 120, height: 32 };
const beside = { x: 4000, y: 100, width: 120, height: 32 }; // right of the primary, below the second monitor
const minimized = { x: -32000, y: -32000, width: 160, height: 28 };

describe('onAnyDisplay', () => {
  it('a rect on a monitor at negative coordinates is on screen', () => {
    expect(onAnyDisplay(displays, onSecond)).toBe(true);
    expect(onAnyDisplay(displays, onPrimary)).toBe(true);
  });
  it('a window frame hanging over the monitor edge still counts', () => {
    expect(onAnyDisplay(displays, { x: 2790, y: -1086, width: 1932, height: 1044 })).toBe(true);
  });
  it('a rect no monitor covers is not', () => {
    expect(onAnyDisplay(displays, beside)).toBe(false);
    expect(onAnyDisplay(displays, minimized)).toBe(false);
    expect(onAnyDisplay(displays, { x: 100, y: -500, width: 120, height: 32 })).toBe(false); // above the primary, left of the second monitor
  });
});

describe('WindowsAdapter.getUiTree on a second monitor above the primary', () => {
  let adapter: WindowsAdapter;
  const el = (name: string, bounds: object) => ({ name, controlType: 'ControlType.Button', bounds, children: [] });
  beforeEach(() => {
    adapter = new WindowsAdapter();
    vi.spyOn(adapter, 'getActiveWindow').mockResolvedValue({ processId: 42 } as never);
    replies = {
      'list-displays': { success: true, displays: monitors },
      'get-screen-context': { uiTree: [el('Open', onSecond), el('Save', onPrimary), el('Beside', beside), el('Gone', minimized)] },
    };
  });

  it('keeps the position of elements on either monitor', async () => {
    const tree = await adapter.getUiTree();
    expect(tree.find(e => e.name === 'Open')).toMatchObject({ bounds: onSecond });
    expect(tree.find(e => e.name === 'Open')!.offscreen).not.toBe(true);
    expect(tree.find(e => e.name === 'Save')).toMatchObject({ bounds: onPrimary });
  });

  it('flags elements on no monitor offscreen, without a position', async () => {
    const tree = await adapter.getUiTree();
    for (const name of ['Beside', 'Gone']) {
      expect(tree.find(e => e.name === name)).toMatchObject({ offscreen: true, bounds: { x: 0, y: 0, width: 0, height: 0 } });
    }
  });

  it('keeps every position when the monitors cannot be listed', async () => {
    vi.spyOn(adapter, 'listDisplays').mockResolvedValue([]);
    const tree = await adapter.getUiTree();
    expect(tree.find(e => e.name === 'Beside')).toMatchObject({ bounds: beside });
  });

  it('the bridge no longer blanks bounds left of / above the primary', () => {
    const bridge = script('ps-bridge.ps1');
    const start = bridge.indexOf('function ConvertTo-UINode {');
    const body = bridge.slice(start, bridge.indexOf('\nfunction ', start + 1));
    expect(body).toContain('$cur.BoundingRectangle');
    expect(body).not.toMatch(/-lt -\d+/);
  });
});

const script = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', name), 'utf8');

// The same run: the glow showed on the primary only, and the pill sat on the primary while the work was on the other
// monitor. The scripts draw real windows, so these read the source.
describe('the Windows overlays on a second monitor', () => {
  it('the glow goes per-monitor-v2 (physical pixels, as the bridge) before it reads the monitors', () => {
    const glow = script('edge-glow.ps1');
    const aware = glow.indexOf('[GlowOverlay]::SetThreadDpiAwarenessContext([IntPtr](-4))');
    expect(aware).toBeGreaterThan(-1);
    expect(aware).toBeLessThan(glow.indexOf('[System.Windows.Forms.Screen]::AllScreens'));
  });

  it('the pill sits on the monitor of the foreground window, the primary when there is none', () => {
    const banner = script('banner.ps1');
    const start = banner.indexOf('function Set-PillShape(');
    const body = banner.slice(start, banner.indexOf('\n}', start));
    expect(body).toContain('GetForegroundWindow()');
    expect(body).toContain('Screen]::FromHandle($fg).WorkingArea');
    expect(body).toContain('Screen]::PrimaryScreen.WorkingArea');
  });
});
