/**
 * The user's turn (owner, 2026-11-18; control.ts): real input waits for the user to be idle; when they take over, after
 * 5 s the agent goes on if they are idle, and if they are still working it is held until they click Resume on the pill.
 * The pill's Pause holds every act, background ones included. A held call returns a waiting reply the agent calls again.
 * Real timers with the turn's times shortened, and a fake idle clock that, like the OS, counts the agent's input too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  __setControlDirForTests, __setForegroundReaderForTests, __setIdleReaderForTests, turnTiming, holdControl, releaseHold,
  isHeld, setOnHold, stopControl, isGuardRefusal, STOPPED_TEXT, withTurnBudget, type HoldEvent,
} from '../core/control';
import { guardInputMethods, ownInputAt, _resetHeldKeys } from '../platform/pointer-guard';
import { withForegroundBurst } from '../platform/foreground-burst';
import { ensureInFront } from '../platform/prefer-control';
import { classifyResult } from '../core/result-codes';

const EDGE = { processId: 100, processName: 'msedge' };
const DEFAULTS = { ...turnTiming };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let dir: string;
let typing: boolean;   // the user is at the keyboard: their last input is "now" at every read
let userAt: number;    // when their last input was
let events: HoldEvent[];

function fakeDesktop() {
  const sent: string[] = [];
  const d = {
    sent,
    async mouseClick(x: number, y: number) { sent.push(`click ${x},${y}`); },
    async mouseDown() { sent.push('down'); },
    async mouseMove(x: number, y: number) { sent.push(`move ${x},${y}`); },
    async mouseUp() { sent.push('up'); },
    async keyPress(k: string) { sent.push(`key ${k}`); },
    async invokeElement(o: { name: string; processId?: number }) { sent.push(`invoke ${o.name}`); return { success: true }; },
    async evaluate(js: string) { sent.push(`js ${js}`); },
    async getUiTree() { sent.push('read'); return []; },
  };
  return guardInputMethods(d);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-turn-'));
  __setControlDirForTests(dir);
  __setForegroundReaderForTests(async () => EDGE);
  Object.assign(turnTiming, { idleMs: 40, takeoverMs: 80, waitMs: 300, pollMs: 5, graceMs: 30 });
  typing = false;
  userAt = 0;
  // The OS's idle time counts every process's input, the agent's own too (GetLastInputInfo).
  __setIdleReaderForTests(async () => {
    if (typing) userAt = Date.now();
    const last = Math.max(userAt, ownInputAt());
    return { tick: last, idleMs: Date.now() - last };
  });
  events = [];
  setOnHold(e => events.push(e));
  await sleep(120);   // the last test's own input is past the slack the idle check allows for it
});
afterEach(() => {
  _resetHeldKeys();
  setOnHold(null);
  __setIdleReaderForTests(null);
  Object.assign(turnTiming, DEFAULTS);
  __setControlDirForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('real input waits for the user', () => {
  it('a click while the user is at the keyboard is not sent; idle at the takeover mark, it goes on by itself', async () => {
    const d = fakeDesktop();
    typing = true;
    const t0 = Date.now();
    const click = d.mouseClick(1, 1);
    await sleep(30);
    expect(d.sent).toEqual([]);
    expect(events).toEqual(['takeover']);   // the pill: "Paused — your turn", the glow down
    typing = false;                         // they stop
    await click;
    expect(d.sent).toEqual(['click 1,1']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(turnTiming.takeoverMs - 5);
    expect(events).toEqual(['takeover', 'resumed']);
    expect(isHeld()).toBe(false);
  });

  it('still working at the takeover mark: held (the pill offers Resume), and the pill\'s Resume sends it', async () => {
    const d = fakeDesktop();
    typing = true;
    const click = d.mouseClick(1, 1);
    await sleep(turnTiming.takeoverMs + 40);
    expect(isHeld()).toBe(true);
    expect(events).toEqual(['takeover', 'held']);
    await sleep(60);
    expect(d.sent).toEqual([]);             // no auto-resume once held, however long they work
    typing = false;
    userAt = Date.now();                    // the click on Resume is input too: not a takeover
    releaseHold('pill');
    await click;
    expect(d.sent).toEqual(['click 1,1']);
    expect(events).toEqual(['takeover', 'held', 'resumed']);
  });

  it('Stop during a takeover: refused as stopped, and the pill is not left saying "your turn"', async () => {
    const d = fakeDesktop();
    typing = true;
    const click = d.mouseClick(1, 1).catch(e => e as Error);
    await sleep(20);
    stopControl('pill');
    expect((await click).message).toBe(STOPPED_TEXT);
    expect(events).toEqual(['takeover', 'resumed']);
    expect(isHeld()).toBe(false);
  });

  it('the agent\'s own input is not the user\'s: back-to-back inputs do not wait', async () => {
    const d = fakeDesktop();
    await d.mouseClick(1, 1);
    await d.keyPress('a');
    await d.mouseClick(2, 2);
    expect(d.sent).toEqual(['click 1,1', 'key a', 'click 2,2']);
    expect(events).toEqual([]);
  });

  it('a move waits for the user like a click; a release never does', async () => {
    const d = fakeDesktop();
    typing = true;
    const move = d.mouseMove(5, 5);
    await d.mouseUp();
    expect(d.sent).toEqual(['up']);
    typing = false;
    await move;
    expect(d.sent).toEqual(['up', 'move 5,5']);
  });

  it('a drag in progress is finished, never left pressed while the user works: only its start waited for them', async () => {
    const d = fakeDesktop();
    await d.mouseDown();
    typing = true;                 // the user grabs their mouse mid-drag
    await d.mouseMove(5, 5);       // goes on: waiting here would leave the button down under their hand
    await d.mouseUp();
    expect(d.sent).toEqual(['down', 'move 5,5', 'up']);
    expect(events).toEqual([]);
    await sleep(10);                  // their next mouse event
    const next = d.mouseMove(6, 6);   // the gesture is over: the next one waits for them
    await sleep(30);
    expect(events).toEqual(['takeover']);
    typing = false;
    await next;
    expect(d.sent.at(-1)).toBe('move 6,6');
  });

  it('another call running while a burst runs still waits for the user: the burst only lets its own call through', async () => {
    const d = fakeDesktop();
    let fg = { processId: 10, handle: 500 };
    let finish = () => {};
    const platform = {
      getActiveWindow: async () => fg as never,
      focusWindow: async () => { fg = { processId: 42, handle: 900 }; return true; },
      restoreForeground: async () => { fg = { processId: 10, handle: 500 }; return true; },
      userIdle: async () => ({ tick: 1, idleMs: 60_000 }),
      cursorPos: async () => ({ x: 0, y: 0 }),
      mouseMove: async () => undefined,
    };
    const burst = withForegroundBurst(platform, { processId: 42 }, async b => b.act(() => new Promise<void>(r => { finish = r; })));
    await sleep(20);               // the burst is in its act
    typing = true;
    const click = d.mouseClick(1, 1);
    await sleep(30);
    expect(d.sent).toEqual([]);
    expect(events).toEqual(['takeover']);
    typing = false;
    finish();
    await Promise.all([burst, click]);
    expect(d.sent).toEqual(['click 1,1']);
  });

  it('a quick run of the agent’s inputs does not hide a user who starts working in the middle of it', async () => {
    const d = fakeDesktop();
    await d.keyPress('a');
    typing = true;                    // milliseconds later, the user is at the keyboard
    await sleep(5);
    const next = d.keyPress('b');     // a time window after the agent's own input would have let this through
    await sleep(20);
    expect(d.sent).toEqual(['key a']);
    expect(events).toEqual(['takeover']);
    typing = false;
    await next;
    expect(d.sent).toEqual(['key a', 'key b']);
  });

  it('where idle time cannot be read (Linux), nothing waits', async () => {
    __setIdleReaderForTests(async () => null);
    const d = fakeDesktop();
    typing = true;
    await d.mouseClick(1, 1);
    expect(d.sent).toEqual(['click 1,1']);
    expect(events).toEqual([]);
  });
});

describe('the pill\'s Pause', () => {
  it('holds background acts too (by name, a page script), not reads; Resume on the pill lets them go', async () => {
    const d = fakeDesktop();
    holdControl('pill');
    const byName = d.invokeElement({ name: 'OK', processId: 300 });
    const script = d.evaluate('1');
    await d.getUiTree();
    await sleep(40);
    expect(d.sent).toEqual(['read']);
    releaseHold('pill');
    await Promise.all([byName, script]);
    expect(d.sent).toEqual(expect.arrayContaining(['invoke OK', 'js 1']));
    expect(events).toEqual(['held', 'resumed']);
  });

  it('a call held longer than one wait gets the waiting reply: call the same step again, do not quit; again, it goes on after Resume', async () => {
    const d = fakeDesktop();
    holdControl('pill');
    const err = await d.mouseClick(2, 2).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^paused by the user — they have the desktop, and nothing was sent/);
    expect(err.message).toMatch(/call the same step again/);
    expect(err.message).toMatch(/Do not end the task, give up or act some other way/);
    expect(err.message).toMatch(/waitedSec: \d+/);
    expect(isGuardRefusal(err)).toBe(true);   // no tool falls back to another route around it
    const c = classifyResult(`Error: ${err.message}`, true, true);
    expect(c).toMatchObject({ outcome: 'refused', code: 'PAUSED' });
    expect(c?.hint).toMatch(/call the same step again/);
    expect(d.sent).toEqual([]);
    const again = d.mouseClick(2, 2);
    setTimeout(() => releaseHold('pill'), 30);
    await again;
    expect(d.sent).toEqual(['click 2,2']);
  });

  it('a foreground burst does not start under the pill\'s Pause, even with the user idle: it waits for Resume', async () => {
    const log: string[] = [];
    let fg = { processId: 10, handle: 500 };
    const platform = {
      getActiveWindow: async () => fg as never,
      focusWindow: async () => { log.push('focus'); fg = { processId: 42, handle: 900 }; return true; },
      restoreForeground: async () => { log.push('restore'); fg = { processId: 10, handle: 500 }; return true; },
      userIdle: async () => ({ tick: 1, idleMs: 60_000 }),
      cursorPos: async () => ({ x: 0, y: 0 }),
      mouseMove: async () => undefined,
    };
    holdControl('pill');
    const run = withForegroundBurst(platform, { processId: 42 }, async b => (await b.act(async () => { log.push('act'); })).done);
    await sleep(60);
    expect(log).toEqual([]);   // nothing focused, nothing sent while held
    releaseHold('pill');
    expect(await run).toMatchObject({ ran: true, value: true });
    expect(log).toEqual(['focus', 'act', 'restore']);
  });

  it('a focus refused as paused is that answer, not "its window would not come to the front"', async () => {
    holdControl('pill');
    const d = guardInputMethods({ async focusWindow() { return true; }, async getActiveWindow() { return { processId: 10 }; } });
    await expect(ensureInFront(d as never, 42)).rejects.toThrow(/^paused by the user/);
  });

  it('one tool call\'s waits share one budget: two held acts in a call end by takeover + wait, not twice that', async () => {
    const d = fakeDesktop();
    holdControl('pill');
    const t0 = Date.now();
    const errs = await withTurnBudget(async () => [await d.mouseClick(1, 1).catch(e => e as Error), await d.mouseClick(2, 2).catch(e => e as Error)]);
    expect(errs.map(e => e.message)).toEqual([expect.stringMatching(/^paused by the user/), expect.stringMatching(/^paused by the user/)]);
    expect(Date.now() - t0).toBeLessThan(turnTiming.takeoverMs + turnTiming.waitMs + 60);
    expect(d.sent).toEqual([]);
  });

  it('a Pause from another clawdcursor process holds this one too, and this pill offers Resume; its Resume lets it go', async () => {
    const d = fakeDesktop();
    const file = path.join(dir, 'held.json');
    fs.writeFileSync(file, JSON.stringify({ by: 'pill', pid: 1, at: Date.now() }));   // as another process's Pause writes it
    expect(isHeld()).toBe(true);
    const click = d.mouseClick(1, 1);
    await sleep(40);
    expect(d.sent).toEqual([]);
    expect(events).toEqual(['held']);
    fs.rmSync(file);                // its Resume
    await click;
    expect(d.sent).toEqual(['click 1,1']);
    expect(events).toEqual(['held', 'resumed']);
  });

  it('Stop while held: the waiting act is refused as stopped, and the hold is over', async () => {
    const d = fakeDesktop();
    holdControl('pill');
    const click = d.mouseClick(1, 1).catch(e => e as Error);
    await sleep(20);
    stopControl('pill');
    expect((await click).message).toBe(STOPPED_TEXT);
    expect(isHeld()).toBe(false);
    expect(d.sent).toEqual([]);
  });
});
