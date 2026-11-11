/**
 * The outline follows the window the agent works in after its own `window focus` and `open_app` too, not only after an act
 * (1.6.0). macOS eval 2026-11-10: after `window open_app Calculator` or `window focus "RC1527 Test"` the outline stayed on
 * the previous app (hidden behind the new one) until the next act, so every read that followed the switch (read_tree,
 * screenshot, copy_all_text) ran with the pill showing and no outline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

type Win = { processId: number; processName: string; title?: string; handle?: number };
const EDGE: Win = { processId: 100, processName: 'msedge', title: 'Inbox - Edge', handle: 0x5a0 };
const TEST: Win = { processId: 300, processName: 'firefox', title: 'RC1527 Test - Firefox', handle: 0x7b2 };
const CALC: Win = { processId: 400, processName: 'Calculator', title: 'Calculator', handle: 0x9c4 };

let fg: Win | null;
let outlines: FakeChild[];

/** `onFocus` / `onOpen`: what the OS does when asked; their answer is the adapter's. */
function fakeDesktop(o: { onFocus?: () => boolean; onOpen?: () => { pid?: number; title?: string } } = {}) {
  const sent: string[] = [];
  return guardInputMethods({
    sent,
    async keyPress(combo: string) { sent.push(`key ${combo}`); },
    async invokeElement(q: { name: string; action?: string; processId?: number }) { sent.push(`${q.action ?? 'click'} ${q.name}`); return { success: true }; },
    async getUiTree() { return []; },
    async focusWindow(_q: { title?: string; processName?: string; processId?: number }) { return o.onFocus ? o.onFocus() : true; },
    async openApp(_name: string) { return o.onOpen ? o.onOpen() : {}; },
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
});

describe('the outline follows the agent\'s own focus and launches', () => {
  it('window focus by title: the outline goes to that window, with no act', async () => {
    const d = fakeDesktop({ onFocus: () => { fg = TEST; return true; } });
    await d.keyPress('a');
    expect(outlines[0].written).toEqual(['TARGET 1440 100']);
    await d.focusWindow({ title: 'RC1527 Test' });
    expect(workingWindow()).toEqual({ processId: 300, handle: 0x7b2 });
    expect(workingIn()?.processName).toBe('firefox');
    expect(outlines[0].written).toEqual(['TARGET 1440 100', 'TARGET 1970 300']);
    expect(d.sent).toEqual(['key a']);
  });

  it('a focus that takes a moment to come up (macOS activation): the outline goes there once it is in front', async () => {
    const d = fakeDesktop({ onFocus: () => { setTimeout(() => { fg = TEST; }, 150); return true; } });
    await d.keyPress('a');
    await d.focusWindow({ title: 'RC1527 Test' });
    expect(outlines[0].written).toEqual(['TARGET 1440 100', 'TARGET 1970 300']);
  });

  it('open_app: the outline goes to the launched window, by its pid or title', async () => {
    const d = fakeDesktop({ onOpen: () => { fg = CALC; return { pid: 400, title: 'Calculator' }; } });
    await d.keyPress('a');
    await d.openApp('Calculator');
    expect(workingWindow()).toEqual({ processId: 400, handle: 0x9c4 });
    expect(workingIn()?.processName).toBe('Calculator');
    expect(outlines[0].written).toEqual(['TARGET 1440 100', 'TARGET 2500 400']);
  });

  it('open_app that reports no window: the outline goes to a window of the app it launched, and to no other', async () => {
    const d = fakeDesktop({ onOpen: () => { fg = CALC; return {}; } });
    await d.keyPress('a');
    await d.openApp('Calculator');
    expect(outlines[0].written).toEqual(['TARGET 1440 100', 'TARGET 2500 400']);
    // Another app in front after the launch is not the one the agent opened: no window, so the monitor (#392).
    fg = EDGE;
    await fakeDesktop().openApp('Calculator');
    expect(workingWindow()).toBeUndefined();
    expect(outlines[0].written).toEqual(['TARGET 1440 100', 'TARGET 2500 400', 'TARGET MONITOR']);
  });

  it('a read after a switch does not move it, whatever is in front by then', async () => {
    const d = fakeDesktop({ onFocus: () => { fg = TEST; return true; } });
    await d.keyPress('a');
    await d.focusWindow({ title: 'RC1527 Test' });
    await d.getUiTree();
    await d.invokeElement({ name: 'Total', action: 'get-value' });
    fg = EDGE;  // the user brought another window up: a read does not follow it
    await d.getUiTree();
    await d.invokeElement({ name: 'Total', action: 'get-value' });
    expect(workingWindow()).toEqual({ processId: 300, handle: 0x7b2 });
    expect(outlines[0].written).toEqual(['TARGET 1440 100', 'TARGET 1970 300']);
  });

  it('a failed focus does not move it', async () => {
    const d = fakeDesktop({ onFocus: () => { fg = TEST; return false; } });
    await d.keyPress('a');
    await d.focusWindow({ title: 'RC1527 Test' });
    expect(workingWindow()).toEqual({ processId: 100, handle: 0x5a0 });
    expect(outlines[0].written).toEqual(['TARGET 1440 100']);
  });

  it('a focus that reports success but never comes to the front does not move it, and the next input is still refused', async () => {
    const d = fakeDesktop();  // the foreground stays Edge
    await d.keyPress('a');
    await d.focusWindow({ title: 'RC1527 Test' });
    expect(workingWindow()).toEqual({ processId: 100, handle: 0x5a0 });
    expect(outlines[0].written).toEqual(['TARGET 1440 100']);
    await expect(d.keyPress('b')).rejects.toThrow(/foreground changed: you focused "RC1527 Test", but "msedge" \(pid 100\) is in front/);
    expect(d.sent).toEqual(['key a']);
  });

  it('the lease is unchanged: input after the focus binds to the focused window, and a later switch by the user is refused', async () => {
    const d = fakeDesktop({ onFocus: () => { fg = TEST; return true; } });
    await d.keyPress('a');
    await d.focusWindow({ title: 'RC1527 Test' });
    fg = EDGE;  // the user switched back before the agent's next input
    await expect(d.keyPress('b')).rejects.toThrow(/foreground changed: you focused "RC1527 Test", but "msedge" \(pid 100\) is in front/);
    fg = TEST;
    await d.keyPress('c');
    expect(d.sent).toEqual(['key a', 'key c']);
    expect(outlines[0].written).toEqual(['TARGET 1440 100', 'TARGET 1970 300']);
  });
});
