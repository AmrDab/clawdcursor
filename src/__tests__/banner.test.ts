/**
 * Control banner (2026-06-12 feature): the on-screen "desktop control in
 * progress" indicator. Contract under test:
 *   - pin/unpin (autonomous task lifecycle) shows/hides exactly one child
 *   - touch (external MCP activity) shows + auto-hides after the idle window
 *   - touch while pinned never schedules a hide
 *   - BANNER_STOP on the child's stdout fires onStopRequested
 *   - disabled state spawns nothing
 *   - the screen-edge glow rides the same lifecycle as the pill and dies with it;
 *     it is told nothing while it runs (HIDE only, for a capture), is blue when paused,
 *     and CLAWD_NO_GLOW leaves the pill alone
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { controlBanner, glowFlags } from '../core/banner';
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
let glows: FakeChild[];        // edge-glow processes

beforeEach(() => {
  vi.useFakeTimers();
  spawned = [];
  glows = [];
  controlBanner.__resetForTests();
  controlBanner.__setPlatformEnabledForTests(true);
  controlBanner.__setSpawnerForTests(() => {
    const c = new FakeChild();
    spawned.push(c);
    return c as unknown as ChildProcess;
  });
  controlBanner.__setGlowSpawnerForTests(() => {
    const c = new FakeChild();
    glows.push(c);
    return c as unknown as ChildProcess;
  });
});

afterEach(() => {
  controlBanner.__resetForTests();
  vi.useRealTimers();
});

describe('controlBanner', () => {
  it('pin shows exactly one pill + one glow; repeated pins are idempotent; unpin kills both', () => {
    controlBanner.pin();
    controlBanner.pin();
    expect(spawned.length).toBe(1);
    expect(glows.length).toBe(1);
    expect(controlBanner.isVisible()).toBe(true);
    controlBanner.unpin();
    expect(spawned[0].killed).toBe(true);
    expect(glows[0].killed).toBe(true);
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
    expect(glows.length).toBe(0);
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('child exiting on its own clears visibility (no zombie handle)', () => {
    controlBanner.pin();
    spawned[0].emit('exit', 0);
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('when the pill exits, the glow is torn down too (never desync)', () => {
    controlBanner.pin();
    expect(glows.length).toBe(1);
    spawned[0].emit('exit', 0);          // pill dies on its own
    expect(glows[0].killed).toBe(true);
  });

  it('on a non-Windows platform nothing spawns — pill OR glow (OS-safe no-op)', () => {
    controlBanner.__setPlatformEnabledForTests(false); // simulate macOS/Linux runtime
    controlBanner.pin();
    controlBanner.touch();
    expect(spawned.length).toBe(0);
    expect(glows.length).toBe(0);
    expect(controlBanner.isVisible()).toBe(false);
  });
});

describe('the screen-edge glow', () => {
  const live = () => glows.filter(o => !o.killed);

  it('is told nothing while it runs: it is on for as long as the pill is, over the whole screen', () => {
    controlBanner.pin();
    expect(glows[0].written).toEqual([]);
  });

  it('the paused glow is spawned paused and blue on every OS; the running one amber (the default), with no colour flag', () => {
    const modes: unknown[] = [];
    controlBanner.__setGlowSpawnerForTests(mode => { modes.push(mode); const c = new FakeChild(); glows.push(c); return c as unknown as ChildProcess; });
    controlBanner.pin();
    controlBanner.showPaused({ id: 1, message: 'Sign in', since: 0 }, () => {});
    expect(modes).toEqual([{ paused: undefined }, { paused: expect.objectContaining({ id: 1 }) }]);
    expect(glows[0].killed).toBe(true);
    expect(live()).toHaveLength(1);
    for (const os of ['win32', 'darwin', 'linux'] as const) expect(glowFlags(false, os)).toEqual([]);
    expect(glowFlags(true, 'win32')).toEqual(['-Color', '#3b82f6']);
    expect(glowFlags(true, 'darwin')).toEqual(['--color', '#3b82f6']);
    expect(glowFlags(true, 'linux')).toEqual(['--color', '#3b82f6']);
  });

  it('on Windows it is told the pill\'s pid, so it can stay under it; elsewhere not', () => {
    expect(glowFlags(false, 'win32', 4321)).toEqual(['-PillPid', '4321']);
    expect(glowFlags(true, 'win32', 4321)).toEqual(['-Color', '#3b82f6', '-PillPid', '4321']);
    expect(glowFlags(false, 'win32')).toEqual([]);
    expect(glowFlags(false, 'darwin', 4321)).toEqual([]);
    expect(glowFlags(true, 'linux', 4321)).toEqual(['--color', '#3b82f6']);
  });

  it('CLAWD_NO_GLOW leaves the pill alone: no glow is spawned', () => {
    controlBanner.__setGlowEnabledForTests(false);
    controlBanner.pin();
    expect(spawned).toHaveLength(1);
    expect(glows).toHaveLength(0);
  });

  it('the idle hide takes it down with the pill; the next touch brings both back', () => {
    controlBanner.touch();
    expect(glows).toHaveLength(1);
    vi.advanceTimersByTime(30_001);
    expect(live()).toEqual([]);
    expect(controlBanner.isVisible()).toBe(false);
    controlBanner.touch();
    expect(live()).toHaveLength(1);
  });

  it('a capture step-aside (Linux) hides the glow as well as the pill; a click dodge leaves the click-through glow', async () => {
    vi.useRealTimers();
    controlBanner.pin();
    await controlBanner.dodge();
    expect(glows[0].written).toEqual([]);
    await controlBanner.dodge(1500, true);
    expect(spawned[0].written).toEqual(['HIDE 1500', 'HIDE 1500']);
    expect(glows[0].written).toEqual(['HIDE 1500']);
  });

  it('Linux: a glow that says GLOW_READY has the pill hide for a moment, so the pill comes back above it', async () => {
    vi.useRealTimers();
    controlBanner.pin();
    expect(spawned[0].written).toEqual([]);
    glows[0].stdout.write('GLOW_READY\n');
    await new Promise(r => setImmediate(r));
    expect(spawned[0].written).toEqual(['HIDE 50']);
  });
});

describe('captures where the OS cannot keep the overlay out', () => {
  it('a glow that says GLOW_CAPTURABLE (Windows 10 before 2004) steps aside with the pill before a capture', async () => {
    vi.useRealTimers();
    controlBanner.pin();
    if (process.platform !== 'linux') {
      await controlBanner.beforeCapture();
      expect(glows[0].written).toEqual([]);   // excluded by the OS: nothing to hide
    }
    glows[0].stdout.write('GLOW_CAPTURABLE\n');
    await new Promise(r => setImmediate(r));
    await controlBanner.beforeCapture();
    expect(spawned[0].written).toEqual(['HIDE 1500']);
    expect(glows[0].written).toEqual(['HIDE 1500']);
  });
});

// A host that hard-kills this process runs no exit hook: every drawer leaves when its stdin closes.
describe('no overlay outlives its parent', () => {
  const read = (...p: string[]) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', ...p), 'utf8');
  it('every drawer exits on stdin EOF, the pill included', () => {
    for (const ps of [read('banner.ps1'), read('edge-glow.ps1')]) {
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

// The drawers put real windows on screen, so these read the source.
describe('the glow drawers', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

  it('the pill\'s orb is still where the OS is set to reduce motion (#392)', () => {
    expect(read('scripts', 'banner.ps1')).toContain('if (SystemParametersInfo(0x1042, 0, out animate, 0) && !animate) return;');
    const swift = read('scripts', 'mac', 'overlay.swift');
    expect(swift).toContain('if window == nil || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { return }');
  });

  it('the window outline and its TARGET protocol are gone from every drawer', () => {
    expect(existsSync(join(root, 'scripts', 'window-outline.ps1'))).toBe(false);
    for (const src of [read('src', 'core', 'banner.ts'), read('scripts', 'mac', 'overlay.swift'), read('scripts', 'linux', 'overlay.py')]) {
      expect(src).not.toMatch(/window-outline|TARGET|OUTLINE_CAPTURABLE|windowOutline|run_outline/);
    }
  });

  it('the macOS glow is 1.5.23\'s: amber (blue when paused), pulsing, every display, click-through, above apps, under the pill, not captured', () => {
    const swift = read('scripts', 'mac', 'overlay.swift');
    const glow = swift.slice(swift.indexOf('func glow()'));
    expect(glow).toContain('option("--color", "#f59e0b")');
    expect(glow).toContain('option("--thickness", "80")');
    expect(glow).toContain('for screen in NSScreen.screens');
    expect(glow).toContain('CABasicAnimation(keyPath: "opacity")');
    expect(glow).toContain('win.ignoresMouseEvents = true');
    expect(glow).toContain('win.level = .statusBar');
    expect(glow).toContain('win.sharingType = .none');
    expect(glow).toContain('listenForCommands()');   // its stdin: the EOF ends it
    expect(swift).toContain('panel.level = .screenSaver');   // the pill's level is above .statusBar
  });

  it('the Windows glow is click-through, never activates, stays out of captures, and sits under the pill', () => {
    const ps = read('scripts', 'edge-glow.ps1');
    for (const style of ['0x00080000', '0x00000020', '0x08000000', '0x00000080', '0x00000008']) expect(ps).toContain(style);
    expect(ps).toContain('SetWindowDisplayAffinity(Handle, 0x11)');
    expect(ps).toContain('Console.Out.WriteLine("GLOW_CAPTURABLE")');
    // Physical pixels on every monitor (per-monitor-v2), the depth scaled by each monitor's DPI.
    expect(ps).toContain('SetThreadDpiAwarenessContext(new IntPtr(-4))');
    expect(ps).toContain('EnumDisplayMonitors');
    expect(ps).toContain('thickness * m[4] / 96.0');
    // Directly under the pill's lowest window, not over it.
    expect(ps).toContain('SetWindowPos(f.Handle, pill, 0, 0, 0, 0, 0x13)');
    // HIDE acts on receipt, not on the next tick (a capture follows HIDE after 90 ms); a byte-order mark does not lose it.
    expect(ps).toContain('first.BeginInvoke(update)');
    expect(ps).toContain('p[0].EndsWith("HIDE")');
    // Amber by default, 1.5.23's depth, alpha and period.
    expect(ps).toContain("[string]$Color       = '#f59e0b'");
    expect(ps).toContain('[int]   $Thickness   = 80,');
    expect(ps).toContain('[int]   $PeakAlpha   = 200,');
    expect(ps).toContain('[int]   $PeriodMs    = 1600,');
  });

  it('the Linux glow covers every monitor, is click-through, and steps aside on HIDE', () => {
    const py = read('scripts', 'linux', 'overlay.py');
    const glow = py.slice(py.indexOf('def run_glow('), py.indexOf('\ndef main('));
    expect(glow).toContain('display.get_n_monitors()');
    expect(glow).toContain('win.input_shape_combine_region(cairo.Region())');
    expect(glow).toContain("emit('GLOW_READY')");
    expect(glow).toContain("parts[0] == 'HIDE'");
    expect(py).toContain("opt('--color', '#f59e0b')");
  });
});
