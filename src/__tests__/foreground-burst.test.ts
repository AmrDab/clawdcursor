/**
 * Rung R2: a short foreground burst. Only when the user has been idle; saves the user's foreground window and cursor,
 * focuses the target, runs the acts, puts both back. The user always wins: input of theirs mid-burst ends it without
 * touching their window. Our own synthetic input moves GetLastInputInfo too, so it is told apart by re-baselining after
 * each of the burst's own acts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { withForegroundBurst, burstCount, resetBurstCount, burstTiming } from '../platform/foreground-burst';

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

beforeEach(() => { resetBurstCount(); burstTiming.maxWaitMs = 200; burstTiming.pollMs = 20; });

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

  it('our own input does not count as the user\'s; theirs ends the burst and their window is left alone', async () => {
    const { s, log, platform } = fake();
    const r = await withForegroundBurst(platform, { processId: 42 }, async b => {
      await b.act(async () => { s.tick += 3; log.push('own'); });   // our SendInput moved the tick: fine
      s.tick += 200;                                                 // the user typed
      const second = await b.act(async () => { log.push('second'); });
      return second.done;
    });
    expect(r).toMatchObject({ ran: true, value: false, yielded: true, restored: false });
    expect(log).toEqual(['focus 42', 'own']);   // no second act, no restore, no cursor move
  });

  it('the user switching windows mid-burst also ends it', async () => {
    const { s, log, platform } = fake();
    const r = await withForegroundBurst(platform, { processId: 42 }, async b => {
      s.fg = { processId: 77, handle: 700 };
      return (await b.act(async () => { log.push('act'); })).done;
    });
    expect(r).toMatchObject({ yielded: true, restored: false, value: false });
    expect(log).toEqual(['focus 42']);
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
