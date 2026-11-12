/**
 * #373: opt-in confirm mode. Off by default; when CLAWD_CONFIRM=1, an act that looks irreversible is held in the input
 * layer and asked on the pause card; only the user's Resume lets it through, never an agent's answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../core/banner', () => ({
  controlBanner: { overlayPids: () => [], showPaused: vi.fn(), showRunning: vi.fn(), canShow: () => true, touch: vi.fn() },
}));

import { __setControlDirForTests, __setForegroundReaderForTests, isGuardRefusal } from '../core/control';
import { guardInputMethods } from '../platform/pointer-guard';
import { pauseGate } from '../core/pause-gate';
import { consequentialCombo, __setTreeReaderForTests, __resetConfirmForTests } from '../core/confirm-mode';
import { classifyResult } from '../core/result-codes';
import { getAgentTools } from '../tools/agent';
import type { UiElement } from '../platform/types';

const el = (name: string, x: number, y: number, width: number, height: number): UiElement =>
  ({ name, controlType: 'Button', bounds: { x, y, width, height } });
// A "Delete files?" dialog with Send and Cancel buttons; Send has an unnamed icon inside it.
const TREE: UiElement[] = [
  el('Delete files?', 0, 0, 400, 300),
  el('Send', 10, 10, 80, 30),
  el('', 15, 15, 10, 10),
  el('Cancel', 100, 10, 80, 30),
];

let reads = 0;
let dir: string;

function fakeDesktop() {
  const sent: string[] = [];
  return {
    sent,
    d: guardInputMethods({
      async mouseClick(x: number, y: number) { sent.push(`click ${x},${y}`); },
      async keyPress(combo: string) { sent.push(`key ${combo}`); },
      async keyDown(k: string) { sent.push(`down ${k}`); },
      async invokeElement(o: { name: string; action?: string }) { sent.push(`${o.action ?? 'click'} ${o.name}`); return { success: true }; },
      async setWindowState(s: string) { sent.push(`window ${s}`); return true; },
    }),
  };
}
const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  delete process.env.CLAWD_CONFIRM;
  delete process.env.CLAWD_NO_PAUSE;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-confirm-'));
  __setControlDirForTests(dir);
  __setForegroundReaderForTests(async () => ({ processId: 100, processName: 'mail' }));
  __setTreeReaderForTests(async () => { reads++; return TREE; });
  pauseGate.__setFocusTrackerForTests({ capture: async () => null, focus: async () => {} });
  pauseGate.__resetForTests();
  __resetConfirmForTests();
  reads = 0;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.CLAWD_CONFIRM;
  pauseGate.__resetForTests();
  pauseGate.__setFocusTrackerForTests(null);
  __setTreeReaderForTests(null);
  __setControlDirForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('confirm mode (#373)', () => {
  it('is off by default: a click on Send, ctrl+enter and closing a window go straight through, nothing is read or asked', async () => {
    const { d, sent } = fakeDesktop();
    await d.mouseClick(20, 20);
    await d.keyPress('ctrl+enter');
    await d.setWindowState('close');
    expect(sent).toEqual(['click 20,20', 'key ctrl+enter', 'window close']);
    expect(reads).toBe(0);
    expect(pauseGate.current()).toBeNull();
  });

  it('when on, a click by coordinates on Send (even on its unnamed icon) is held and asked on the card; Resume lets it go', async () => {
    process.env.CLAWD_CONFIRM = '1';
    const { d, sent } = fakeDesktop();
    const click = d.mouseClick(17, 17);
    await flush();
    expect(pauseGate.current()?.message).toMatch(/the agent wants to click "Send"/);
    expect(sent).toEqual([]);
    expect(pauseGate.answer('resume', 'user')).toMatchObject({ ok: true });
    await click;
    expect(sent).toEqual(['click 17,17']);
  });

  it('only an act that looks irreversible is held: Cancel inside a "Delete files?" dialog is not', async () => {
    process.env.CLAWD_CONFIRM = 'true';
    const { d, sent } = fakeDesktop();
    await d.mouseClick(120, 20);
    await d.invokeElement({ name: 'Send to', action: 'set-value' });
    expect(sent).toEqual(['click 120,20', 'set-value Send to']);
    expect(pauseGate.current()).toBeNull();
  });

  it("an agent's resume_task, End task or a typed reply never lets it through: nothing is sent", async () => {
    process.env.CLAWD_CONFIRM = '1';
    const { d, sent } = fakeDesktop();
    for (const answer of [() => pauseGate.answer('resume', 'agent'), () => pauseGate.answer('end'), () => pauseGate.answer('reply', 'user', 'yes send it')]) {
      const act = d.invokeElement({ name: 'Delete', action: 'click' });
      await flush();
      expect(pauseGate.current()?.message).toMatch(/click "Delete"/);
      answer();
      const err = await act.then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/^not confirmed: confirm mode/);
      expect(isGuardRefusal(err)).toBe(true);
      expect(classifyResult(err!.message, true, true)).toMatchObject({ code: 'NOT_CONFIRMED', outcome: 'refused' });
    }
    expect(sent).toEqual([]);
  });

  it('no card can be shown: held, nothing sent', async () => {
    process.env.CLAWD_CONFIRM = '1';
    process.env.CLAWD_NO_PAUSE = '1';
    const { d, sent } = fakeDesktop();
    await expect(d.keyPress('alt+f4')).rejects.toThrow(/^not confirmed: confirm mode is on but no on-screen prompt/);
    expect(sent).toEqual([]);
  });

  it('an unanswered card returns "held" after the bound; a later Resume lets the retry through once, then it asks again', async () => {
    process.env.CLAWD_CONFIRM = '1';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { d, sent } = fakeDesktop();
    const first = d.setWindowState('close').then(() => null, (e: Error) => e);
    await vi.advanceTimersByTimeAsync(46_000);
    const err = await first;
    expect(err?.message).toMatch(/^held: confirm mode is on and a pause is waiting for the user on screen/);
    expect(classifyResult(err!.message, true, true)).toMatchObject({ code: 'PAUSED', outcome: 'refused' });
    expect(pauseGate.current()?.message).toMatch(/close a window/);
    // The agent waits on the same card with pause_for_user and the message it was given.
    const message = /\nMessage: (.+)$/.exec(err!.message)![1];
    const pauseForUser = getAgentTools().find(t => t.name === 'pause_for_user')!;
    const waited = pauseForUser.handler({ message }, {} as never);
    await vi.advanceTimersByTimeAsync(0);
    pauseGate.answer('resume', 'user');
    expect(JSON.parse((await waited).text)).toMatchObject({ status: 'resumed', confirmedByUser: true });
    await d.setWindowState('close');   // the user's Resume, kept for this retry
    expect(sent).toEqual(['window close']);
    const again = d.setWindowState('close');
    await vi.advanceTimersByTimeAsync(0);
    expect(pauseGate.current()?.message).toMatch(/close a window/);   // used once: asked again
    pauseGate.answer('end');
    await expect(again).rejects.toThrow(/clicked End task/);
    expect(sent).toEqual(['window close']);
  });

  it('key combos: the small list, on each OS, also when built from a held key', () => {
    for (const os of ['win32', 'linux', 'darwin'] as const) {
      expect(consequentialCombo('alt+F4', [], os)).toBe(true);
      expect(consequentialCombo('mod+w', [], os)).toBe(true);
      expect(consequentialCombo('shift+delete', [], os)).toBe(true);
      expect(consequentialCombo('ctrl+c', [], os)).toBe(false);
      expect(consequentialCombo('Return', [], os)).toBe(false);
    }
    expect(consequentialCombo('ctrl+Return', [], 'win32')).toBe(true);
    expect(consequentialCombo('cmd+enter', [], 'darwin')).toBe(true);
    expect(consequentialCombo('cmd+q', [], 'darwin')).toBe(true);
    expect(consequentialCombo('ctrl+w', [], 'darwin')).toBe(false);   // ctrl is not mod on macOS
    expect(consequentialCombo('enter', ['ctrl'], 'linux')).toBe(true);
    expect(consequentialCombo('tab ctrl+shift+w', [], 'win32')).toBe(true);
  });
});
