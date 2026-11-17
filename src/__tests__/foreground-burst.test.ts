/**
 * Rung R2: a short foreground burst. Only when the user has been idle; saves the user's foreground window and cursor,
 * focuses the target, runs the acts, puts both back. The user always wins: input of theirs mid-burst ends it without
 * touching their window. Our own synthetic input moves GetLastInputInfo too, so it is told apart by re-baselining after
 * each of the burst's own acts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withForegroundBurst, burstCount, resetBurstCount, burstTiming, setOnBurst, type Burst } from '../platform/foreground-burst';

const USER = { processId: 10, handle: 500 };
const TARGET = { processId: 42, handle: 900 };

function fake(opts: { idleMs?: number } = {}) {
  const log: string[] = [];
  const s = {
    fg: USER as { processId: number; handle: number },
    cursor: { x: 5, y: 6 },
    tick: 1000,
    idleMs: opts.idleMs ?? 5000,
    focusOk: true,
  };
  const platform = {
    getActiveWindow: async () => s.fg as never,
    focusWindow: async (q: { processId?: number }) => { log.push(`focus ${q.processId}`); if (s.focusOk) s.fg = TARGET; return s.focusOk; },
    restoreForeground: async (h: number) => { log.push(`restore ${h}`); s.fg = USER; return true; },
    userIdle: async () => ({ tick: s.tick, idleMs: s.idleMs }),
    cursorPos: async () => ({ ...s.cursor }),
    mouseMove: async (x: number, y: number) => { log.push(`cursor ${x},${y}`); s.cursor = { x, y }; },
  };
  return { s, log, platform };
}

beforeEach(() => { resetBurstCount(); burstTiming.maxWaitMs = 200; burstTiming.pollMs = 20; burstTiming.pauseMaxMs = 400; burstTiming.maxResumes = 3; });

describe('withForegroundBurst', () => {
  it('focuses the target, runs the acts, and puts the foreground and the cursor back', async () => {
    const { s, log, platform } = fake();
    const r = await withForegroundBurst(platform, { processId: 42 }, async b => {
      const a = await b.act(async () => { log.push('act'); s.cursor = { x: 300, y: 300 }; s.tick += 5; return 'v'; });
      return a.done ? a.value : undefined;
    });
    expect(r).toEqual({ ran: true, value: 'v', yielded: false, restored: true });
    expect(log).toEqual(['focus 42', 'act', 'restore 500', 'cursor 5,6']);
    expect(burstCount()).toBe(1);
  });

  it('waits for the user to be idle, then gives up (R3) without focusing anything', async () => {
    const { log, platform } = fake({ idleMs: 100 });
    const r = await withForegroundBurst(platform, { processId: 42 }, async () => 'never');
    expect(r).toEqual({ ran: false, reason: 'user-busy' });
    expect(log).toEqual([]);
    expect(burstCount()).toBe(0);
  });

  it('starts once the user has been idle long enough', async () => {
    const { s, platform } = fake({ idleMs: 100 });
    setTimeout(() => { s.idleMs = 1500; }, 60);
    const r = await withForegroundBurst(platform, { processId: 42 }, async () => 'ok');
    expect(r).toMatchObject({ ran: true, value: 'ok' });
  });

  it('is not a burst when the target is already in front (the user is in the agent\'s window)', async () => {
    const { s, log, platform } = fake();
    s.fg = TARGET;
    const r = await withForegroundBurst(platform, { processId: 42 }, async () => 'ok');
    expect(r).toMatchObject({ ran: true, value: 'ok', restored: false });
    expect(log).toEqual([]);
    expect(burstCount()).toBe(0);
  });

  it('our own input is not the user\'s; theirs pauses the burst and gives their window back at once', async () => {
    const { s, log, platform } = fake();
    burstTiming.pauseMaxMs = 80;
    const r = await withForegroundBurst(platform, { processId: 42 }, async b => {
      await b.act(async () => { s.tick += 3; log.push('own'); });   // our SendInput moved the tick: fine
      s.tick += 200; s.idleMs = 10;                                  // the user typed and is still at it
      const second = await b.act(async () => { log.push('second'); });
      return second.done;
    });
    expect(r).toEqual({ ran: false, reason: 'paused-out' });
    expect(log).toEqual(['focus 42', 'own', 'restore 500', 'cursor 5,6']);   // no second act; the user is not touched again
  });

  it('the user switching windows mid-burst also pauses it, and their choice of window is not undone', async () => {
    const { s, log, platform } = fake();
    burstTiming.pauseMaxMs = 80;
    const r = await withForegroundBurst(platform, { processId: 42 }, async b => {
      s.fg = { processId: 77, handle: 700 }; s.idleMs = 10;
      return (await b.act(async () => { log.push('act'); })).done;
    });
    expect(r).toEqual({ ran: false, reason: 'paused-out' });
    expect(log).toEqual(['focus 42']);
  });

  describe('pause and resume', () => {
    const seen: string[] = [];
    beforeEach(() => { seen.length = 0; setOnBurst(e => seen.push(e)); burstTiming.pauseMaxMs = 400; });
    afterEach(() => setOnBurst(null));
    // A whole-value step: clear the field, then write the value.
    const stepOf = (s: { tick: number; idleMs: number }, field: { v: string }, interfere?: () => void) => {
      let runs = 0;
      return async (b: Burst) => {
        runs++;
        await b.act(async () => { field.v = ''; s.tick += 1; });
        if (runs === 1) interfere?.();
        const w = await b.act(async () => { field.v = 'Ada'; s.tick += 1; });
        return w.done;
      };
    };

    it('(a) the user interferes: their window and cursor are back at once, pause is announced, not R3 yet', async () => {
      const { s, log, platform } = fake();
      const field = { v: '' };
      let finished = false;
      const run = withForegroundBurst(platform, { processId: 42 }, stepOf(s, field, () => { s.tick += 99; s.idleMs = 10; })).finally(() => { finished = true; });
      await new Promise(r => setTimeout(r, 60));
      expect(s.fg).toBe(USER);
      expect(log).toContain('restore 500');
      expect(log).toContain('cursor 5,6');
      expect(seen).toEqual(['start', 'pause']);
      expect(finished).toBe(false);
      s.idleMs = 5000;
      await run;
    });

    it('(b) idle again: the target is re-focused, the glow signalled on, the whole value applied again', async () => {
      const { s, log, platform } = fake();
      const field = { v: '' };
      const run = withForegroundBurst(platform, { processId: 42 }, stepOf(s, field, () => { field.v = 'Adxa'; s.tick += 99; s.idleMs = 10; }));
      await new Promise(r => setTimeout(r, 60));
      expect(field.v).toBe('Adxa');   // the user typed into it meanwhile; nothing of ours touched it while paused
      s.idleMs = 5000;
      const r = await run;
      expect(r).toEqual({ ran: true, value: true, yielded: false, restored: true });
      expect(field.v).toBe('Ada');
      expect(seen).toEqual(['start', 'pause', 'resume', 'end']);
      expect(log.filter(l => l === 'focus 42')).toHaveLength(2);
      expect(s.fg).toBe(USER);
    });

    it('(c) the user never settles: R3 once the budget is spent, and they are left in control', async () => {
      const { s, log, platform } = fake();
      burstTiming.pauseMaxMs = 100;
      const r = await withForegroundBurst(platform, { processId: 42 }, stepOf(s, { v: '' }, () => { s.tick += 99; s.idleMs = 10; }));
      expect(r).toEqual({ ran: false, reason: 'paused-out' });
      expect(log.filter(l => l === 'focus 42')).toHaveLength(1);   // never focused again
      expect(s.fg).toBe(USER);
      expect(seen).toEqual(['start', 'pause', 'end']);
    });

    it('resume waits for the longer idle (4 s), not the 1 s a burst starts on', async () => {
      const { s, log, platform } = fake();
      const run = withForegroundBurst(platform, { processId: 42 }, stepOf(s, { v: '' }, () => { s.tick += 99; s.idleMs = 10; }));
      await new Promise(r => setTimeout(r, 40));
      s.idleMs = 2000;   // idle enough to start a burst, not to resume one
      await new Promise(r => setTimeout(r, 60));
      expect(log.filter(l => l === 'focus 42')).toHaveLength(1);
      s.idleMs = 4000;
      expect(await run).toMatchObject({ ran: true, value: true });
    });

    it('a user who interrupts again and again is given up on after maxResumes', async () => {
      const { s, platform } = fake();
      burstTiming.maxResumes = 1;
      const step = async (b: Burst) => { await b.act(async () => { s.tick += 1; }); s.tick += 99; return (await b.act(async () => 1)).done; };
      expect(await withForegroundBurst(platform, { processId: 42 }, step)).toEqual({ ran: false, reason: 'paused-out' });
    });

    it('(d) the target window is not the same one on resume: R3, not a blind continue', async () => {
      const { s, log, platform } = fake();
      let runs = 0;
      const step = async (b: Burst) => { runs++; s.tick += 99; s.idleMs = 10; return (await b.act(async () => 1)).done; };
      platform.focusWindow = async () => { log.push('focus'); s.fg = log.filter(l => l === 'focus').length > 1 ? { processId: 42, handle: 901 } : TARGET; return true; };
      const run = withForegroundBurst(platform, { processId: 42 }, step);
      await new Promise(r => setTimeout(r, 40));
      s.idleMs = 5000;
      expect(await run).toEqual({ ran: false, reason: 'target-changed' });
      expect(runs).toBe(1);
      expect(s.fg).toBe(USER);   // whatever came up, the user's window is back
    });
  });

  it('a target that does not come to the front is not a burst; the user\'s window was never left', async () => {
    const { s, log, platform } = fake();
    s.focusOk = false;
    expect(await withForegroundBurst(platform, { processId: 42 }, async () => 'x')).toEqual({ ran: false, reason: 'no-focus' });
    expect(log).toEqual(['focus 42']);
  });

  it('a focus that lands on some other window gives the user window back before giving up', async () => {
    const { s, log, platform } = fake();
    platform.focusWindow = async () => { log.push('focus'); s.fg = { processId: 77, handle: 700 }; return true; };
    expect(await withForegroundBurst(platform, { processId: 42 }, async () => 'x')).toEqual({ ran: false, reason: 'no-focus' });
    expect(log).toEqual(['focus', 'restore 500']);
  });

  it('puts everything back when the acts throw', async () => {
    const { log, platform } = fake();
    await expect(withForegroundBurst(platform, { processId: 42 }, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(log).toEqual(['focus 42', 'restore 500', 'cursor 5,6']);
  });

  it('counts each burst that ran', async () => {
    const { platform } = fake();
    await withForegroundBurst(platform, { processId: 42 }, async () => 1);
    const { platform: p2 } = fake();
    await withForegroundBurst(p2, { processId: 42 }, async () => 2);
    expect(burstCount()).toBe(2);
  });
});
