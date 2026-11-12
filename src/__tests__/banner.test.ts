/**
 * Control banner (2026-06-12 feature): the on-screen "desktop control in
 * progress" indicator. Contract under test:
 *   - pin/unpin (autonomous task lifecycle) shows/hides exactly one child
 *   - touch (external MCP activity) shows + auto-hides after the idle window
 *   - touch while pinned never schedules a hide
 *   - BANNER_STOP on the child's stdout fires onStopRequested
 *   - disabled state spawns nothing
 *   - the window outline rides the same lifecycle as the pill and dies with it;
 *     it is told which window the agent works in; when the agent acts with none, the monitor (#392)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { controlBanner } from '../core/banner';
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

  it('is told when the agent acts with no window any more: it goes around the monitor instead (#392)', () => {
    controlBanner.pin();
    controlBanner.setWorkingWindow({ processId: 100, handle: 0x5a0 });
    controlBanner.setWorkingWindow(undefined);
    expect(outlines[0].written).toEqual(['TARGET 1440 100', 'TARGET MONITOR']);
  });

  it('the paused outline is the blue one, told it is paused: no travelling highlight', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'banner.ts'), 'utf8');
    expect(src).toContain("['-Color', PAUSED_OUTLINE, '-Paused']");
    expect(src).toContain("['--color', PAUSED_OUTLINE, '--paused']");
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

  it('an outline goes around a screen only when the agent works with no window: the one the pointer is on (#392)', () => {
    const ps = read('scripts', 'window-outline.ps1');
    expect(ps).not.toMatch(/AllScreens|PrimaryScreen|\.Bounds\b/);
    expect(ps).toContain('monitor = p.Length > 1 && p[1] == "MONITOR"');
    expect(ps).toContain('bool desk = on && (monitor || (t != IntPtr.Zero && GetForegroundWindow() == t && IsDesktop(t)));');
    expect(ps).toContain('MonitorFromPoint(at, 2)');
    const swift = read('scripts', 'mac', 'overlay.swift');
    expect(swift.slice(swift.indexOf('func windowOutline()'))).not.toMatch(/screen\.frame|NSScreen\.screens/);
    expect(swift).toContain('parts[1] == "MONITOR"');
    expect(swift).toContain('if targetMonitor { return pointerScreen() }');
    const py = read('scripts', 'linux', 'overlay.py');
    const start = py.indexOf('def run_outline(');
    const outline = py.slice(start, py.indexOf('\ndef ', start + 1));
    expect(outline).not.toMatch(/get_n_monitors|get_primary_monitor/);
    expect(outline).toMatch(/if state\['monitor'\]:[\s\S]*?get_monitor_at_point\(px, py\)/);
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

  // The look is a port of Border Beam and Thinking Orbs (libraries.dev, MIT): the library's own numbers, with its notice.
  it('the beam and the orb carry the library\'s recipe and its licence notice (#392)', () => {
    const ps = read('scripts', 'window-outline.ps1');
    expect(ps).toContain('Border Beam - MIT License - Copyright (c) 2026 Jakub Antalik');
    expect(ps).toContain('The above copyright notice and this permission notice shall be included in all copies or substantial portions of');
    expect(ps).toContain('const double TurnSeconds = 1.96, HueSeconds = 12, HueRange = 10, FadeInSeconds = 0.6;');
    expect(ps).toContain('BeamMask = { 0, 0, 30, 0, 36, .1, 44, .35, 52, 1, 80, 1, 86, .35, 92, .1, 95, 0, 100, 0 }');
    // Our colours on its recipe: amber while the agent works, the library's "ocean" blues while it waits.
    expect(ps).toContain('Amber = { 255, 170, 30,  255, 200, 60,  245, 130, 10,  255, 215, 90,  245, 158, 11,  255, 190, 50,  250, 120, 20,  255, 205, 70,  235, 140, 5 }');
    expect(ps).toContain('int[] tones = paused ? Ocean : Amber;');
    // On a light window the beam is stronger, with a dark highlight (the library's light theme), so it is not lost on white.
    expect(ps).toContain('double strokeOpacity = paused ? 0.94 : light ? 0.6 : 0.26, innerOpacity = light ? 0.7 : paused ? 0.34 : 0.42;');
    expect(ps).toContain('glare = light ? darkAt : whiteAt;');
    const swift = read('scripts', 'mac', 'overlay.swift');
    expect(swift).toContain('MIT License,\n// Copyright (c) 2026 Jakub Antalik');
    expect(swift).toContain('conic([(0, 0), (30, 0), (36, 0.1), (44, 0.35), (52, 1), (80, 1), (86, 0.35), (92, 0.1), (95, 0), (100, 0)])');
    expect(swift).toContain('turn.duration = 1.96');
    expect(swift).toContain('let tones = paused ? ocean : amberTones');
    // macOS in Light Mode: the same light theme (the system appearance stands in for the pixels Windows reads).
    expect(swift).toContain('stroke.opacity = paused ? 0.94 : light ? 0.6 : 0.26');
    const pill = read('scripts', 'banner.ps1');
    expect(pill).toContain('MIT License, Copyright (c) 2026 Jakub');
    expect(pill).toContain('const double Speed = 3.9, Sized = 2.4;');
    expect(swift).toContain('let box = 20.0, speed = 3.9, sized = 2.4');
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
