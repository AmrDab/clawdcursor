/**
 * 2.3 "a failure, or a different act, is reported as success" (audit 2026-11-19, section 3, items 19, 21, 22, 26, 28).
 * The window items (20) are in window-act-one-window.test.ts, the bridge queue (23) in ps-runner-timeout.test.ts, open_file
 * (27) in open-file-honesty.test.ts, Linux and Wayland input (25) in linux-adapter.test.ts and wayland-input-honest.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public l: number, public t: number, public w: number, public h: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
const run = vi.fn();
vi.mock('../platform/ps-runner', () => ({ psRunner: { run: (c: unknown) => run(c), start: vi.fn(), stop: vi.fn() } }));

import { WindowsAdapter } from '../platform/windows';
import { buildCoreTools } from '../tools/core-tools';
import { getA11yTools } from '../tools/a11y';
import { classifyResult } from '../core/result-codes';
import { comboSequence, splitCombo } from '../platform/keys';
import type { AgentToolContext } from '../tools/types';

const tool = (name: string) => buildCoreTools().find(t => t.name === name)!;
const asCtx = (platform: object) => ({ platform, task: 't', screen: { physicalWidth: 1920, physicalHeight: 1080, dpiRatio: 1 } } as unknown as AgentToolContext);

describe('19 — a tree read or an invoke that timed out is a failure, not an empty window or "not found"', () => {
  beforeEach(() => {
    run.mockReset();
    run.mockImplementation(async (c: { cmd: string }) => {
      if (c.cmd === 'get-screen-context' || c.cmd === 'invoke-element') throw new Error(`PSRunner timeout: ${c.cmd}`);
      return { success: false };
    });
  });

  it('the Windows adapter throws on a timed-out tree read instead of returning []', async () => {
    await expect(new WindowsAdapter().getUiTree(42)).rejects.toThrow(/PSRunner timeout: get-screen-context/);
  });

  it('the Windows adapter throws on a timed-out invoke; any other failure is still { success: false }', async () => {
    const a = new WindowsAdapter();
    await expect(a.invokeElement({ name: 'OK', processId: 42 })).rejects.toThrow(/timeout/);
    run.mockImplementation(async () => { throw new Error('bridge exploded'); });
    expect(await a.invokeElement({ name: 'OK', processId: 42 })).toEqual({ success: false });
  });

  it('read_screen does not turn a failed read into "(empty a11y tree — app may be custom-canvas)"', async () => {
    const platform = { getUiTree: vi.fn(async () => { throw new Error('UI tree read failed: PSRunner timeout: get-screen-context'); }),
      getActiveWindow: async () => null, listWindows: async () => [], lastTreeTruncated: false };
    await expect(tool('read_screen').execute({ processId: 42 }, asCtx(platform))).rejects.toThrow(/timeout/);
  });

  it('and that throw is classified TIMEOUT, with no canvas wording', () => {
    const c = classifyResult('read_screen: UI tree read failed: PSRunner timeout: get-screen-context', true, false)!;
    expect(c).toMatchObject({ outcome: 'failed', code: 'TIMEOUT' });
    expect(c.hint).not.toMatch(/canvas|screenshot/i);
  });
});

describe('21 — click honours button:"middle" and count 3, and refuses what it cannot send', () => {
  const clicks: Array<[number, number, unknown]> = [];
  const platform = () => ({
    getActiveWindow: async () => null,
    mouseClick: vi.fn(async (x: number, y: number, o: unknown) => { clicks.push([x, y, o]); }),
  });
  beforeEach(() => { clicks.length = 0; });

  it('a middle click is sent as a middle click, a triple as three', async () => {
    const r = await tool('mouse_click').execute({ x: 10, y: 20, space: 'screen', button: 'middle', count: 3 }, asCtx(platform()));
    expect(r.success).toBe(true);
    expect(clicks).toEqual([[10, 20, { button: 'middle', count: 3 }]]);
    expect(r.text).toContain('Clicked middle x3');
  });

  it('with a path, every point gets the same button and count', async () => {
    await tool('mouse_click').execute({ path: [{ x: 1, y: 2 }, { x: 3, y: 4 }], interval_ms: 0, space: 'screen', button: 'right', count: 2 }, asCtx(platform()));
    expect(clicks.map(c => c[2])).toEqual([{ button: 'right', count: 2 }, { button: 'right', count: 2 }]);
  });

  it('a button or a count it cannot send is an error, never a left single click', async () => {
    for (const bad of [{ button: 'back' }, { count: 4 }, { count: 0 }, { count: 2.5 }]) {
      const p = platform();
      const r = await tool('mouse_click').execute({ x: 1, y: 2, space: 'screen', ...bad }, asCtx(p));
      expect((r as { isError?: boolean }).isError).toBe(true);
      expect(p.mouseClick).not.toHaveBeenCalled();
    }
  });
});

describe('22 — "ctrl + s" is ctrl+s and a trailing "+" is the plus key', () => {
  it('spaces around "+" are part of the chord; whitespace elsewhere still separates a sequence', () => {
    expect(comboSequence('ctrl + s')).toEqual(['ctrl+s']);
    expect(comboSequence('ctrl +s')).toEqual(['ctrl+s']);
    expect(comboSequence('ctrl+ shift + t')).toEqual(['ctrl+shift+t']);
    expect(comboSequence('Down Down End')).toEqual(['Down', 'Down', 'End']);
    expect(comboSequence('ctrl + a  ctrl + c')).toEqual(['ctrl+a', 'ctrl+c']);
    expect(comboSequence('+')).toEqual(['+']);
  });

  it('a trailing "+" is the plus key, not an empty key after the chord', () => {
    expect(splitCombo('ctrl++')).toEqual(['ctrl', '+']);
    expect(splitCombo('ctrl+shift++')).toEqual(['ctrl', 'shift', '+']);
    expect(splitCombo('ctrl+s')).toEqual(['ctrl', 's']);
    expect(splitCombo('+')).toEqual(['+']);
    expect(splitCombo('Return')).toEqual(['Return']);
  });

  it('the key tool presses the one chord, not Ctrl and then "+s"', async () => {
    const keyPress = vi.fn(async () => {});
    const ctx = asCtx({ keyPress, takeInputWarning: () => undefined });
    await tool('key_press').execute({ combo: 'ctrl + s' }, ctx);
    await tool('key_press').execute({ combo: 'ctrl++' }, ctx);
    expect(keyPress.mock.calls.map(c => (c as unknown[])[0])).toEqual(['ctrl+s', 'ctrl++']);
  });
});

describe('26 — invoke automationId is passed as an id, not used as a name', () => {
  it('the adapter gets automationId and no name', async () => {
    const invokeElement = vi.fn(async () => ({ success: true }));
    const ctx = asCtx({ invokeElement, getActiveWindow: async () => ({ processId: 7 }), noteRoute: () => {} });
    const r = await tool('invoke_element').execute({ automationId: 'btnSave', processId: 7 }, ctx);
    expect(r.success).toBe(true);
    expect(invokeElement).toHaveBeenCalledWith(expect.objectContaining({ automationId: 'btnSave', processId: 7 }));
    expect((invokeElement.mock.calls[0] as unknown[])[0]).not.toHaveProperty('name');
  });

  it('a name given with it goes along too', async () => {
    const invokeElement = vi.fn(async () => ({ success: true }));
    await tool('invoke_element').execute({ name: 'Save', automationId: 'btnSave', processId: 7 }, asCtx({ invokeElement, getActiveWindow: async () => null, noteRoute: () => {} }));
    expect(invokeElement).toHaveBeenCalledWith(expect.objectContaining({ name: 'Save', automationId: 'btnSave' }));
  });
});

describe('28 — the granular minimize_window really minimizes, and presses no keys', () => {
  const minimize = getA11yTools().find(t => t.name === 'minimize_window')!;
  const make = (ok: boolean, note: string | null) => {
    const setWindowState = vi.fn(async () => ok);
    const keyPress = vi.fn(async () => {});
    const ctx = { ensureInitialized: async () => {}, platform: { setWindowState, takeWindowNote: () => note }, desktop: { keyPress }, a11y: {} } as never;
    return { setWindowState, keyPress, ctx };
  };

  it('calls setWindowState("minimize") with the given fields; Win+Down is never pressed', async () => {
    const { setWindowState, keyPress, ctx } = make(true, 'Minimized window "Notes" [notepad] pid:5.');
    const r = await minimize.handler({ processName: 'notepad', title: 'Notes' }, ctx);
    expect(setWindowState).toHaveBeenCalledWith('minimize', { processName: 'notepad', title: 'Notes' });
    expect(keyPress).not.toHaveBeenCalled();
    expect(r).toEqual({ text: 'Minimized window "Notes" [notepad] pid:5.' });
  });

  it('a window that could not be minimized is an error that says why', async () => {
    const { ctx } = make(false, 'No open window matches processName "nope".');
    const r = await minimize.handler({ processName: 'nope' }, ctx);
    expect(r).toEqual({ text: 'No open window matches processName "nope".', isError: true });
  });
});
