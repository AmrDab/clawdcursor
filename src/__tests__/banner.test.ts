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
import { existsSync, readFileSync } from 'fs';
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

  it('the glow drawer is gone and nothing spawns it', () => {
    expect(existsSync(join(root, 'scripts', 'edge-glow.ps1'))).toBe(false);
    for (const src of [read('src', 'core', 'banner.ts'), read('scripts', 'mac', 'overlay.swift'), read('scripts', 'linux', 'overlay.py')]) {
      expect(src).not.toMatch(/edge-glow|['"]glow['"]|CLAWD_NO_GLOW/);
    }
  });

  it('no outline drawer sizes a window to a screen (only the desktop itself in front is outlined as its monitor)', () => {
    expect(read('scripts', 'window-outline.ps1')).not.toMatch(/AllScreens|PrimaryScreen|\.Bounds\b/);
    const swift = read('scripts', 'mac', 'overlay.swift');
    expect(swift.slice(swift.indexOf('func windowOutline()'))).not.toMatch(/screen\.frame|NSScreen\.screens/);
    const py = read('scripts', 'linux', 'overlay.py');
    const start = py.indexOf('def run_outline(');
    expect(py.slice(start, py.indexOf('\ndef ', start + 1))).not.toMatch(/get_monitor|get_n_monitors/);
  });

  it('the beam is still where the OS is set to reduce motion, and the paused form does not turn (#392)', () => {
    const ps = read('scripts', 'window-outline.ps1');
    expect(ps).toContain('still = SystemParametersInfo(0x1042, 0, out animate, 0) && !animate;');
    expect(ps).toContain('turning = !still && !paused;');
    expect(read('scripts', 'banner.ps1')).toContain('if (SystemParametersInfo(0x1042, 0, out animate, 0) && !animate) return;');
    const swift = read('scripts', 'mac', 'overlay.swift');
    expect(swift).toContain('let still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion');
    expect(swift).toContain('let turning = !paused && !still');
    expect(swift).toContain('if window == nil || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { return }');
  });

  // The look is a port of Border Beam and Thinking Orbs (libraries.dev, MIT): its notice goes with it.
  it('the beam and the orb carry the library\'s licence notice (#392)', () => {
    const ps = read('scripts', 'window-outline.ps1');
    expect(ps).toContain('Border Beam - MIT License - Copyright (c) 2026 Jakub Antalik');
    expect(ps).toContain('The above copyright notice and this permission notice shall be included in all copies or substantial portions of');
    expect(read('scripts', 'mac', 'overlay.swift')).toContain('MIT License,\n// Copyright (c) 2026 Jakub Antalik');
    expect(read('scripts', 'banner.ps1')).toContain('MIT License, Copyright (c) 2026 Jakub');
  });

  // The owner's pick (#392): Border Beam with size="pulse-outside", colorVariant="sunset", borderRadius 30, duration
  // 1.96 s. The three drawers carry the library's numbers; these keep them the same everywhere.
  it('every drawer draws pulse-outside in sunset (paused: ocean), radius 30, 1.96 s, with the same numbers', () => {
    const ps = read('scripts', 'window-outline.ps1');
    const swift = read('scripts', 'mac', 'overlay.swift');
    const py = read('scripts', 'linux', 'overlay.py');
    const numbers = (src: string, from: string) => {
      const start = src.indexOf(from);
      expect(start).toBeGreaterThan(-1);
      const ends = [src.indexOf(';', start), src.indexOf('\n\n', start)].filter(i => i > -1);
      const body = src.slice(start + from.length, Math.min(...ends));
      return (body.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    };
    const sunset = [255, 80, 50, 255, 160, 40, 255, 120, 60, 255, 200, 50, 255, 100, 80, 255, 180, 60, 255, 60, 60, 255, 140, 50, 255, 90, 70];
    const ocean = [100, 80, 220, 60, 120, 255, 80, 100, 200, 50, 140, 220, 120, 80, 255, 70, 130, 255, 140, 100, 240, 90, 110, 230, 130, 70, 255];
    expect(numbers(ps, 'Sunset = {')).toEqual(sunset);
    expect(numbers(ps, 'Ocean = {')).toEqual(ocean);
    expect(numbers(swift, 'let sunset: [[Double]] = ').slice(0, 27)).toEqual(sunset);
    expect(numbers(swift, 'let ocean: [[Double]] = ').slice(0, 27)).toEqual(ocean);
    expect(numbers(py, 'BEAM_SUNSET = ').slice(0, 27)).toEqual(sunset);
    expect(numbers(py, 'BEAM_OCEAN = ').slice(0, 27)).toEqual(ocean);
    // The blobs (ring and inner glow; bloom), in the same order everywhere.
    const edge = [0, 1, 0, 80, 19, 27, 0, 6, 2, 1, 74, 11, 73, -1, 7, 3, 1, 15, 44, 100, 33, 8, 1, 3, 19, 38, 101, 72,
      4, 2, 3, 84, 13, 67, 100, 1, 3, 2, 60, 21, 24, 101, 2, 1, 2, 17, 40, 0, 60, 3, 2, 0, 13, 32, -1, 28];
    const bloom = [0, 110, 30, 27, 3, 6, 100, 20, 73, 1, 7, 26, 62, 100, 33, 8, 30, 56, 101, 72, 4, 120, 22, 67, 99, 1, 88, 32, 24, 99, 2, 28, 58, 0, 60];
    expect(numbers(ps, 'static readonly double[] Edge = {')).toEqual(edge);
    expect(numbers(ps, 'static readonly double[] Bloom = {')).toEqual(bloom);
    expect(numbers(swift, 'let edgeBlobs: [[Double]] = ').slice(0, edge.length)).toEqual(edge);
    expect(numbers(swift, 'let bloomBlobs: [[Double]] = ').slice(0, bloom.length)).toEqual(bloom);
    expect(numbers(py, 'BEAM_EDGE = ').slice(0, edge.length)).toEqual(edge);
    expect(numbers(py, 'BEAM_BLOOM = ').slice(0, bloom.length)).toEqual(bloom);
    // Duration and radius; the paused form uses the blues.
    expect(ps).toContain('public const double Duration = 1.96, Radius = 30,');
    expect(swift).toContain('let duration = 1.96,');
    expect(swift).toContain('let palette = paused ? ocean : sunset');
    expect(py).toContain('BEAM_DURATION = 1.96');
    expect(py).toContain('palette = BEAM_OCEAN if paused else BEAM_SUNSET');
    expect(py).toContain("run_outline(argv[argv.index('--color') + 1] if '--color' in argv else '#ff7a45', '--paused' in argv)");
  });

  it('the Windows glow lies outside the window (inward only where there is no outside), at a capped rate', () => {
    const ps = read('scripts', 'window-outline.ps1');
    // The strips start a margin out from the frame; the glow is not drawn inside it.
    expect(ps).toContain('new int[] { -m, -m, m + c, m + c,');
    expect(ps).toContain('} else if (x < 0 || y < 0 || x > w || y > h) {');
    // The desktop, and a maximized or full-screen window, get the inward form.
    expect(ps).toContain('bool inward = desk;');
    expect(ps).toMatch(/if \(on && GetMonitorInfo\(screen, ref info\) && \(IsZoomed\(t\)/);
    // 12.5 frames a second while it breathes; the paused and still forms are drawn once.
    expect(ps).toContain('frame.Interval = 80;');
    expect(ps).toContain('frame.Tick += (s, e) => { if (shown && turning) Paint(false); };');
  });

  it('the macOS beam keeps its GPU work to the edge band (#414): small gradient layers, no masks, filters or shadows', () => {
    const swift = read('scripts', 'mac', 'overlay.swift');
    const outline = swift.slice(swift.indexOf('func windowOutline()'));
    expect(outline).not.toMatch(/\.mask\s*=|CIFilter|\.filters\s*=|backgroundFilters|compositingFilter|shadowOpacity|shadowRadius|shadowPath/);
    expect(outline).toContain('layer.type = .radial');
    expect(outline).toContain('layer.contentsScale = scale');
    expect(outline).toContain('a.autoreverses = true');
    expect(outline).toContain('a.preferredFrameRateRange = CAFrameRateRange(minimum: 8, maximum: 15, preferred: 12)');
    // The window is the target and the glow's margin, or the screen itself (drawn inward).
    expect(outline).toContain('let frame = target.screen ? target.frame : target.frame.insetBy(dx: -margin, dy: -margin)');
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
