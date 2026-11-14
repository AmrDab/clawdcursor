/**
 * Control banner (2026-06-12 feature): the on-screen "desktop control in
 * progress" indicator. Contract under test:
 *   - pin/unpin (autonomous task lifecycle) shows/hides exactly one child
 *   - touch (external MCP activity) shows + auto-hides after the idle window
 *   - touch while pinned never schedules a hide
 *   - BANNER_STOP on the child's stdout fires onStopRequested
 *   - disabled state spawns nothing
 *   - the window outline rides the same lifecycle as the pill and dies with it;
 *     it is told which window the agent works in, and draws nothing without one
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { controlBanner, outlineFlags } from '../core/banner';
import { stopControl, __setControlDirForTests } from '../core/control';
import type { ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stdin = new PassThrough();
  written: string[] = [];
  killed = false;
  constructor() { super(); this.stdin.on('data', d => this.written.push(...String(d).split('\n').filter(Boolean))); }
  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0);
    return true;
  }
}

let spawned: FakeChild[];      // pill processes
let outlines: FakeChild[];     // window-outline processes

beforeEach(() => {
  vi.useFakeTimers();
  spawned = [];
  outlines = [];
  controlBanner.__resetForTests();
  controlBanner.__setPlatformEnabledForTests(true);
  controlBanner.__setSpawnerForTests(() => {
    const c = new FakeChild();
    spawned.push(c);
    return c as unknown as ChildProcess;
  });
  controlBanner.__setOutlineSpawnerForTests(() => {
    const c = new FakeChild();
    outlines.push(c);
    return c as unknown as ChildProcess;
  });
});

afterEach(() => {
  controlBanner.__resetForTests();
  vi.useRealTimers();
});

describe('controlBanner', () => {
  it('pin shows exactly one pill + one outline; repeated pins are idempotent; unpin kills both', () => {
    controlBanner.pin();
    controlBanner.pin();
    expect(spawned.length).toBe(1);
    expect(outlines.length).toBe(1);
    expect(controlBanner.isVisible()).toBe(true);
    controlBanner.unpin();
    expect(spawned[0].killed).toBe(true);
    expect(outlines[0].killed).toBe(true);
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('touch shows and auto-hides after the idle window', () => {
    controlBanner.touch(30_000);
    expect(controlBanner.isVisible()).toBe(true);
    vi.advanceTimersByTime(29_000);
    expect(controlBanner.isVisible()).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(controlBanner.isVisible()).toBe(false);
    expect(spawned[0].killed).toBe(true);
  });

  it('repeated touches keep resetting the idle window', () => {
    controlBanner.touch(30_000);
    vi.advanceTimersByTime(25_000);
    controlBanner.touch(30_000);          // activity continues
    vi.advanceTimersByTime(25_000);       // 50s total, but only 25s since last touch
    expect(controlBanner.isVisible()).toBe(true);
    vi.advanceTimersByTime(5_001);
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('a call in flight keeps the pill up past the idle window; the countdown starts when it returns (#294)', () => {
    controlBanner.touch(30_000);
    const release = controlBanner.hold();   // a batch inside a 30 s wait
    vi.advanceTimersByTime(45_000);
    expect(controlBanner.isVisible()).toBe(true);
    release();
    vi.advanceTimersByTime(29_000);
    expect(controlBanner.isVisible()).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('hold shows nothing by itself: a read-only call does not bring the pill up', () => {
    const release = controlBanner.hold();
    expect(controlBanner.isVisible()).toBe(false);
    release();
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('after a stop, a touch or pin does not bring the pill back (#294)', () => {
    stopControl('pill');
    try {
      controlBanner.touch();
      controlBanner.pin();
      expect(controlBanner.isVisible()).toBe(false);
    } finally {
      __setControlDirForTests(null);
    }
  });

  it('touch while pinned never hides — the task lifecycle owns visibility', () => {
    controlBanner.pin();
    controlBanner.touch(1_000);
    vi.advanceTimersByTime(60_000);
    expect(controlBanner.isVisible()).toBe(true);
    controlBanner.unpin();
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('BANNER_STOP from the child fires onStopRequested (the kill switch)', () => {
    const onStop = vi.fn();
    controlBanner.configure({ onStopRequested: onStop });
    controlBanner.pin();
    spawned[0].stdout.write('BANNER_STOP\n');
    // readline delivers on the next tick of the stream — flush microtasks.
    return new Promise<void>(resolve => {
      setImmediate(() => {
        expect(onStop).toHaveBeenCalledTimes(1);
        resolve();
      });
      vi.advanceTimersByTime(0);
    });
  });

  it('spawns nothing when disabled', () => {
    controlBanner.setEnabled(false);
    controlBanner.pin();
    controlBanner.touch();
    expect(spawned.length).toBe(0);
    expect(outlines.length).toBe(0);
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('child exiting on its own clears visibility (no zombie handle)', () => {
    controlBanner.pin();
    spawned[0].emit('exit', 0);
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('when the pill exits, the outline is torn down too (never desync)', () => {
    controlBanner.pin();
    expect(outlines.length).toBe(1);
    spawned[0].emit('exit', 0);          // pill dies on its own
    expect(outlines[0].killed).toBe(true);
  });

  it('on a non-Windows platform nothing spawns — pill OR outline (OS-safe no-op)', () => {
    controlBanner.__setPlatformEnabledForTests(false); // simulate macOS/Linux runtime
    controlBanner.pin();
    controlBanner.touch();
    expect(spawned.length).toBe(0);
    expect(outlines.length).toBe(0);
    expect(controlBanner.isVisible()).toBe(false);
  });
});

describe('the outline around the window the agent works in', () => {
  const live = () => outlines.filter(o => !o.killed);

  it('with no window known the outline is told nothing: it draws nothing, the pill alone shows control', () => {
    controlBanner.pin();
    expect(outlines[0].written).toEqual([]);
  });

  it('is told the working window, told again when it changes, and never the same window twice', () => {
    controlBanner.pin();
    controlBanner.setWorkingWindow({ processId: 100, handle: 0x5a0 });
    controlBanner.setWorkingWindow({ processId: 100, handle: 0x5a0 });
    controlBanner.setWorkingWindow({ processId: 300, handle: 0x7b2 });
    expect(outlines[0].written).toEqual(['TARGET 1440 100', 'TARGET 1970 300']);
  });

  it('is told when there is no window any more, so it hides', () => {
    controlBanner.pin();
    controlBanner.setWorkingWindow({ processId: 100, handle: 0x5a0 });
    controlBanner.setWorkingWindow(undefined);
    expect(outlines[0].written).toEqual(['TARGET 1440 100', 'TARGET']);
  });

  it('the paused outline is spawned paused and blue on every OS; the running one with no flags (#392)', () => {
    const modes: unknown[] = [];
    controlBanner.__setOutlineSpawnerForTests(mode => { modes.push(mode); const c = new FakeChild(); outlines.push(c); return c as unknown as ChildProcess; });
    controlBanner.pin();
    controlBanner.showPaused({ id: 1, message: 'Sign in', since: 0 }, () => {});
    expect(modes).toEqual([{ paused: undefined }, { paused: expect.objectContaining({ id: 1 }) }]);
    for (const os of ['win32', 'darwin', 'linux'] as const) expect(outlineFlags(false, os)).toEqual([]);
    expect(outlineFlags(true, 'win32')).toEqual(['-Color', '#3b82f6', '-Paused']);
    expect(outlineFlags(true, 'darwin')).toEqual(['--color', '#3b82f6', '--paused']);
    expect(outlineFlags(true, 'linux')).toEqual(['--color', '#3b82f6', '--paused']);
  });

  it('a window known only by its process (macOS) is sent with handle 0', () => {
    controlBanner.pin();
    controlBanner.setWorkingWindow({ processId: 100 });
    expect(outlines[0].written).toEqual(['TARGET 0 100']);
  });

  it('a new outline process (the paused form) starts on the window the agent was working in', () => {
    controlBanner.pin();
    controlBanner.setWorkingWindow({ processId: 100, handle: 0x5a0 });
    controlBanner.showPaused({ id: 1, message: 'Sign in', since: 0 }, () => {});
    expect(outlines[0].killed).toBe(true);
    expect(live()[0].written).toEqual(['TARGET 1440 100']);
  });

  it('the next session does not open on the last one\'s window', () => {
    controlBanner.pin();
    controlBanner.setWorkingWindow({ processId: 100, handle: 0x5a0 });
    controlBanner.unpin();
    controlBanner.pin();
    expect(live()[0].written).toEqual([]);
  });

  it('a capture step-aside (Linux) hides the outline as well as the pill; a click dodge leaves the click-through outline', async () => {
    vi.useRealTimers();
    controlBanner.pin();
    await controlBanner.dodge();
    expect(outlines[0].written).toEqual([]);
    await controlBanner.dodge(1500, true);
    expect(spawned[0].written).toEqual(['HIDE 1500', 'HIDE 1500']);
    expect(outlines[0].written).toEqual(['HIDE 1500']);
  });
});

describe('captures where the OS cannot keep the overlay out', () => {
  it('an outline that says OUTLINE_CAPTURABLE (Windows 10 before 2004) steps aside with the pill before a capture', async () => {
    vi.useRealTimers();
    controlBanner.pin();
    if (process.platform !== 'linux') {
      await controlBanner.beforeCapture();
      expect(outlines[0].written).toEqual([]);   // excluded by the OS: nothing to hide
    }
    outlines[0].stdout.write('OUTLINE_CAPTURABLE\n');
    await new Promise(r => setImmediate(r));
    await controlBanner.beforeCapture();
    expect(spawned[0].written).toEqual(['HIDE 1500']);
    expect(outlines[0].written).toEqual(['HIDE 1500']);
  });
});

// A host that hard-kills this process runs no exit hook: every drawer leaves when its stdin closes.
describe('no overlay outlives its parent', () => {
  const read = (...p: string[]) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', ...p), 'utf8');
  it('every drawer exits on stdin EOF, the pill included', () => {
    for (const ps of [read('banner.ps1'), read('window-outline.ps1')]) {
      expect(ps).toMatch(/while \(\(line = Console\.In\.ReadLine\(\)\) != null\) \{[\s\S]*?\n {16}\}\n {16}Environment\.Exit\(0\);/);
    }
    expect(read('mac', 'overlay.swift')).toMatch(/if data\.isEmpty \{[^}]*NSApp\.terminate\(nil\)/);
    expect(read('linux', 'overlay.py').match(/if not chunk:\n\s+Gtk\.main_quit\(\)/g)).toHaveLength(2);
  });
});

// The drawers put real windows on screen, so these read the source: nothing draws on a whole screen any more.
describe('no full-screen glow', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

  it('no outline drawer sizes a window to a screen (only the desktop itself in front is outlined as its monitor)', () => {
    expect(read('scripts', 'window-outline.ps1')).not.toMatch(/AllScreens|PrimaryScreen|\.Bounds\b/);
    const swift = read('scripts', 'mac', 'overlay.swift');
    expect(swift.slice(swift.indexOf('func windowOutline()'))).not.toMatch(/screen\.frame|NSScreen\.screens/);
    const py = read('scripts', 'linux', 'overlay.py');
    const start = py.indexOf('def run_outline(');
    expect(py.slice(start, py.indexOf('\ndef ', start + 1))).not.toMatch(/get_monitor|get_n_monitors/);
  });

  it('the Windows outline is click-through, never activates, and stays out of captures', () => {
    const ps = read('scripts', 'window-outline.ps1');
    for (const style of ['0x00080000', '0x00000020', '0x08000000', '0x00000080', '0x00000008']) expect(ps).toContain(style);
    expect(ps).toContain('SetWindowDisplayAffinity(Handle, 0x11)');
    // Where the frame is, is read in physical pixels (per-monitor-v2); the strips themselves are not DPI aware, so
    // Windows draws them at the monitor's scale.
    expect(ps).toContain('IntPtr aware = SetThreadDpiAwarenessContext(new IntPtr(-4));   // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2');
    expect(ps).toContain('SetThreadDpiAwarenessContext([IntPtr](-1))');
    // Re-placed only when it moved or is no longer above its window (walking up the z-order), never on every poll.
    expect(ps).toContain('if (placed && !moved) return;');
    // TARGET and HIDE act on receipt, not on the next poll: a capture follows HIDE after 90 ms.
    expect(ps).toContain('BeginInvoke((Action)Follow)');
    // A byte-order mark in front of the first line (a .NET parent) does not lose the command.
    expect(ps).toContain('p[0].EndsWith("TARGET")');
    expect(ps).toContain('p[0].EndsWith("HIDE")');
  });
});
