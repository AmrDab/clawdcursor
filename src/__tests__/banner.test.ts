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
import { stopControl, __setControlDirForTests, __setForegroundReaderForTests } from '../core/control';
import { guardInputMethods } from '../platform/pointer-guard';
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

  it('a pause after the idle hide goes round the window the card names, not nothing', async () => {
    // The idle hide forgets the outline's window; the card still names the app the agent last worked in (control.ts).
    __setForegroundReaderForTests(async () => ({ processId: 100, processName: 'msedge', title: 'Inbox - Edge', handle: 0x5a0 }));
    try {
      controlBanner.touch();
      await guardInputMethods({ async keyPress(_k: string) {} }).keyPress('a');
      vi.advanceTimersByTime(30_001);   // the idle hide
      expect(live()).toEqual([]);
      controlBanner.showPaused({ id: 1, message: 'Sign in', since: 0 }, () => {});
      expect(live()[0].written).toEqual(['TARGET 1440 100']);
    } finally {
      __setForegroundReaderForTests(null);
    }
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

  it('no outline drawer sizes a window to a screen', () => {
    expect(read('scripts', 'window-outline.ps1')).not.toMatch(/AllScreens|PrimaryScreen|\.Bounds\b/);
    const swift = read('scripts', 'mac', 'overlay.swift');
    expect(swift.slice(swift.indexOf('func windowOutline()'))).not.toMatch(/screen\.frame|NSScreen\.screens/);
    const py = read('scripts', 'linux', 'overlay.py');
    const start = py.indexOf('def run_outline(');
    expect(py.slice(start, py.indexOf('\ndef ', start + 1))).not.toMatch(/get_monitor|get_n_monitors/);
  });

  it('the pill\'s orb is still where the OS is set to reduce motion (#392)', () => {
    expect(read('scripts', 'banner.ps1')).toContain('if (SystemParametersInfo(0x1042, 0, out animate, 0) && !animate) return;');
    const swift = read('scripts', 'mac', 'overlay.swift');
    expect(swift).toContain('if window == nil || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { return }');
  });

  // The orb is a port of Thinking Orbs (libraries.dev, MIT): its notice goes with it. The outline is 2.0.0's again, so
  // nothing of Border Beam is left to credit.
  it('the orb carries the library\'s licence notice (#392)', () => {
    const pill = read('scripts', 'banner.ps1');
    expect(pill).toContain('Thinking Orbs - MIT License - Copyright (c) 2026 Jakub Antalik');
    expect(pill).toContain('The above copyright notice and this permission notice shall be included in all copies or substantial portions of');
    expect(pill).toContain('MIT License, Copyright (c) 2026 Jakub');
    const swift = read('scripts', 'mac', 'overlay.swift');
    expect(swift).toContain('MIT License,\n// Copyright (c) 2026 Jakub Antalik');
    // Both ports point at the notice where it is.
    expect(pill).toContain('the notice is in full at the top of this file');
    expect(swift).toContain('The licence notice in full is at the top of scripts/banner.ps1');
    for (const src of [pill, swift, read('scripts', 'window-outline.ps1'), read('scripts', 'linux', 'overlay.py')]) {
      expect(src).not.toMatch(/Border Beam|border-beam/);
    }
  });

  it('the macOS outline is the 2.0 border: 3 pt inside the agent\'s window, amber (blue when paused), still, click-through, under the pill', () => {
    const swift = read('scripts', 'mac', 'overlay.swift');
    const outline = swift.slice(swift.indexOf('func windowOutline()'));
    expect(outline).toContain('view.layer?.borderColor = hexColor(option("--color", "#f59e0b")).cgColor');
    expect(outline).toContain('view.layer?.borderWidth = 3');
    expect(outline).toContain('win.ignoresMouseEvents = true');
    expect(outline).toContain('win.level = .floating');
    expect(outline).toContain('win.sharingType = .none');
    expect(swift).toContain('panel.level = .screenSaver');
    // Drawn once: no beam layers and nothing animated.
    expect(outline).not.toMatch(/CAShapeLayer|CAGradientLayer|CABasicAnimation|CAKeyframeAnimation|lineDashPhase/);
  });

  it('the macOS outline goes only round a window of the app in front that is on screen and can be seen', () => {
    const swift = read('scripts', 'mac', 'overlay.swift');
    const find = swift.slice(swift.indexOf('func targetFrame()'), swift.indexOf('func windowOutline()'));
    expect(find).toContain('NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(targetPid)');
    expect(find).toContain('CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)');
    expect(find).toContain('((w[kCGWindowAlpha as String] as? Double) ?? 1) > 0.01');
    expect(find).toContain('rect.width >= 40, rect.height >= 40 else { continue }');
    // No stand-in: with no such window nothing is drawn (the pill alone shows control).
    expect(find).not.toMatch(/mouseLocation|visibleFrame|pointerScreen/);
    expect(swift).toMatch(/line == "TARGET" \|\| line\.hasPrefix\("TARGET "\)/);
  });

  it('the Windows outline is click-through, never activates, and stays out of captures', () => {
    const ps = read('scripts', 'window-outline.ps1');
    for (const style of ['0x00080000', '0x00000020', '0x08000000', '0x00000080', '0x00000008']) expect(ps).toContain(style);
    expect(ps).toContain('SetWindowDisplayAffinity(Handle, 0x11)');
    // Where the frame is, and where the border goes, are physical pixels on every monitor (per-monitor-v2).
    expect(ps).toContain('SetThreadDpiAwarenessContext([IntPtr](-4))');
    // Re-placed only when it moved or is no longer above its window (walking up the z-order), never on every poll.
    expect(ps).toContain('if (placed && !moved) return;');
    // TARGET and HIDE act on receipt, not on the next poll: a capture follows HIDE after 90 ms.
    expect(ps).toContain('BeginInvoke((Action)Follow)');
    // A byte-order mark in front of the first line (a .NET parent) does not lose the command.
    expect(ps).toContain('p[0].EndsWith("TARGET")');
    expect(ps).toContain('p[0].EndsWith("HIDE")');
  });

  it('the Windows outline is the thin border of 2.0.0: solid, opaque, 3 px at 100%, hollow, rounded like the window', () => {
    const ps = read('scripts', 'window-outline.ps1');
    expect(ps).toContain("[string]$Color     = '#f59e0b'");
    expect(ps).toContain('[int]   $Thickness = 3,');
    // The paused form's flag is a parameter of its own: the drawer does not depend on it landing in $args.
    expect(ps).toContain('[switch]$Paused');
    expect(ps).toContain('SetLayeredWindowAttributes(Handle, 0, 255, 2)');
    expect(ps).toContain('int b = Math.Max(2, (int)Math.Round(thickness * dpi / 96.0));');
    expect(ps).toContain('CombineRgn(frame, frame, hole, 4)');
    // Nothing of the beam: no per-pixel strips, no monitor frame for the desktop, no window title for the pill to find.
    expect(ps).not.toMatch(/UpdateLayeredWindow|BeamStrip|EnumDisplayMonitors|CLAWD_PILL_PID|IsDesktop|clawdcursor beam/);
    expect(read('scripts', 'banner.ps1')).not.toMatch(/clawdcursor beam|Raise\(\)/);
  });

  // A window can be the one in front while Windows shows nothing of it (hidden, or cloaked on another virtual desktop),
  // and its frame bounds still read as if it were there: the outline then framed empty space.
  it('the Windows outline goes round no window that Windows does not show, even the one in front', () => {
    const ps = read('scripts', 'window-outline.ps1');
    expect(ps).toContain('static extern bool IsWindowVisible(IntPtr hWnd);');
    expect(ps).toMatch(/GetForegroundWindow\(\) == t && !IsIconic\(t\) && IsWindowVisible\(t\)/);
    expect(ps).toContain('(DwmGetWindowAttribute(t, 14, out cloaked, 4) != 0 || cloaked == 0)');   // DWMWA_CLOAKED
  });
});
