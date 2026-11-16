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
import { controlBanner, outlineFlags, outlineEnv } from '../core/banner';
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

describe('the beam around the display', () => {
  const live = () => outlines.filter(o => !o.killed);

  it('is on from the start and is told nothing: no window is tracked, and banner.ts never writes TARGET to it', async () => {
    vi.useRealTimers();
    controlBanner.pin();
    expect(outlines[0].written).toEqual([]);
    controlBanner.setActivity('Typing in Edge');
    controlBanner.showPaused({ id: 1, message: 'Sign in', since: 0 }, () => {});
    await controlBanner.dodge(1500, true);
    for (const o of outlines) expect(o.written.filter(l => l.includes('TARGET'))).toEqual([]);
    expect((controlBanner as unknown as Record<string, unknown>).setWorkingWindow).toBeUndefined();
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

  it('the outline is told the pill\'s pid (CLAWD_PILL_PID) so the beam never fights the pill for the top', () => {
    const modes: { pillPid?: number }[] = [];
    controlBanner.__setSpawnerForTests(() => { const c = new FakeChild(); (c as unknown as { pid: number }).pid = 4242; spawned.push(c); return c as unknown as ChildProcess; });
    controlBanner.__setOutlineSpawnerForTests(mode => { modes.push(mode); const c = new FakeChild(); outlines.push(c); return c as unknown as ChildProcess; });
    controlBanner.pin();
    controlBanner.showPaused({ id: 1, message: 'Sign in', since: 0 }, () => {});
    expect(modes.map(m => m.pillPid)).toEqual([4242, 4242]);
    expect(outlineEnv({ pillPid: 4242 }).CLAWD_PILL_PID).toBe('4242');
    expect(outlineEnv({}).CLAWD_PILL_PID).toBeUndefined();
  });

  it('the paused form replaces the running outline process, and starts with nothing sent', () => {
    controlBanner.pin();
    controlBanner.showPaused({ id: 1, message: 'Sign in', since: 0 }, () => {});
    expect(outlines[0].killed).toBe(true);
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

// Mac run 2026-11-15: with the Claude desktop app in front, a click into the pause card's box gave it no keyboard.
describe('the macOS pause card takes the keyboard for an answer', () => {
  const swift = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'mac', 'overlay.swift'), 'utf8');
  it('the panel opens allowKey for a press on the box before AppKit handles it, not only the first time', () => {
    // AppKit makes a clicked window key in NSWindow.sendEvent, before mouseDown; with canBecomeKey false then, that is dropped.
    const panel = swift.slice(swift.indexOf('final class PillPanel'), swift.indexOf('/// Set while the user types'));
    expect(panel).toMatch(/override func sendEvent\(_ event: NSEvent\)/);
    expect(panel).toMatch(/event\.type == \.leftMouseDown, !isKeyWindow,\s*let target = keyboardTarget\(at: event\.locationInWindow\)/);
    expect(panel).toMatch(/typingReply = true\s*\n\s*allowKey = true\s*\n\s*super\.sendEvent\(event\)/);
    expect(panel).toMatch(/if !isKeyWindow \{ takeKeyboard\(self, target\) \}/);
    // Only the box (or its field editor): a button press can be dragged off, and must not leave the card holding the keys.
    const target = panel.slice(panel.indexOf('func keyboardTarget('), panel.indexOf('override func sendEvent('));
    expect(target).toMatch(/v is ClickToTypeField \{ return v \}/);
    expect(target).not.toMatch(/FirstClickButton/);
    const field = swift.slice(swift.indexOf('final class ClickToTypeField'), swift.indexOf('func takeKeyboard('));
    expect(field).not.toMatch(/mouseDown/);
  });
  it('takeKeyboard is synchronous and asks for activation only when the panel is still not key; "Something else" goes the same way', () => {
    const take = swift.slice(swift.indexOf('func takeKeyboard('), swift.indexOf('final class PillView'));
    expect(take).not.toMatch(/DispatchQueue/);
    expect(take).toMatch(/if !panel\.isKeyWindow \{[\s\S]*NSApp\.activate\(\)[\s\S]*panel\.makeKeyAndOrderFront\(nil\)\s*\n\s*\}/);
    // A box being edited keeps its field editor (re-making it first responder selects the whole answer).
    expect(take).toMatch(/if \(field as\? NSControl\)\?\.currentEditor\(\) == nil \{ panel\.makeFirstResponder\(field\) \}/);
    // NSApp.activate() exists only in the macOS 14 SDK: older toolchains (macOS 12 is supported) get the old call.
    expect(take).toMatch(/#if compiler\(>=5\.9\)\s*\n\s*if #available\(macOS 14\.0, \*\) \{ NSApp\.activate\(\) \}[^\n]*\n\s*#else\s*\n\s*NSApp\.activate\(ignoringOtherApps: true\)\s*\n\s*#endif/);
    expect(swift.match(/NSApp\.activate\(\)/g)).toHaveLength(1);
    expect(swift).toMatch(/if on, let panel = pillPanel, let field = replyField \{\s*takeKeyboard\(panel, field\)/);
  });
  it('focus is handed back cooperatively, never to the other overlay process', () => {
    // yieldActivation(to:) is macOS 14 SDK: only inside the compiler check. A refused hand-back still steps down.
    const hand = swift.slice(swift.indexOf('func handBack('), swift.indexOf('func giveFocusBack('));
    expect(hand).toMatch(/#if compiler\(>=5\.9\)\s*\n\s*if #available\(macOS 14\.0, \*\) \{\s*\n\s*NSApp\.yieldActivation\(to: app\)\s*\n\s*if !app\.activate\(\) \{ NSApp\.deactivate\(\) \}[\s\S]*#endif\s*\n\s*NSApp\.deactivate\(\)\s*\n\s*app\.activate\(options: \[\]\)/);
    expect(swift.match(/NSApp\.yieldActivation\(/g)).toHaveLength(1);
    expect(swift).toMatch(/var previousApp: NSRunningApplication\? = NSWorkspace\.shared\.frontmostApplication\.flatMap \{ isOverlay\(\$0\) \? nil : \$0 \}/);
    expect(swift).toMatch(/executableURL[\s\S]*resolvingSymlinksInPath\(\) == theirs\.resolvingSymlinksInPath\(\)/);
    expect(swift).toMatch(/!isOverlay\(app\) \{\s*\n\s*previousApp = app/);
    expect(swift).toMatch(/!prev\.isTerminated, !isOverlay\(prev\) \{ handBack\(to: prev\) \}/);
    expect(swift).not.toMatch(/prev\.activate/);
    // Esc in "Something else" gives the keyboard back too: giveFocusBack() alone did nothing for a key, inactive panel.
    expect(swift).toMatch(/takeKeyboard\(panel, field\)\s*\} else \{\s*releaseKeyboard\(\)/);
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

  it('every outline drawer frames every monitor and tracks no window', () => {
    const ps = read('scripts', 'window-outline.ps1');
    expect(ps).toContain('EnumDisplayMonitors(');
    // DwmGetWindowAttribute is only for DWMWA_CLOAKED (14), never a window's frame bounds (9).
    expect(ps).not.toMatch(/GetForegroundWindow|IsIconic|DwmGetWindowAttribute\([^)]*,\s*9\s*,|GetShellWindow|p\[0\]\.EndsWith\("TARGET"\)/);
    expect(ps).toContain('LiftPill();');
    const swift = read('scripts', 'mac', 'overlay.swift');
    expect(swift.slice(swift.indexOf('func windowOutline()'))).toContain('NSScreen.screens');
    const py = read('scripts', 'linux', 'overlay.py');
    const start = py.indexOf('def run_outline(');
    const run = py.slice(start, py.indexOf('\ndef ', start + 1));
    expect(run).toContain('get_n_monitors');
    expect(run).not.toMatch(/== 'TARGET'|xid/);
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

  // The owner's pick (#392): <BorderBeam size="pulse-inner" colorVariant="gold" borderRadius={23} duration={3.9}
  // hueRange={46}>, the library's defaults otherwise (theme "dark"). The three drawers carry the library's numbers;
  // these keep them the same everywhere.
  it('every drawer draws pulse-inner in gold (paused: ocean), radius 23, 3.9 s, with the same numbers', () => {
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
    // G.gold and G.ocean (index.es.js), in order.
    const gold = [240, 190, 60, 255, 210, 90, 225, 165, 40, 250, 200, 70, 255, 225, 120, 230, 175, 50, 245, 205, 85, 215, 155, 35, 255, 215, 100];
    const ocean = [100, 80, 220, 60, 120, 255, 80, 100, 200, 50, 140, 220, 120, 80, 255, 70, 130, 255, 140, 100, 240, 90, 110, 230, 130, 70, 255];
    expect(numbers(ps, 'Gold = {')).toEqual(gold);
    expect(numbers(ps, 'Ocean = {')).toEqual(ocean);
    expect(numbers(swift, 'let gold: [[Double]] = ').slice(0, 27)).toEqual(gold);
    expect(numbers(swift, 'let ocean: [[Double]] = ').slice(0, 27)).toEqual(ocean);
    expect(numbers(py, 'BEAM_GOLD = ').slice(0, 27)).toEqual(gold);
    expect(numbers(py, 'BEAM_OCEAN = ').slice(0, 27)).toEqual(ocean);
    // Per colour: its place (G.*.border pos), the ring's size (its size, ao()), the inner glow's (Je, to()), region and
    // quarter (Fe); and the bloom's blobs (eo, Re()): colour, size. In the same order everywhere.
    const blob = [33, -7.4, 70, 40, 65, 35, 1, 0, 12, -5, 60, 35, 55, 30, 2, 0, 2.1, 68.3, 40, 70, 35, 65, 3, 2,
      2.1, 68.3, 20, 35, 15, 30, 1, 2, 74.4, 100, 180, 32, 173, 28, 2, 3, 55, 100, 85, 26, 80, 22, 3, 3,
      93.9, 0, 74, 32, 69, 28, 1, 1, 100, 27.1, 26, 42, 22, 38, 2, 1, 100, 27.1, 52, 48, 47, 44, 3, 1];
    const bloom = [0, 84, 48, 1, 72, 42, 2, 48, 84, 4, 216, 38, 5, 102, 31, 6, 89, 38, 8, 62, 58];
    expect(numbers(ps, 'static readonly double[] Blob = {')).toEqual(blob);
    expect(numbers(ps, 'static readonly double[] Bloom = {')).toEqual(bloom);
    expect(numbers(swift, 'let blobs: [[Double]] = ').slice(0, blob.length)).toEqual(blob);
    expect(numbers(swift, 'let bloomBlobs: [[Double]] = ').slice(0, bloom.length)).toEqual(bloom);
    expect(numbers(py, 'BEAM_BLOB = ').slice(0, blob.length)).toEqual(blob);
    expect(numbers(py, 'BEAM_BLOOM = ').slice(0, bloom.length)).toEqual(bloom);
    // ge("pulse-inner", dark, 3.9) (its periods times 3.9 / 2.3) and pe["pulse-inner"].dark.
    expect(ps).toContain('public const double Duration = 3.9, Radius = 23, HueSeconds = 16,');
    expect(ps).toContain('const double SP = 0.28, DR = 33, OP = 0.48, GH = 0.34;');
    expect(ps).toContain('BS = 1.9 * Duration / 2.3, SS = 2.6 * Duration / 2.3, GHS = 2.4 * Duration / 2.3;');
    expect(ps).toContain('StrokeOpacity = 1.54, InnerOpacity = 0.44, BloomOpacity = 0.66, Brightness = 0.75, Saturation = 1.2;');
    expect(swift).toContain('let duration = 3.9, sp = 0.28, dr = 33.0, op = 0.48, gh = 0.34');
    expect(swift).toContain('let band = 28.0, radius = 23.0');
    expect(swift).toContain('let bs = 1.9 * duration / 2.3, ss = 2.6 * duration / 2.3, ghs = 2.4 * duration / 2.3');
    expect(py).toContain('BEAM_DURATION = 3.9');
    expect(py).toContain('BEAM_RADIUS = 23');
    expect(py).toContain('_SP, _DR, _OP, _GH = 0.28, 33.0, 0.48, 0.34');
    expect(py).toContain('_BS, _SS, _GHS = 1.9 * BEAM_DURATION / 2.3, 2.6 * BEAM_DURATION / 2.3, 2.4 * BEAM_DURATION / 2.3');
    for (const src of [swift, py]) {
      expect(src).toContain('0.76 * 0.52 * 0.66');   // the bloom: alpha 1 - .48 / 2, the inside half of its blur, opacity .66
      expect(src).toContain('0.75 * ');             // brightness(.75)
    }
    // A full turn of the hue every 16 s, not a drift either way: hueRange (46) does nothing for the pulse sizes, in the
    // web library (io()) or its React Native port (pulseHueDegrees()).
    expect(ps).toContain('hue = moving ? 2 * Math.PI * (seconds / HueSeconds % 1) : 0;');
    expect(swift).toContain('(0...hueSteps).map { 360 * Double($0) / Double(hueSteps) }');
    expect(swift).toContain('a.duration = 16');
    expect(py).toContain('hue = 360 * (t / 16 % 1)');
    // The paused form uses the blues.
    expect(swift).toContain('let palette = paused ? ocean : gold');
    expect(py).toContain('palette = BEAM_OCEAN if paused else BEAM_GOLD');
    expect(py).toContain("run_outline(argv[argv.index('--color') + 1] if '--color' in argv else '#ff7a45', '--paused' in argv)");
  });

  it('the beam lies inside each monitor\'s edge on every drawer, at a capped rate', () => {
    const ps = read('scripts', 'window-outline.ps1');
    const swift = read('scripts', 'mac', 'overlay.swift');
    const py = read('scripts', 'linux', 'overlay.py');
    // Windows: the eight strips lie inside the monitor, 28 px deep; no outward or inward form any more.
    expect(ps).toContain('public const int Band = 28;');
    expect(ps).toContain('int[] r = { 0, 0, c, c,   w - c, 0, c, c,   w - c, h - c, c, c,   0, h - c, c, c,');
    expect(ps).toContain('d.Beam.Layout(w, h);');
    expect(ps).not.toMatch(/inward|Margin/);
    // One set of strips per monitor, laid out again when the monitors change (the 100 ms poll).
    expect(ps).toContain('List<Display> displays');
    expect(ps).toContain('poll.Interval = 100;');
    // 12.5 frames a second while it breathes, worked out and pushed only where a blob is; the paused and still forms
    // are drawn once.
    expect(ps).toContain('frame.Interval = 80;');
    expect(ps).toContain('frame.Tick += (s, e) => { if (turning) foreach (Display d in displays) if (d.Shown) Paint(d, false); };');
    expect(ps).toContain('if (lines == 0) continue;');
    // macOS: one window per screen, the screen's frame itself.
    const outline = swift.slice(swift.indexOf('func beamOn('));
    expect(outline).toContain('if win.frame != frame { win.setFrame(frame, display: true) }');
    expect(outline).not.toMatch(/margin|inward/);
    // Linux: a window per monitor, cut to the band inside its edge.
    const run = py.slice(py.indexOf('def run_outline('));
    expect(run).toContain('win.move(x, y)');
    expect(run).toContain('t = min(BEAM_BAND if composited else 3, w // 2, h // 2)');
    expect(py).not.toMatch(/inward|BEAM_MARGIN/);
  });

  it('the macOS beam keeps its GPU work to the edge band (#414): small gradient layers, no masks, filters or shadows', () => {
    const swift = read('scripts', 'mac', 'overlay.swift');
    const outline = swift.slice(swift.indexOf('func beamOn('));
    expect(outline).not.toMatch(/\.mask\s*=|CIFilter|\.filters\s*=|backgroundFilters|compositingFilter|shadowOpacity|shadowRadius|shadowPath/);
    expect(outline).toContain('layer.type = .radial');
    expect(outline).toContain('layer.contentsScale = scale');
    expect(outline).toContain('a.autoreverses = true');
    expect(outline).toContain('a.preferredFrameRateRange = CAFrameRateRange(minimum: 8, maximum: 15, preferred: 12)');
  });

  it('the Windows outline is click-through, never activates, and stays out of captures', () => {
    const ps = read('scripts', 'window-outline.ps1');
    for (const style of ['0x00080000', '0x00000020', '0x08000000', '0x00000080', '0x00000008']) expect(ps).toContain(style);
    expect(ps).toContain('SetWindowDisplayAffinity(Handle, 0x11)');
    // Where the monitors are is read in physical pixels (per-monitor-v2); the strips themselves are not DPI aware, so
    // Windows draws them at the monitor's scale.
    expect(ps).toContain('IntPtr aware = SetThreadDpiAwarenessContext(new IntPtr(-4));   // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2');
    expect(ps).toContain('SetThreadDpiAwarenessContext([IntPtr](-1))');
    // Re-placed only when a monitor's bounds changed, never on every poll.
    expect(ps).toContain('if (!moved) { RaiseIfCovered(d); continue; }');
    expect(ps).toContain('zoom != d.Zoom');
    // A foreign window above a strip: raised again without activating or showing; the pill's windows do not count.
    expect(ps).toContain('SetWindowPos(s.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0013u);');
    expect(ps).toContain('CLAWD_PILL_PID');
    // HIDE acts on receipt, not on the next poll: a capture follows HIDE after 90 ms. TARGET is ignored.
    expect(ps).toContain('sync.BeginInvoke((Action)Follow)');
    expect(ps).not.toContain('"TARGET")');
    // A byte-order mark in front of the first line (a .NET parent) does not lose the command.
    expect(ps).toContain('p[0].EndsWith("HIDE")');
  });
});
