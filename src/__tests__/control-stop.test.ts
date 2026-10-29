/**
 * #294: the user stopped clawdcursor during a batch's 30 s wait and switched to another app; the queued Ctrl+L and the
 * URL + Enter still ran, into that app, and every step said ok. Stop is now a state every process honours, and input is
 * refused when the window in front is not the one the agent was working in (control.ts, pointer-guard.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../core/banner', () => ({
  controlBanner: { overlayPids: () => [], showPaused: vi.fn(), showRunning: vi.fn(), canShow: () => true, touch: vi.fn() },
}));

import {
  stopControl, isStopped, resumeControl, sleepUnlessStopped, STOPPED_TEXT,
  __setControlDirForTests, __setForegroundReaderForTests,
} from '../core/control';
import { guardInputMethods, unguarded } from '../platform/pointer-guard';
import { ownUiRefusal, isPauseSafeCall, isStopSafeCall } from '../core/own-ui-guard';
import { pauseGate } from '../core/pause-gate';

type Win = { processId: number; processName: string; title?: string };
const EDGE: Win = { processId: 100, processName: 'msedge' };
const CLAUDE: Win = { processId: 200, processName: 'claude' };
const NOTEPAD: Win = { processId: 300, processName: 'notepad', title: 'Untitled - Notepad' };
const START: Win = { processId: 400, processName: 'StartMenuExperienceHost' };

let fg: Win | null;
let dir: string;

/** A stand-in input layer: records what reached "the OS". Activation after a click happens a moment later, as on a real OS. */
function fakeDesktop() {
  const sent: string[] = [];
  const later = (w: Win, ms = 20) => setTimeout(() => { fg = w; }, ms);
  const d = {
    sent,
    clickOpens: null as Win | null,
    focusLagMs: 0,
    async keyPress(combo: string) { sent.push(`key ${combo}`); },
    async typeText(text: string) { await d.keyPress('mod+v'); sent.push(`type ${text}`); },  // a paste: one input
    async mouseClick(x: number, y: number) { sent.push(`click ${x},${y}`); if (d.clickOpens) later(d.clickOpens); },
    async mouseUp() { sent.push('up'); },
    async invokeElement(o: { name: string }) { sent.push(`invoke ${o.name}`); return { success: true }; },
    async focusWindow(q: Win) { if (d.focusLagMs) later(q, d.focusLagMs); else fg = q; return true; },
    // The Start-menu fallback: its own keys go to the Start menu, a different process.
    // The window that comes up belongs to another process than the one started (pid 999): matched by its title.
    async openApp(name: string) { await d.keyPress('Super'); fg = START; await d.typeText(name); fg = NOTEPAD; return { pid: 999, title: 'Untitled - Notepad' }; },
  };
  return guardInputMethods(d);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-control-'));
  __setControlDirForTests(dir);
  fg = EDGE;
  __setForegroundReaderForTests(async () => fg);
  pauseGate.__resetForTests();
});
afterEach(() => {
  vi.useRealTimers();
  __setControlDirForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the window in front (#294)', () => {
  it('the issue: focus Edge, a 30 s wait, the user brings Claude forward → ctrl+l and the URL are never sent', async () => {
    const d = fakeDesktop();
    await d.focusWindow(EDGE);
    await d.keyPress('ctrl+t');
    vi.advanceTimersByTime(30_000);   // the wait
    fg = CLAUDE;
    await expect(d.keyPress('ctrl+l')).rejects.toThrow(/foreground changed: you were working in msedge \(pid 100\), but claude \(pid 200\)/);
    await expect(d.typeText('https://example.com\n')).rejects.toThrow(/foreground changed/);
    expect(d.sent).toEqual(['key ctrl+t']);
  });

  it('a paste (typeText → keyPress) is one input, checked once', async () => {
    const d = fakeDesktop();
    await d.keyPress('ctrl+l');
    await d.typeText('hi');
    expect(d.sent).toEqual(['key ctrl+l', 'key mod+v', 'type hi']);
  });

  it("a window the agent's own click brings up a moment later is its own doing; the user's switch after a gap is not", async () => {
    const d = fakeDesktop();
    d.clickOpens = NOTEPAD;
    await d.mouseClick(1, 1);
    await new Promise(r => setTimeout(r, 40));   // the OS activates Notepad after the click returned
    await d.keyPress('a');
    expect(d.sent).toEqual(['click 1,1', 'key a']);
    vi.advanceTimersByTime(10_000);
    fg = CLAUDE;
    await expect(d.keyPress('b')).rejects.toThrow(/working in notepad/);
  });

  it('plain typing does not open that window: a switch right after it is still refused', async () => {
    const d = fakeDesktop();
    await d.keyPress('a');
    vi.advanceTimersByTime(10_000);
    await d.keyPress('b');
    fg = CLAUDE;
    await expect(d.keyPress('c')).rejects.toThrow(/foreground changed/);
  });

  it('a focused window that comes up late is waited for; one that never comes is refused', async () => {
    vi.useRealTimers();  // the wait for the window is measured on the real clock
    const d = fakeDesktop();
    d.focusLagMs = 300;
    await d.focusWindow(NOTEPAD);
    await d.keyPress('x');                 // waits for Notepad to arrive
    expect(fg).toEqual(NOTEPAD);
    expect(d.sent).toEqual(['key x']);

    d.focusLagMs = 60_000;                 // the focus never takes
    await d.focusWindow(CLAUDE);
    await expect(d.keyPress('y')).rejects.toThrow(/you focused claude, but notepad/);
  }, 10_000);

  it("a launch's own Start-menu keys are not refused, and the next input binds to what opened", async () => {
    const d = fakeDesktop();
    await d.keyPress('a');                 // bound to Edge
    await d.openApp('notepad');
    await d.keyPress('b');
    expect(d.sent).toEqual(['key a', 'key Super', 'key mod+v', 'type notepad', 'key b']);
  });

  it('a shortcut that opens a window in the same app (ctrl+l) does not excuse a switch to another app right after it', async () => {
    const d = fakeDesktop();
    await d.keyPress('ctrl+l');
    vi.advanceTimersByTime(2_000);
    fg = CLAUDE;
    await expect(d.typeText('https://example.com\n')).rejects.toThrow(/working in msedge/);
  });

  it("a wait ends the agent's own-doing window: an app that comes up during it is the user's", async () => {
    vi.useRealTimers();
    const d = fakeDesktop();
    await d.keyPress('a');
    await d.mouseClick(1, 1);           // could bring another app up…
    await sleepUnlessStopped(30);       // …but the agent waits, and in the wait the user switches
    fg = CLAUDE;
    await expect(d.keyPress('b')).rejects.toThrow(/working in msedge/);
  });

  it('a launch binds to the launched window: after a gap in which the user switched, typing is refused', async () => {
    vi.useRealTimers();  // the wait for the launched window is measured on the real clock; the gap itself does not matter
    const d = fakeDesktop();
    await d.openApp('notepad');
    fg = CLAUDE;
    await expect(d.keyPress('x')).rejects.toThrow(/you opened Untitled - Notepad, but claude/);
  }, 10_000);

  it("clawdcursor's own housekeeping (the keyboard back after a pause) is neither checked nor bound", async () => {
    const d = fakeDesktop();
    await d.keyPress('a');
    stopControl('pill');
    await unguarded(() => d.focusWindow(CLAUDE));   // not refused while stopped
    expect(fg).toEqual(CLAUDE);
  });

  it('an OS that cannot say what is in front is not blocked', async () => {
    __setForegroundReaderForTests(async () => null);
    const d = fakeDesktop();
    await d.keyPress('x');
    expect(d.sent).toEqual(['key x']);
  });
});

describe('stop is a state (#294)', () => {
  it('a stop refuses input and element/page acts; a release is still sent (a held button is always let go)', async () => {
    const d = fakeDesktop();
    stopControl('pill');
    await expect(d.keyPress('Return')).rejects.toThrow(STOPPED_TEXT);
    await expect(d.mouseClick(5, 5)).rejects.toThrow(/stopped by the user/);
    await expect(d.invokeElement({ name: 'Send' })).rejects.toThrow(/stopped by the user/);
    await expect(d.focusWindow(NOTEPAD)).rejects.toThrow(/stopped by the user/);
    await d.mouseUp();
    expect(d.sent).toEqual(['up']);
  });

  it('survives a restart, and a resume from another process reaches this one (no in-process copy)', () => {
    stopControl('pill');
    __setControlDirForTests(dir);            // a fresh process reading the same data dir
    expect(isStopped()).toBe(true);
    stopControl('pill');
    fs.rmSync(path.join(dir, 'stopped.json'));   // `clawdcursor resume` in another process
    expect(isStopped()).toBe(false);
  });

  it('every call is refused while stopped — reads and waits too — except asking the user for control back', () => {
    stopControl('pill');
    const refuse = (tool: string, action?: string) => ownUiRefusal({}, isPauseSafeCall(tool, action), isStopSafeCall(tool, action));
    expect(refuse('computer', 'key')).toBe(STOPPED_TEXT);
    expect(refuse('computer', 'wait')).toBe(STOPPED_TEXT);
    expect(refuse('accessibility', 'read_tree')).toBe(STOPPED_TEXT);
    expect(refuse('system', 'pause_for_user')).toBeNull();
    expect(refuse('system', 'report')).toBeNull();
    resumeControl();
    expect(refuse('computer', 'key')).toBeNull();
  });

  it('the stop text reads right after the compact surface renames tools in it (a batch step on the real Mac came out mangled)', async () => {
    const { toCompactNames } = await import('../tools/compact');
    const text = toCompactNames(STOPPED_TEXT, 'computer');
    expect(text).toContain('call system {action:"pause_for_user"} with a message');
    expect(text).not.toMatch(/"action":"system/);
  });

  it('a wait ends within a moment of the stop, not at its end', async () => {
    vi.useRealTimers();
    const started = Date.now();
    setTimeout(() => stopControl('pill'), 50);
    expect(await sleepUnlessStopped(10_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await sleepUnlessStopped(10)).toBe(true);  // already stopped: no wait at all
  });

  it("only the user's Resume gives control back — not an agent's resume, not a detected done_when", async () => {
    vi.useRealTimers();
    stopControl('pill');
    let p = pauseGate.requestWithReply({ message: 'Continue the upload', doneWhen: async () => true, donePollMs: 5 });
    await new Promise(r => setTimeout(r, 30));          // done_when holds, but it is not watched while stopped
    expect(pauseGate.current()).not.toBeNull();
    pauseGate.answer('resume', 'agent');
    expect((await p).outcome).toBe('resumed_unverified');
    expect(isStopped()).toBe(true);

    p = pauseGate.requestWithReply({ message: 'Continue the upload' });
    pauseGate.answer('resume', 'user');
    expect((await p).outcome).toBe('resumed');
    expect(isStopped()).toBe(false);
  });
});
