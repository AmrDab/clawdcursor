/**
 * Rung R2: a short foreground burst. Only when the user is idle; saves the user's foreground window and cursor,
 * focuses the target, runs the acts, puts both back. The user always wins: input of theirs mid-burst ends it without
 * touching their window, and it is their turn (core/control.ts takeover, faked here): idle again, the step runs again;
 * still working, the call throws the held waiting reply. Our own synthetic input moves GetLastInputInfo too, so it is
 * told apart by re-baselining after each of the burst's own acts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withForegroundBurst, burstCount, resetBurstCount, setOnBurst, setUserTurns, inForegroundBurst, type Burst } from '../platform/foreground-burst';

const USER = { processId: 10, handle: 500 };
const TARGET = { processId: 42, handle: 900 };

const HELD = 'paused by the user — they have the desktop';
let takeovers = 0;

function fake(opts: { idleMs?: number } = {}) {
  const log: string[] = [];
  const s = {
    fg: USER as { processId: number; handle: number },
    cursor: { x: 5, y: 6 },
    tick: 1000,
    idleMs: opts.idleMs ?? 5000,
    focusOk: true,
    /** The user is still working when the takeover looks again: held, and the call returns the waiting reply. */
    keepsWorking: false,
  };
  // The user's turn as control.ts decides it: idle after 1 s without input; a takeover goes on once they are idle.
  setUserTurns({
    idle: async () => s.idleMs >= 1000,
    takeover: async () => {
      takeovers++;
      for (; ;) {
        if (s.keepsWorking) throw new Error(`${HELD}, and nothing was sent.`);
        if (s.idleMs >= 1000) return;
        await new Promise(r => setTimeout(r, 10));
      }
    },
  });
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

beforeEach(() => { resetBurstCount(); takeovers = 0; });
afterEach(() => setUserTurns({ idle: async () => true, takeover: async () => undefined }));

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

  it('the user busy at the start: their turn first; still working, the held waiting reply, and nothing was focused', async () => {
    const { s, log, platform } = fake({ idleMs: 100 });
    s.keepsWorking = true;
    await expect(withForegroundBurst(platform, { processId: 42 }, async () => 'never')).rejects.toThrow(HELD);
    expect(takeovers).toBe(1);
    expect(log).toEqual([]);
    expect(burstCount()).toBe(0);
    expect(inForegroundBurst()).toBe(false);
  });

  it('the user busy at the start, idle once their turn is over: the burst goes on', async () => {
    const { s, platform } = fake({ idleMs: 100 });
    setTimeout(() => { s.idleMs = 1500; }, 60);
    const r = await withForegroundBurst(platform, { processId: 42 }, async () => 'ok');
    expect(r).toMatchObject({ ran: true, value: 'ok' });
    expect(takeovers).toBe(1);
  });

  it('says a burst is running while it runs, so the input guard does not wait for idle again inside it', async () => {
    const { platform } = fake();
    let inside = false;
    await withForegroundBurst(platform, { processId: 42 }, async b => { await b.act(async () => { inside = inForegroundBurst(); }); });
    expect(inside).toBe(true);
    expect(inForegroundBurst()).toBe(false);
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
    const run = withForegroundBurst(platform, { processId: 42 }, async b => {
      await b.act(async () => { s.tick += 3; log.push('own'); });   // our SendInput moved the tick: fine
      s.tick += 200; s.idleMs = 10; s.keepsWorking = true;          // the user typed and is still at it
      const second = await b.act(async () => { log.push('second'); });
      return second.done;
    });
    await expect(run).rejects.toThrow(HELD);
    expect(log).toEqual(['focus 42', 'own', 'restore 500', 'cursor 5,6']);   // no second act; the user is not touched again
  });

  it('the user switching windows mid-burst also pauses it, and their choice of window is not undone', async () => {
    const { s, log, platform } = fake();
    const run = withForegroundBurst(platform, { processId: 42 }, async b => {
      s.fg = { processId: 77, handle: 700 }; s.idleMs = 10; s.keepsWorking = true;
      return (await b.act(async () => { log.push('act'); })).done;
    });
    await expect(run).rejects.toThrow(HELD);
    expect(log).toEqual(['focus 42']);
  });

  describe('pause and resume', () => {
    const seen: string[] = [];
    beforeEach(() => { seen.length = 0; setOnBurst(e => seen.push(e)); });
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

    it('(c) the user keeps working: held, the call throws the waiting reply, and they are left in control', async () => {
      const { s, log, platform } = fake();
      const run = withForegroundBurst(platform, { processId: 42 }, stepOf(s, { v: '' }, () => { s.tick += 99; s.idleMs = 10; s.keepsWorking = true; }));
      await expect(run).rejects.toThrow(HELD);
      expect(log.filter(l => l === 'focus 42')).toHaveLength(1);   // never focused again
      expect(s.fg).toBe(USER);
      expect(seen).toEqual(['start', 'pause', 'end']);
      expect(inForegroundBurst()).toBe(false);
    });

    it('every interruption is the user\'s turn again: no cap on resumes, the hold is the limit', async () => {
      const { s, log, platform } = fake();
      let runs = 0;
      const step = async (b: Burst) => {
        runs++;
        await b.act(async () => { s.tick += 1; });
        if (runs <= 2) { s.tick += 99; s.idleMs = 10; setTimeout(() => { s.idleMs = 5000; }, 30); }
        return (await b.act(async () => 1)).done;
      };
      expect(await withForegroundBurst(platform, { processId: 42 }, step)).toMatchObject({ ran: true, value: true });
      expect(takeovers).toBe(2);
      expect(log.filter(l => l === 'focus 42')).toHaveLength(3);
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

    it('a step that is not safe to replay (replay:false) is NOT re-run when the user interferes: R3', async () => {
      const { s, log, platform } = fake();
      let clicks = 0;
      // one fixed-coordinate act; the user has already acted before it runs, so it is skipped and never redone
      const step = async (b: Burst) => { s.tick += 99; s.idleMs = 10; return (await b.act(async () => { clicks++; })).done; };
      const r = await withForegroundBurst(platform, { processId: 42 }, step, { replay: false });
      expect(r).toEqual({ ran: false, reason: 'no-replay' });
      expect(clicks).toBe(0);                         // the stale click never fired
      expect(log.filter(l => l === 'focus 42')).toHaveLength(1);   // never re-focused to retry
    });

    it('after the user moves to another window during the pause, the final restore goes to THAT window, not the first', async () => {
      const { s, log, platform } = fake();
      const field = { v: '' };
      const run = withForegroundBurst(platform, { processId: 42 },
        stepOf(s, field, () => { s.fg = { processId: 77, handle: 700 }; s.tick += 99; s.idleMs = 10; }));
      await new Promise(r => setTimeout(r, 60));
      s.idleMs = 5000;   // the user is now idle, sitting in window 700
      expect(await run).toMatchObject({ ran: true, value: true });
      expect(field.v).toBe('Ada');
      expect(log).toContain('restore 700');       // restored to where the user actually was at resume
      expect(log).not.toContain('restore 500');   // never flung back to the first window
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
