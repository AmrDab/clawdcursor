/**
 * One ladder for a step that needs more than a by-name act: R1 window message (native windows), R2 foreground burst (the user
 * idle), R3 ask the user. The result says which rung ran and whether focus moved. Platforms without the Windows pieces keep
 * today's path: bring the window to the front, then act.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { viaLadder, type LadderPlatform } from '../platform/ladder';
import { resetBurstCount, burstTiming } from '../platform/foreground-burst';

const USER = { processId: 10, handle: 500 };
const TARGET = { processId: 42, handle: 900 };

function windows(over: Partial<{ idleMs: number; deliver: unknown }> = {}) {
  const log: string[] = [];
  const notes: string[] = [];
  const s = { fg: USER as { processId: number; handle: number }, tick: 1000, idleMs: over.idleMs ?? 5000 };
  const platform = {
    getActiveWindow: async () => s.fg,
    focusWindow: async () => { log.push('focus'); s.fg = TARGET; return true; },
    restoreForeground: async (h: number) => { log.push(`restore ${h}`); s.fg = USER; return true; },
    userIdle: async () => ({ tick: s.tick, idleMs: s.idleMs }),
    cursorPos: async () => ({ x: 1, y: 2 }),
    mouseMove: async () => { log.push('cursor'); },
    deliverToWindow: async (t: unknown, i: unknown) => { log.push(`deliver ${JSON.stringify(i)}`); return over.deliver ?? { success: true, verified: true, method: 'WM_SETTEXT' }; },
    noteRoute: (n: string) => { notes.push(n); },
  } as unknown as LadderPlatform;
  return { s, log, notes, platform };
}

beforeEach(() => { resetBurstCount(); burstTiming.maxWaitMs = 100; burstTiming.pollMs = 10; });

describe('viaLadder, Windows', () => {
  it('R1: a verified window message does the step; focus is never touched', async () => {
    const { log, notes, platform } = windows();
    const r = await viaLadder(platform, 42, { r1: { name: 'Name', input: { setText: 'Ada' } }, r2: async () => { log.push('r2'); } });
    expect(r).toEqual({ rung: 'R1' });
    expect(log).toEqual(['deliver {"setText":"Ada"}']);
    expect(notes).toEqual(['R1 window message, focus not moved']);
  });

  it('a click delivered by BM_CLICK counts although it cannot be read back', async () => {
    const { platform } = windows({ deliver: { success: true, verified: false } });
    expect(await viaLadder(platform, 42, { r1: { name: 'Save', input: { click: true } }, r2: async () => 1 })).toEqual({ rung: 'R1' });
  });

  it('text that was posted but not read back is done again in the burst (R2), not trusted', async () => {
    const { log, notes, platform } = windows({ deliver: { success: true, verified: false } });
    const r = await viaLadder(platform, 42, { r1: { name: 'Name', input: { setText: 'Ada' } }, r2: async act => { await act(async () => { log.push('r2'); }); return 'typed'; } });
    expect(r).toEqual({ rung: 'R2', value: 'typed' });
    expect(log).toEqual(['deliver {"setText":"Ada"}', 'focus', 'r2', 'restore 500', 'cursor']);
    expect(notes).toEqual(['R2 foreground burst #1: focus moved for a moment, your window and cursor given back']);
  });

  it('an elevated target is reported as such, once, then the burst', async () => {
    const { log, notes, platform } = windows({ deliver: { success: false, reason: 'uipi' } });
    const r = await viaLadder(platform, 42, { r1: { name: 'Name', input: { text: 'x' } }, r2: async () => 'ok' });
    expect(r).toMatchObject({ rung: 'R2' });
    expect(log.filter(l => l.startsWith('deliver'))).toHaveLength(1);
    expect(notes[0]).toMatch(/R1 refused: .*elevated/);
  });

  it('no window message for this step: straight to the burst', async () => {
    const { log, platform } = windows();
    expect(await viaLadder(platform, 42, { r2: async act => act(async () => 7) })).toEqual({ rung: 'R2', value: 7 });
    expect(log).toEqual(['focus', 'restore 500', 'cursor']);
  });

  it('the target is already in front: it acts there, no burst, no window message', async () => {
    const { s, log, notes, platform } = windows();
    s.fg = TARGET;
    expect(await viaLadder(platform, 42, { r1: { input: { click: true } }, r2: async () => 'here' })).toEqual({ rung: 'R2', value: 'here' });
    expect(log).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('the user never idle: R3, with the words for the agent to ask them', async () => {
    const { log, notes, platform } = windows({ idleMs: 50 });
    const r = await viaLadder(platform, 42, { r2: async () => 'never' });
    expect(r.rung).toBe('R3');
    expect(log).toEqual([]);
    expect(notes[0]).toMatch(/^R3: .*pause_for_user/);
  });

  it('the user acts mid-burst and never settles: paused, then R3, and their window is left alone', async () => {
    const { s, log, notes, platform } = windows();
    burstTiming.pauseMaxMs = 60;
    const r = await viaLadder(platform, 42, { r2: async act => { await act(async () => { log.push('first'); }); s.tick += 500; s.idleMs = 10; await act(async () => { log.push('second'); }); return 'x'; } });
    expect(r.rung).toBe('R3');
    expect(log).toEqual(['focus', 'first', 'restore 500', 'cursor']);
    expect(notes[0]).toMatch(/^R3: .*pause_for_user/);
  });

  it('no pid: the step acts on the window in front, as it always did', async () => {
    const { log, platform } = windows();
    expect(await viaLadder(platform, undefined, { r1: { input: { click: true } }, r2: async () => 'front' })).toEqual({ rung: 'R2', value: 'front' });
    expect(log).toEqual([]);
  });
});

describe('viaLadder, a platform without the Windows pieces (today\'s path)', () => {
  const plain = (frontPid: number) => {
    const calls: string[] = [];
    const platform = {
      getActiveWindow: async () => ({ processId: frontPid }),
      focusWindow: async () => { calls.push('focus'); return true; },
    } as unknown as LadderPlatform;
    return { calls, platform };
  };

  it('in front: acts', async () => {
    const { calls, platform } = plain(42);
    expect(await viaLadder(platform, 42, { r1: { input: { click: true } }, r2: async () => 'ok' })).toEqual({ rung: 'R2', value: 'ok' });
    expect(calls).toEqual([]);
  });

  it('brought to the front by a focus: acts', async () => {
    const { calls, platform } = plain(9);
    // the foreground read after the focus still says another app: the old "would not come to the front"
    expect(await viaLadder(platform, 42, { r2: async () => 'ok' })).toEqual({ rung: 'R3', why: 'its window would not come to the front' });
    expect(calls).toEqual(['focus']);
  });
});

describe('the callers go through the ladder', () => {
  it('a by-name click with no pattern, on a native window in the background, is a window message: no click at the bounds', async () => {
    const { buildUnifiedTools } = await import('../tools/projected/tools');
    const tool = buildUnifiedTools().find(t => t.name === 'invoke_element')!;
    const { log, notes, platform } = windows({ deliver: { success: true, verified: false } });
    const mouseClick = async () => { log.push('click'); };
    const p = {
      ...platform, platform: 'win32', mouseClick, findElements: async () => [],
      invokeElement: async () => ({ success: false, bounds: { x: 100, y: 200, width: 50, height: 20 }, data: { error: 'No invoke/toggle/select pattern' } }),
      listDisplays: async () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, dpiRatio: 1 }],
    };
    const r = await tool.execute({ name: 'Save', processId: 42 }, { platform: p, screen: { physicalWidth: 1920, physicalHeight: 1080 } } as never);
    expect(r).toMatchObject({ success: true });
    expect(r.text).toMatch(/via a window message/);
    expect(log).toEqual(['deliver {"click":true}']);
    expect(notes).toEqual(['R1 window message, focus not moved']);
  });
});

describe('set_field_value on a field the direct set ignored, Windows ladder', () => {
  it('a background native window gets the value by WM_SETTEXT: nothing is clicked or typed, the foreground is not touched', async () => {
    const { buildUnifiedTools } = await import('../tools/projected/tools');
    const tool = buildUnifiedTools().find(t => t.name === 'set_field_value')!;
    const w = windows();
    let shown = '';
    const input = { name: 'City', controlType: 'Edit', processId: 7, bounds: { x: 60, y: 8, width: 200, height: 22 } };
    const p = {
      ...w.platform, platform: 'win32',
      getActiveWindow: async () => ({ processId: 9, handle: 500 }),
      deliverToWindow: async (_t: unknown, i: { setText: string }) => { w.log.push(`deliver ${i.setText}`); shown = i.setText; return { success: true, verified: true }; },
      // the direct set "worked" but the field still reads empty: no effect, so it is set again through the ladder
      invokeElement: async (q: { action: string }) => q.action === 'get-value' ? { success: true, data: { value: shown, readable: true } } : { success: true },
      findElements: async () => [input],
      mouseClick: async () => { w.log.push('click'); }, keyPress: async () => { w.log.push('key'); }, typeText: async () => { w.log.push('type'); },
      getFocusedElement: async () => null,
      listDisplays: async () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, dpiRatio: 1 }],
    };
    const r = await tool.execute({ name: 'City', value: 'Lisbon', processId: 7 }, { platform: p, screen: { physicalWidth: 1920, physicalHeight: 1080 } } as never);
    expect(w.log).toEqual(['deliver Lisbon']);
    expect(r.success).toBe(true);
    expect(w.notes).toEqual(['R1 window message, focus not moved']);
  });
});
