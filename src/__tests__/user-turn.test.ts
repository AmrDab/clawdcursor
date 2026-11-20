/**
 * The user's turn (control.ts): real input while the user is using the computer is refused at once, nothing held and the
 * pill not told (owner, 2026-11-20), so the agent keeps working in the background; acts by name and reads go on. The
 * pill's Pause holds every act, background ones included. A held call returns a waiting reply the agent calls again.
 * Real timers with the turn's times shortened, and a fake idle clock that, like the OS, counts the agent's input too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  __setControlDirForTests, __setForegroundReaderForTests, __setIdleReaderForTests, turnTiming, holdControl, releaseHold,
  isHeld, setOnHold, giveControlBack, stopControl, resumeControl, isGuardRefusal, STOPPED_TEXT, withTurnBudget, type HoldEvent,
} from '../core/control';
import { guardInputMethods, ownInputAt, _resetHeldKeys } from '../platform/pointer-guard';
import { withForegroundBurst } from '../platform/foreground-burst';
import { ensureInFront } from '../platform/prefer-control';
import { classifyResult } from '../core/result-codes';

const EDGE = { processId: 100, processName: 'msedge' };
const DEFAULTS = { ...turnTiming };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** The error an act was refused with; an act that went through is a test failure. */
const refused = (p: Promise<unknown>): Promise<Error> => p.then(() => new Error('not refused: the act went through'), e => e as Error);

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
  // waitMs long enough that a loaded machine never ends a wait before the test clicks Resume; one test shortens it.
  Object.assign(turnTiming, { idleMs: 40, waitMs: 2000, pollMs: 5, graceMs: 30 });
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

describe('real input while the user is using the computer', () => {
  const BUSY = /^the user is using the computer, and nothing was sent/;

  it('is refused at once: nothing sent, nothing held, the pill not told; once they are idle the same step goes through', async () => {
    const d = fakeDesktop();
    typing = true;
    const t0 = Date.now();
    const err = await refused(d.mouseClick(1, 1));
    expect(Date.now() - t0).toBeLessThan(500);   // no wait for them (it was up to waitMs, 2000 here)
    expect(err.message).toMatch(BUSY);
    expect(d.sent).toEqual([]);
    expect(events).toEqual([]);                  // the pill keeps "running in background": no "Paused — your turn"
    expect(isHeld()).toBe(false);
    expect(fs.existsSync(path.join(dir, 'held.json'))).toBe(false);
    typing = false;
    await sleep(60);                             // idle for longer than idleMs
    await d.mouseClick(1, 1);
    expect(d.sent).toEqual(['click 1,1']);
  });

  it('says what it is: the user at work, not their Pause; keep working by name meanwhile', async () => {
    const d = fakeDesktop();
    typing = true;
    const err = await refused(d.keyPress('a'));
    expect(err.message).toMatch(/Keep working in the background meanwhile: read and act by name/);
    expect(err.message).not.toMatch(/paused by the user|Resume/);
    expect(isGuardRefusal(err)).toBe(true);
    const c = classifyResult(`Error: ${err.message}`, true, true);
    expect(c).toMatchObject({ outcome: 'refused', code: 'USER_ACTIVE' });
    expect(c?.hint).toMatch(/Keep working by name/);
    expect(d.sent).toEqual([]);
  });

  it('bringing a window to the front is refused at once: the user\'s window stays in front', async () => {
    const calls: string[] = [];
    const d = guardInputMethods({ async focusWindow(_q: unknown) { calls.push('focus'); return true; } });
    typing = true;
    expect((await refused(d.focusWindow({ title: 'Settings' }))).message).toMatch(BUSY);
    expect(calls).toEqual([]);
  });

  it('acts by name and reads go on while the user works', async () => {
    const d = fakeDesktop();
    typing = true;
    await d.invokeElement({ name: 'OK', processId: 300 });
    await d.getUiTree();
    expect(d.sent).toEqual(['invoke OK', 'read']);
    expect(events).toEqual([]);
  });

  it('the agent\'s own input is not the user\'s: back-to-back inputs go through', async () => {
    const d = fakeDesktop();
    await d.mouseClick(1, 1);
    await d.keyPress('a');
    await d.mouseClick(2, 2);
    expect(d.sent).toEqual(['click 1,1', 'key a', 'click 2,2']);
    expect(events).toEqual([]);
  });

  it('a move is refused like a click; a release never is', async () => {
    const d = fakeDesktop();
    typing = true;
    expect((await refused(d.mouseMove(5, 5))).message).toMatch(BUSY);
    await d.mouseUp();
    expect(d.sent).toEqual(['up']);
  });

  it('a drag in progress is finished, never left pressed while the user works: only its start was checked', async () => {
    const d = fakeDesktop();
    await d.mouseDown();
    typing = true;                 // the user grabs their mouse mid-drag
    await d.mouseMove(5, 5);       // goes on: stopping here would leave the button down under their hand
    await d.mouseUp();
    expect(d.sent).toEqual(['down', 'move 5,5', 'up']);
    await sleep(10);
    expect((await refused(d.mouseMove(6, 6))).message).toMatch(BUSY);   // the gesture is over
    expect(d.sent).toEqual(['down', 'move 5,5', 'up']);
  });

  it('another call while a burst runs is still refused when the user works: the burst only lets its own call through', async () => {
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
    expect((await refused(d.mouseClick(1, 1))).message).toMatch(BUSY);
    expect(d.sent).toEqual([]);
    typing = false;
    finish();
    await burst;
  });

  it('a quick run of the agent\u2019s inputs does not hide a user who starts working in the middle of it', async () => {
    const d = fakeDesktop();
    await d.keyPress('a');
    typing = true;                    // milliseconds later, the user is at the keyboard
    await sleep(5);
    expect((await refused(d.keyPress('b'))).message).toMatch(BUSY);
    expect(d.sent).toEqual(['key a']);
  });

  it("the user's Resume click on a pause card is not them using the computer, with nothing held or after a Stop", async () => {
    const d = fakeDesktop();
    userAt = Date.now();               // their click on the card's Resume (nothing was held)
    releaseHold('pause_resume');
    await d.mouseClick(1, 1);
    stopControl('pill');
    userAt = Date.now();               // their click on Resume after a Stop
    resumeControl('pause_resume');
    await d.mouseClick(2, 2);
    expect(d.sent).toEqual(['click 1,1', 'click 2,2']);
  });

  it('where idle time cannot be read (Linux), nothing is refused', async () => {
    __setIdleReaderForTests(async () => null);
    const d = fakeDesktop();
    typing = true;
    await d.mouseClick(1, 1);
    expect(d.sent).toEqual(['click 1,1']);
    expect(events).toEqual([]);
  });
});

