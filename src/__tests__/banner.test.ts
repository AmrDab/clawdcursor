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
import { controlBanner, outlineFlags, glowFlags } from '../core/banner';
import { stopControl, __setControlDirForTests, __setForegroundReaderForTests } from '../core/control';
import { guardInputMethods, setOwnUiPids } from '../platform/pointer-guard';
import { withForegroundBurst } from '../platform/foreground-burst';
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
let glows: FakeChild[];        // full-screen glow processes (foreground mode)

beforeEach(() => {
  vi.useFakeTimers();
  spawned = [];
  outlines = [];
  glows = [];
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

// Two modes (owner, 2026-11-17): background acts get the window frame alone; the full-screen glow is up only while the
// agent's input goes to the foreground (a guarded SendInput method, or an R2 burst), plus a short tail.
describe('the indicator has two modes', () => {
  const TAIL = 1_500;
  const states = (g: FakeChild) => g.written.filter(l => l === 'ON' || l === 'OFF');

  it('a background act (by name, a window message, a page act) keeps the window frame and never raises the full-screen glow', async () => {
    controlBanner.pin();
    const d = guardInputMethods({
      async invokeElement(_q: unknown) { return { success: true }; }, async deliverToWindow(_q: unknown) { return { ok: true }; },
      async navigate(_u: string) {}, async typeInField(_q: unknown) {},
    });
    await d.invokeElement({ name: 'Save' });
    await d.deliverToWindow({ processId: 100 });
    await d.navigate('https://example.com');
    await d.typeInField({ text: 'x' });
    controlBanner.setWorkingWindow({ processId: 100, handle: 0x5a0 });
    expect(outlines[0].written).toEqual(['TARGET 1440 100']);
    expect(glows).toHaveLength(1);
    expect(glows[0].written).toEqual([]);   // spawned hidden, never told to show
  });

  it('a foreground input raises the glow, and it goes down ~1.5 s after the last one', async () => {
    controlBanner.pin();
    const d = guardInputMethods({ async typeText(_t: string) {}, async mouseClick(_x: number, _y: number) {} });
    await d.typeText('a');
    expect(states(glows[0])).toEqual(['ON']);
    vi.advanceTimersByTime(TAIL - 100);
    await d.mouseClick(1, 1);   // another input restarts the tail
    vi.advanceTimersByTime(TAIL - 100);
    expect(states(glows[0])).toEqual(['ON', 'ON']);
    vi.advanceTimersByTime(101);
    expect(states(glows[0])).toEqual(['ON', 'ON', 'OFF']);
    expect(outlines[0].killed).toBe(false);   // the window frame is untouched throughout
  });

  it('an R2 burst keeps it up for the whole burst, then the tail', async () => {
    controlBanner.pin();
    const w = { processId: 42, handle: 900 };
    const user = { processId: 10, handle: 500 };
    let fg = user;
    let release!: () => void;
    const hold = new Promise<void>(r => { release = r; });
    const run = withForegroundBurst({
      getActiveWindow: async () => fg as never,
      focusWindow: async () => { fg = w; return true; },
      restoreForeground: async () => { fg = user; return true; },
      userIdle: async () => ({ tick: 1, idleMs: 5000 }),
      cursorPos: async () => null,
      mouseMove: async () => {},
    }, { processId: 42 }, async () => { await hold; });
    await vi.advanceTimersByTimeAsync(0);
    expect(states(glows[0])).toEqual(['ON']);
    await vi.advanceTimersByTimeAsync(10 * TAIL);   // far longer than the tail: still up, the burst is not over
    expect(states(glows[0])).toEqual(['ON']);
    release();
    await run;
    expect(states(glows[0])).toEqual(['ON', 'ON']);
    vi.advanceTimersByTime(TAIL + 1);
    expect(states(glows[0])).toEqual(['ON', 'ON', 'OFF']);
  });

  it('a paused burst turns the glow off at once (no tail), keeps the pill, and resume turns it back on', () => {
    controlBanner.pin();
    controlBanner.setActivity('Typing in Edge');
    controlBanner.burstEvent('start');
    controlBanner.burstEvent('pause');
    expect(states(glows[0])).toEqual(['ON', 'OFF']);
    expect(controlBanner.isVisible()).toBe(true);
    expect(spawned[0].written).toContain('ACTIVITY Paused — your turn');
    controlBanner.burstEvent('resume');
    expect(states(glows[0])).toEqual(['ON', 'OFF', 'ON']);
    expect(spawned[0].written.at(-1)).toBe('ACTIVITY Typing in Edge');
    vi.advanceTimersByTime(10 * TAIL);
    expect(states(glows[0])).toEqual(['ON', 'OFF', 'ON']);   // up for the rest of the burst
    controlBanner.burstEvent('pause');
    controlBanner.burstEvent('end');   // given up while paused: the glow is already down, nothing flashes
    vi.advanceTimersByTime(10 * TAIL);
    expect(states(glows[0])).toEqual(['ON', 'OFF', 'ON', 'OFF']);
  });

  it('the glow rides the pill: killed with it, never spawned in the paused form, spawned again after it', () => {
    controlBanner.pin();
    controlBanner.showPaused({ id: 1, message: 'Sign in', since: 0 }, () => {});
    expect(glows[0].killed).toBe(true);
    expect(glows).toHaveLength(1);   // no glow while paused
    controlBanner.showRunning();
    expect(glows).toHaveLength(2);
    controlBanner.unpin();
    expect(glows[1].killed).toBe(true);
    expect(glowFlags(7)).toEqual(['-PillPid', '7']);
  });
});

// The drawers put real windows on screen, so these read the source: the window frame never sizes to a screen; the glow
// is the full-screen drawer, hidden until told ON.
describe('the full-screen glow is the foreground-mode drawer only', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

  it('no outline drawer sizes a window to a screen; only the glow drawer does, and it starts hidden', () => {
    const glow = read('scripts', 'edge-glow.ps1');
    expect(glow).toContain('Monitors()');
    for (const style of ['0x00080000', '0x00000020', '0x08000000', '0x00000080']) expect(glow).toContain(style);
    expect(glow).toContain('bool shown = false;');
    expect(glow).toContain('bool want = on && ');
    expect(read('scripts', 'window-outline.ps1')).not.toMatch(/AllScreens|PrimaryScreen|\.Bounds\b/);
    const swift = read('scripts', 'mac', 'overlay.swift');
    expect(swift.slice(swift.indexOf('func windowOutline()'), swift.indexOf('// The ghost cursor'))).not.toMatch(/screen\.frame|NSScreen\.screens/);
    const py = read('scripts', 'linux', 'overlay.py');
    const start = py.indexOf('def run_outline(');
    expect(py.slice(start, py.indexOf('\ndef ', start + 1))).not.toMatch(/get_monitor|get_n_monitors/);
  });

  it('the pill\'s orb is still where the OS is set to reduce motion (#392)', () => {
    expect(read('scripts', 'banner.ps1')).toContain('if (SystemParametersInfo(0x1042, 0, out animate, 0) && !animate) return;');
    const swift = read('scripts', 'mac', 'overlay.swift');
    expect(swift).toContain('if window == nil || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { return }');
  });

  it('both pills keep the orb: no mascot in the pill (owner, 2026-11-18)', () => {
    const pill = read('scripts', 'banner.ps1');
    expect(pill).toContain('public class Orb : Control');
    expect(pill).not.toMatch(/class Mascot|MASCOT/);
    const swift = read('scripts', 'mac', 'overlay.swift');
    expect(swift).toContain('let orb = makeOrb()');
    expect(swift).not.toMatch(/MascotView|makeMascot|MASCOT/);
  });

  it('the macOS outline is the 2.0 border: 3 pt inside the agent\'s window, amber (blue when paused), still, click-through, under the pill', () => {
    const swift = read('scripts', 'mac', 'overlay.swift');
    const outline = swift.slice(swift.indexOf('func makeOutlineWindow()'), swift.indexOf('// The ghost cursor'));
    expect(outline).toContain('view.layer?.borderColor = hexColor(outlineColor).cgColor');
    expect(outline).toContain('view.layer?.borderWidth = 3');
    expect(outline).toContain('win.ignoresMouseEvents = true');
    expect(outline).toContain('win.level = .normal');   // ordered just above the agent's window, not above the user's
    expect(outline).toContain('win.sharingType = .none');
    expect(swift).toContain('panel.level = .screenSaver');
    // Drawn once: no beam layers and nothing animated.
    expect(outline).not.toMatch(/CAShapeLayer|CAGradientLayer|CABasicAnimation|CAKeyframeAnimation|lineDashPhase/);
  });

  it('the macOS outline goes only round a window that is on screen and can be seen', () => {
    const swift = read('scripts', 'mac', 'overlay.swift');
    const find = swift.slice(swift.indexOf('func seenFrame('), swift.indexOf('func makeOutlineWindow()'));
    expect(find).toContain('CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)');
    expect(find).toContain('((w[kCGWindowAlpha as String] as? Double) ?? 1) > 0.01');
    expect(find).toContain('rect.width >= 40, rect.height >= 40');
    // No stand-in: with no such window nothing is drawn (the pill alone shows control).
    expect(find).not.toMatch(/mouseLocation|visibleFrame|pointerScreen/);
    expect(swift).toMatch(/line == "TARGET" \|\| line\.hasPrefix\("TARGET "\)/);
  });

  it('the Windows pill stays in front, can be dragged, and shows an amber outline when it appears', () => {
    const ps = read('scripts', 'banner.ps1');
    // In front: re-asserted on the existing timers, only when a visible window is above it, never activating.
    expect(ps).toContain('SetWindowPos(Handle, (IntPtr)(-1), 0, 0, 0, 0, 0x13)');   // HWND_TOPMOST, NOACTIVATE|NOMOVE|NOSIZE
    expect(ps).toContain('if (IsWindowVisible(w))');
    expect((ps.match(/\$form\.KeepOnTop\(\)/g) ?? []).length).toBe(2);   // the running and the paused timer
    // Dragging: by hand with the mouse, on the body only; the position is kept, on screen, instead of top-centre.
    expect(ps).toContain('function Enable-Drag(');
    expect(ps).toContain('foreach ($c in @($form, $dot, $brand, $activity, $elapsed)) { Enable-Drag $c }');
    expect(ps).toContain('foreach ($c in @($form, $dot, $title, $msg)) { Enable-Drag $c }');
    expect(ps).not.toMatch(/Enable-Drag \$(stop|yes|no|send|reply)/);
    expect(ps).toContain('if ($script:userPos) { $at = Get-OnScreen $script:userPos $f }');
    // Appearing: solid amber outline for 3 s, then a fade: not a loop.
    expect(ps).toContain('function Start-Pulse');
    expect(ps).toContain('if ($k -le 0) { $script:pulse.Stop() }');
  });

  it('the Windows outline is click-through, never activates, and stays out of captures', () => {
    const ps = read('scripts', 'window-outline.ps1');
    for (const style of ['0x00080000', '0x00000020', '0x08000000', '0x00000080']) expect(ps).toContain(style);
    expect(ps).toContain('SetWindowDisplayAffinity(Handle, 0x11)');
    // Where the frame is, and where the border goes, are physical pixels on every monitor (per-monitor-v2).
    expect(ps).toContain('SetThreadDpiAwarenessContext([IntPtr](-4))');
    // Re-placed only when it moved or is no longer above its window (walking up the z-order), never on every poll.
    expect(ps).toContain('if (placed && !moved) return;');
    // TARGET and HIDE act on receipt, not on the next poll: a capture follows HIDE after 90 ms.
    expect(ps).toContain('BeginInvoke((Action)FollowAll)');
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
    expect(ps).toMatch(/!IsIconic\(t\)\s+&& IsWindowVisible\(t\)/);
    expect(ps).toContain('(DwmGetWindowAttribute(t, 14, out cloaked, 4) != 0 || cloaked == 0)');   // DWMWA_CLOAKED
  });

  // Plan (h): an agent window has its border while it is visible, in front or not, without drawing over the user's window.
  it('the Windows outline is not topmost: it sits directly above its window, and shows while that window is not in front', () => {
    const ps = read('scripts', 'window-outline.ps1');
    expect(ps).not.toContain('GetForegroundWindow');
    expect(ps).not.toContain('ExStyle |= 0x00000008');
    expect(ps).toContain('IntPtr above = GetWindow(target, 3); // GW_HWNDPREV');
    expect(ps).toContain('SetWindowPos(Handle, above, ');
    expect(ps).not.toContain('new IntPtr(-1)');
  });

  it('with several agent windows the outline is sent them all, the working one first (Windows)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let fg: { processId: number; processName: string; handle: number } = { processId: 100, processName: 'msedge', handle: 0x5a0 };
    __setForegroundReaderForTests(async () => fg);
    try {
      controlBanner.pin();
      const d = guardInputMethods({ async keyPress(_k: string) {}, async focusWindow(_q: unknown) { fg = { processId: 300, processName: 'notepad', handle: 0x7b2 }; return true; } });
      await d.keyPress('a');
      await d.focusWindow({ processId: 300 });
      await d.keyPress('b');
      expect(outlines[0].written).toEqual(['TARGET 1440 100', 'TARGET 1970 300 1440 100']);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      __setForegroundReaderForTests(null);
    }
  });
});

describe('the window frame never goes round clawdcursor\'s own windows', () => {
  it('a working window or an agent window that is an overlay is never sent as a TARGET', () => {
    setOwnUiPids(() => [777]);
    try {
      controlBanner.pin();
      controlBanner.setWorkingWindow({ processId: 100, handle: 0x5a0 });
      controlBanner.setWorkingWindow({ processId: 777, handle: 0x9f0 });
      expect(outlines[0].written).toEqual(['TARGET 1440 100']);
    } finally {
      setOwnUiPids(() => [...controlBanner.overlayPids()]);
    }
  });
});
