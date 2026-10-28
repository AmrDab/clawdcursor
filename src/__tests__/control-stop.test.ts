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
import { guardInputMethods } from '../platform/pointer-guard';
import { ownUiRefusal, isPauseSafeCall, isStopSafeCall } from '../core/own-ui-guard';
import { pauseGate } from '../core/pause-gate';

let fg: { processId: number; processName: string } | null;
/** The window a click brings to the front, as the OS does for a click on another app's window. */
let clickActivates: { processId: number; processName: string } | null;
let dir: string;

/** A stand-in input layer: records what reached "the OS". */
function fakeDesktop() {
  const sent: string[] = [];
  const d = {
    sent,
    async keyPress(combo: string) { sent.push(`key ${combo}`); },
    async typeText(text: string) { await d.keyPress('mod+v'); sent.push(`type ${text}`); },  // a paste: one input
    async mouseClick(x: number, y: number) { sent.push(`click ${x},${y}`); if (clickActivates) fg = clickActivates; },
    async mouseUp() { sent.push('up'); },
    async focusWindow(q: { processId: number; processName: string }) { fg = { ...q }; return true; },
  };
  return guardInputMethods(d);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-control-'));
  __setControlDirForTests(dir);
  fg = { processId: 100, processName: 'msedge' };
  clickActivates = null;
  __setForegroundReaderForTests(async () => fg);
  pauseGate.__resetForTests();
});
afterEach(() => {
  __setControlDirForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the window in front (#294)', () => {
  it('the issue: focus Edge, the user switches to Claude during a wait → ctrl+l and the URL are never sent', async () => {
    const d = fakeDesktop();
    await d.focusWindow({ processId: 100, processName: 'msedge' });  // window focus msedge
    fg = { processId: 200, processName: 'claude' };    // during the wait the user brings the Claude app forward
    await expect(d.keyPress('ctrl+l')).rejects.toThrow(/foreground changed: you were working in msedge \(pid 100\), but claude \(pid 200\)/);
    await expect(d.typeText('https://example.com\n')).rejects.toThrow(/foreground changed/);
    expect(d.sent).toEqual([]);
  });

  it('input in the same window passes, and a paste (typeText → keyPress) is checked once', async () => {
    const d = fakeDesktop();
    await d.keyPress('ctrl+l');
    await d.typeText('hi');
    expect(d.sent).toEqual(['key ctrl+l', 'key mod+v', 'type hi']);
  });

  it("the agent's own click that brings up another app rebinds to it; a later switch by the user does not", async () => {
    const d = fakeDesktop();
    clickActivates = { processId: 300, processName: 'notepad' };
    await d.mouseClick(1, 1);
    clickActivates = null;
    await d.keyPress('a');
    expect(d.sent).toEqual(['click 1,1', 'key a']);
    fg = { processId: 200, processName: 'claude' };
    await expect(d.keyPress('b')).rejects.toThrow(/working in notepad/);
  });

  it('an OS that cannot say what is in front is not blocked', async () => {
    __setForegroundReaderForTests(async () => null);
    const d = fakeDesktop();
    await d.keyPress('x');
    expect(d.sent).toEqual(['key x']);
  });
});

describe('stop is a state (#294)', () => {
  it('a stop refuses every input; a release is still sent (a held button is always let go)', async () => {
    const d = fakeDesktop();
    stopControl('pill');
    await expect(d.keyPress('Return')).rejects.toThrow(STOPPED_TEXT);
    await expect(d.mouseClick(5, 5)).rejects.toThrow(/stopped by the user/);
    await d.mouseUp();
    expect(d.sent).toEqual(['up']);
  });

  it('survives a restart: a fresh process reading the same data dir starts stopped', () => {
    stopControl('pill');
    __setControlDirForTests(dir);            // drops the in-process flag, as a new process would start
    expect(isStopped()).toBe(true);
    resumeControl();
    __setControlDirForTests(dir);
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
  });

  it('a wait ends within a moment of the stop, not at its end', async () => {
    const started = Date.now();
    setTimeout(() => stopControl('pill'), 50);
    expect(await sleepUnlessStopped(10_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await sleepUnlessStopped(10)).toBe(true);  // already stopped: no wait at all
  });

  it("only the user's Resume gives control back — not an agent's resume, not a detected done_when", async () => {
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