describe('holds', () => {
  it('the Pause button keeps its words and its own code; a pause card has a third', () => {
    expect(classifyResult('paused by the user — they have the desktop, and nothing was sent.', true, true)?.code).toBe('PAUSED');
    expect(classifyResult('paused — a pause is waiting for the user on screen, and nothing runs', true, true)?.code).toBe('PAUSE_PENDING');
  });

  it('a hold whose writing process is gone is stale: not held, and the file is removed', () => {
    const file = path.join(dir, 'held.json');
    fs.writeFileSync(file, JSON.stringify({ by: 'takeover', pid: 2 ** 30, at: Date.now() }));   // no such process
    expect(isHeld()).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a hold whose writer is alive still holds', () => {
    fs.writeFileSync(path.join(dir, 'held.json'), JSON.stringify({ by: 'pill', pid: process.pid, at: Date.now() }));
    expect(isHeld()).toBe(true);
  });

  it('resume clears a hold with no Stop set', () => {
    holdControl('pill');
    expect(isHeld()).toBe(true);
    expect(giveControlBack('cli')).toBe(true);
    expect(isHeld()).toBe(false);
    expect(giveControlBack('cli')).toBe(false);   // nothing left to give back
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
    turnTiming.waitMs = 300;
    const err = await refused(d.mouseClick(2, 2));
    turnTiming.waitMs = 2000;
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
    turnTiming.waitMs = 1000;   // the budget is 80 + 1000: the first act takes 1000 of it, the second only what is left
    const d = fakeDesktop();
    holdControl('pill');
    let second = 0;
    const errs = await withTurnBudget(async () => {
      const a = await refused(d.mouseClick(1, 1));
      const t1 = Date.now();
      const b = await refused(d.mouseClick(2, 2));
      second = Date.now() - t1;
      return [a, b];
    });
    expect(errs.map(e => e.message)).toEqual([expect.stringMatching(/^paused by the user/), expect.stringMatching(/^paused by the user/)]);
    // Without the shared budget the second would wait its own full 1000 ms, never less: a wide margin for a loaded machine.
    expect(second).toBeLessThan(600);
    expect(d.sent).toEqual([]);
  });

  it('a Pause from another clawdcursor process holds this one too, and this pill offers Resume; its Resume lets it go', async () => {
    const d = fakeDesktop();
    const file = path.join(dir, 'held.json');
    fs.writeFileSync(file, JSON.stringify({ by: 'pill', pid: process.pid, at: Date.now() }));   // as another process's Pause writes it
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
    const click = refused(d.mouseClick(1, 1));
    await sleep(20);
    stopControl('pill');
    expect((await click).message).toBe(STOPPED_TEXT);
    expect(isHeld()).toBe(false);
    expect(d.sent).toEqual([]);
  });
});
