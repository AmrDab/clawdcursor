/**
 * The outline and the pill's "…in <app>" follow by-name acts too (1.6.0): an agent on the blind pipeline (accessibility
 * invoke / set_value / toggle / select, never a mouse or a key) got no outline at all, because only mouse and keyboard
 * input set the window they read (control.ts workingWindow / workingIn).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { controlBanner } from '../core/banner';
import { __setForegroundReaderForTests, workingWindow, workingIn } from '../core/control';
import { guardInputMethods } from '../platform/pointer-guard';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stdin = new PassThrough();
  written: string[] = [];
  constructor() { super(); this.stdin.on('data', d => this.written.push(...String(d).split('\n').filter(Boolean))); }
  kill(): boolean { this.emit('exit', 0); return true; }
}

type Win = { processId: number; processName: string; handle?: number };
const EDGE: Win = { processId: 100, processName: 'msedge', handle: 0x5a0 };
const NOTEPAD: Win = { processId: 300, processName: 'notepad', handle: 0x7b2 };
const CLAUDE: Win = { processId: 200, processName: 'claude', handle: 0x111 };

let fg: Win | null;
let outlines: FakeChild[];

function fakeDesktop() {
  const sent: string[] = [];
  return guardInputMethods({
    sent,
    async keyPress(combo: string) { sent.push(`key ${combo}`); },
    async invokeElement(q: { name: string; action?: string; processId?: number }) { sent.push(`${q.action ?? 'click'} ${q.name}`); return { success: true }; },
  });
}

beforeEach(() => {
  outlines = [];
  controlBanner.__resetForTests();
  controlBanner.__setPlatformEnabledForTests(true);
  controlBanner.__setSpawnerForTests(() => new FakeChild() as unknown as ChildProcess);
  controlBanner.__setOutlineSpawnerForTests(() => {
    const c = new FakeChild();
    outlines.push(c);
    return c as unknown as ChildProcess;
  });
  fg = EDGE;
  __setForegroundReaderForTests(async () => fg);
  controlBanner.pin();
});
afterEach(() => {
  controlBanner.__resetForTests();
  vi.useRealTimers();
});

describe('the outline follows by-name acts', () => {
  it('a by-name invoke with no mouse or keyboard input before it: the outline goes around the window in front', async () => {
    const d = fakeDesktop();
    expect(workingWindow()).toBeUndefined();
    await d.invokeElement({ name: 'Save' });
    expect(workingWindow()).toEqual({ processId: 100, handle: 0x5a0 });
    expect(workingIn()?.processName).toBe('msedge');
    expect(outlines[0].written).toEqual(['TARGET 1440 100']);
  });

  it('every by-name action moves it, with or without the processId of the window in front; reading a value does not', async () => {
    const d = fakeDesktop();
    await d.invokeElement({ name: 'Total', action: 'get-value' });
    expect(workingWindow()).toBeUndefined();
    for (const action of ['set-value', 'toggle', 'select', 'expand']) {
      fg = fg === EDGE ? NOTEPAD : EDGE;
      await d.invokeElement({ name: 'Field', action, processId: action === 'toggle' ? fg.processId : undefined });
      expect(workingWindow()).toEqual({ processId: fg.processId, handle: fg.handle });
    }
    expect(outlines[0].written).toEqual(['TARGET', 'TARGET 1970 300', 'TARGET 1440 100', 'TARGET 1970 300', 'TARGET 1440 100']);
  });

  it('a by-name act on a process that is not in front leaves the outline where it was', async () => {
    const d = fakeDesktop();
    await d.invokeElement({ name: 'OK', processId: NOTEPAD.processId });
    expect(workingWindow()).toBeUndefined();
    expect(outlines[0].written).toEqual(['TARGET']);  // no window: the outline draws nothing
    await d.invokeElement({ name: 'Save' });
    await d.invokeElement({ name: 'OK', processId: NOTEPAD.processId });
    expect(workingWindow()).toEqual({ processId: 100, handle: 0x5a0 });
    expect(outlines[0].written).toEqual(['TARGET', 'TARGET 1440 100']);
  });

  it('a refused by-name act (an AI assistant nobody focused) does not move it', async () => {
    const d = fakeDesktop();
    await d.invokeElement({ name: 'Save' });
    fg = CLAUDE;
    await expect(d.invokeElement({ name: 'Message', action: 'set-value' })).rejects.toThrow(/an AI assistant/);
    expect(workingWindow()).toEqual({ processId: 100, handle: 0x5a0 });
    expect(outlines[0].written).toEqual(['TARGET 1440 100']);
  });

  it('input after a by-name act works as before: it binds to the window in front, and a later switch by the user is still refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const d = fakeDesktop();
    await d.invokeElement({ name: 'Save' });
    // The by-name act did not take the foreground lease: the first input binds to whatever is in front.
    fg = NOTEPAD;
    await d.keyPress('a');
    expect(workingWindow()).toEqual({ processId: 300, handle: 0x7b2 });
    expect(outlines[0].written).toEqual(['TARGET 1440 100', 'TARGET 1970 300']);
    // A by-name act elsewhere moves the outline, not the lease: the input lease is still Notepad's.
    vi.advanceTimersByTime(30_000);
    fg = EDGE;
    await d.invokeElement({ name: 'Save' });
    expect(workingWindow()).toEqual({ processId: 100, handle: 0x5a0 });
    await expect(d.keyPress('b')).rejects.toThrow(/foreground changed: you were working in "notepad" \(pid 300\), but "msedge" \(pid 100\)/);
    expect(d.sent).toEqual(['click Save', 'key a', 'click Save']);
  });
});
