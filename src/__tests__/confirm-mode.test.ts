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
import { guardInputMethods, _resetHeldKeys } from '../platform/pointer-guard';
import { pauseGate } from '../core/pause-gate';
import { consequentialCombo, __setTreeReaderForTests, __resetConfirmForTests } from '../core/confirm-mode';
import { classifyResult } from '../core/result-codes';
import { getAgentTools } from '../tools/agent';
import type { UiElement } from '../platform/types';

const el = (name: string, x: number, y: number, width: number, height: number, controlType = 'Button'): UiElement =>
  ({ name, controlType, bounds: { x, y, width, height } });
// A "Delete files?" window with Send, Cancel and Remove buttons; Send has an unnamed icon inside it, Remove a named one
// ("Trash"). Plain text and a field are named with the words too: neither is pressed.
const TREE: UiElement[] = [
  el('Delete files?', 0, 0, 400, 300, 'Window'),
  el('Send', 10, 10, 80, 30),
  el('', 15, 15, 10, 10, 'Image'),
  el('Cancel', 100, 10, 80, 30),
  el('Remove', 200, 10, 80, 30),
  el('Trash', 205, 15, 10, 10, 'Image'),
  el('please send me the file', 10, 100, 300, 20, 'Text'),
  el('Send to', 10, 150, 300, 20, 'Edit'),
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
      async typeText(t: string) { sent.push(`type ${JSON.stringify(t)}`); },
      // A checkbox the click pattern does not take: the invoke ladder goes on to select.
      async invokeElement(o: { name?: string; automationId?: string; action?: string }) {
        sent.push(`${o.action ?? 'click'} ${o.name ?? o.automationId}`);
        return { success: !(o.action === 'click' && o.name === 'Remove after sending') };
      },
      // As the bridges do: part of a name, or an automation id.
      async findElement(q: { name?: string; automationId?: string }) {
        return ['Send', 'Sender', 'Remove after sending']
          .filter(n => (q.name && n.toLowerCase().includes(q.name.toLowerCase())) || (q.automationId === 'SendButton' && n === 'Send'))
          .map(name => ({ name }));
      },
      async setWindowState(s: string, q?: { title?: string }) { sent.push(`window ${s}${q?.title ? ` ${q.title}` : ''}`); return true; },
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
  _resetHeldKeys();
  delete (globalThis as { document?: unknown }).document;
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
    expect(pauseGate.current()?.message).toMatch(/the agent wants to click "Send" in "mail"/);
    expect(sent).toEqual([]);
    expect(pauseGate.answer('resume', 'pill')).toMatchObject({ ok: true });
    await click;
    expect(sent).toEqual(['click 17,17']);
  });

  it('only a pressed control counts: Cancel, the window "Delete files?", text and a field named with the words are not held', async () => {
    process.env.CLAWD_CONFIRM = 'true';
    const { d, sent } = fakeDesktop();
    await d.mouseClick(120, 20);   // Cancel
    await d.mouseClick(350, 250);  // the window itself
    await d.mouseClick(20, 105);   // the text "please send me the file"
    await d.mouseClick(20, 155);   // the field "Send to", clicked to put the caret in it
    await d.invokeElement({ name: 'Send to', action: 'set-value' });
    expect(sent).toEqual(['click 120,20', 'click 350,250', 'click 20,105', 'click 20,155', 'set-value Send to']);
    expect(pauseGate.current()).toBeNull();
  });

  it('a click on a named icon inside a button is checked against the button', async () => {
    process.env.CLAWD_CONFIRM = '1';
    const { d } = fakeDesktop();
    const act = d.mouseClick(207, 17);
    await flush();
    expect(pauseGate.current()?.message).toMatch(/click "Remove"/);
    pauseGate.answer('end');
    await expect(act).rejects.toThrow(/^not confirmed/);
  });

  it('a by-name act is checked on what the query reaches: part of a name ("Sen") or an automation id alone is held', async () => {
    process.env.CLAWD_CONFIRM = '1';
    const { d, sent } = fakeDesktop();
    for (const q of [{ name: 'Sen' }, { automationId: 'SendButton' }]) {
      const act = d.invokeElement({ ...q, action: 'click' });
      await flush();
      expect(pauseGate.current()?.message, JSON.stringify(q)).toMatch(/click "Send"/);
      pauseGate.answer('end');
      await expect(act).rejects.toThrow(/^not confirmed/);
    }
    expect(sent).toEqual([]);
  });

  it("an invoke's ladder (click, then select) on the same element asks once", async () => {
    process.env.CLAWD_CONFIRM = '1';
    const { d, sent } = fakeDesktop();
    const first = d.invokeElement({ name: 'Remove after sending', action: 'click' });
    await flush();
    pauseGate.answer('resume', 'pill');
    expect(await first).toEqual({ success: false });
    await d.invokeElement({ name: 'Remove after sending', action: 'select' });
    expect(pauseGate.current()).toBeNull();
    expect(sent).toEqual(['click Remove after sending', 'select Remove after sending']);
  });

  it('a browser click is checked on the element the page would press: clickByText("Sen") presses Send', async () => {
    process.env.CLAWD_CONFIRM = '1';
    const button = (text: string) => ({ textContent: text, getAttribute: () => null });
    (globalThis as { document?: unknown }).document = {
      querySelectorAll: () => [button('Sent items'), button('Send')],
      querySelector: (sel: string) => (sel === '#b42' ? button('Delete') : null),
    };
    const page = { evaluate: async (f: (a: unknown) => unknown, arg: unknown) => f(arg), title: async () => 'Inbox' };
    const sent: string[] = [];
    const cdp = guardInputMethods({
      getPage: () => page,
      async clickByText(t: string) { sent.push(`text ${t}`); return { success: true }; },
      async click(s: string) { sent.push(`css ${s}`); return { success: true }; },
    });
    const acts: Array<[() => Promise<unknown>, string]> = [[() => cdp.clickByText('Sen'), 'Send'], [() => cdp.click('#b42'), 'Delete']];
    for (const [act, label] of acts) {
      const p = act();
      await flush();
      expect(pauseGate.current()?.message).toMatch(new RegExp(`click "${label}" in "Inbox"`));
      pauseGate.answer('end');
      await expect(p).rejects.toThrow(/^not confirmed/);
    }
    await cdp.clickByText('Sent');   // reaches "Sent items" only
    expect(sent).toEqual(['text Sent']);
  });

  it('typed text with a key held is a press with it: key_down ctrl (cmd on macOS), then type "w" or a newline, is held', async () => {
    process.env.CLAWD_CONFIRM = '1';
    const { d, sent } = fakeDesktop();
    // The OS's mod key: on macOS ctrl+w closes nothing, cmd+w does.
    const mod = process.platform === 'darwin' ? 'cmd' : 'ctrl';
    await d.keyDown(mod);
    for (const t of ['w', 'ok\n']) {
      const act = d.typeText(t);
      await flush();
      expect(pauseGate.current()?.message).toMatch(new RegExp(`the agent wants to type ".+" with "${mod}" held`));
      pauseGate.answer('end');
      await expect(act).rejects.toThrow(/^not confirmed/);
    }
    expect(sent).toEqual([`down ${mod}`]);
  });

  it("an agent's resume_task, `clawdcursor resume` / POST /resume, End task or a typed reply never lets it through", async () => {
    process.env.CLAWD_CONFIRM = '1';
    const { d, sent } = fakeDesktop();
    // ('resume', 'user') is what POST /resume and `clawdcursor resume` answer (http-utility.ts): a model with a shell can call them.
    for (const answer of [() => pauseGate.answer('resume', 'agent'), () => pauseGate.answer('resume', 'user'), () => pauseGate.answer('end'), () => pauseGate.answer('reply', 'user', 'yes send it')]) {
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

  it('an unanswered card returns "held" after the bound; a later Resume lets the retry in that window through once', async () => {
    process.env.CLAWD_CONFIRM = '1';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { d, sent } = fakeDesktop();
    const first = d.setWindowState('close', { title: 'Untitled - Notepad' }).then(() => null, (e: Error) => e);
    await vi.advanceTimersByTimeAsync(46_000);
    const err = await first;
    expect(err?.message).toMatch(/^held: confirm mode is on and a pause is waiting for the user on screen/);
    expect(classifyResult(err!.message, true, true)).toMatchObject({ code: 'PAUSED', outcome: 'refused' });
    expect(pauseGate.current()?.message).toMatch(/close the window in "Untitled - Notepad"/);
    // The agent waits on the same card with pause_for_user and the message it was given.
    const message = /\nMessage: (.+)$/.exec(err!.message)![1];
    const pauseForUser = getAgentTools().find(t => t.name === 'pause_for_user')!;
    const waited = pauseForUser.handler({ message }, {} as never);
    await vi.advanceTimersByTimeAsync(0);
    pauseGate.answer('resume', 'pill');
    expect(JSON.parse((await waited).text)).toMatchObject({ status: 'resumed', confirmedByUser: true });
    // Kept for that window only: closing another one asks.
    const other = d.setWindowState('close', { title: 'Budget.xlsx' });
    await vi.advanceTimersByTimeAsync(0);
    expect(pauseGate.current()?.message).toMatch(/close the window in "Budget.xlsx"/);
    pauseGate.answer('end');
    await expect(other).rejects.toThrow(/clicked End task/);
    await d.setWindowState('close', { title: 'Untitled - Notepad' });   // the user's Resume, kept for this retry
    expect(sent).toEqual(['window close Untitled - Notepad']);
    const again = d.setWindowState('close', { title: 'Untitled - Notepad' });
    await vi.advanceTimersByTimeAsync(0);
    expect(pauseGate.current()?.message).toMatch(/close the window/);   // used once: asked again
    pauseGate.answer('end');
    await expect(again).rejects.toThrow(/clicked End task/);
    expect(sent).toEqual(['window close Untitled - Notepad']);
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
    // On Windows the executors press meta as Ctrl.
    expect(consequentialCombo('meta+w', [], 'win32')).toBe(true);
    expect(consequentialCombo('meta+enter', [], 'win32')).toBe(true);
    expect(consequentialCombo('w', ['meta'], 'win32')).toBe(true);
    expect(consequentialCombo('meta+w', [], 'linux')).toBe(false);
  });
});
