/**
 * The pill shows for a batch when one of its steps acts (batchActs), whether the step names its tool bare or the way
 * the agent's host shows it (mcp__clawdcursor__…, Mac run 2026-11-15).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

import { batchActs } from '../surface/mcp-server';
import { bareStepName } from '../tools/batch';

describe('batchActs', () => {
  it('an acting step shows the pill, with or without the host prefix', () => {
    for (const name of ['computer', 'mcp__clawdcursor__computer', 'mcp__plugin_clawdcursor_clawdcursor__computer']) {
      expect(batchActs([{ name, arguments: { action: 'click', x: 1, y: 2 } }])).toBe(true);
    }
    expect(batchActs([{ name: 'mcp__clawdcursor__mouse_click', arguments: { x: 1, y: 2 } }])).toBe(true);
  });
  it('reads alone do not', () => {
    expect(batchActs([{ name: 'mcp__clawdcursor__accessibility', arguments: { action: 'read_tree' } }])).toBe(false);
  });
});

describe('bareStepName', () => {
  it('takes off only a clawdcursor server\'s prefix', () => {
    expect(bareStepName('mcp__clawdcursor__accessibility')).toBe('accessibility');
    expect(bareStepName('mcp__plugin_clawdcursor_clawdcursor__mouse_click')).toBe('mouse_click');
    expect(bareStepName('mouse_click')).toBe('mouse_click');
    expect(bareStepName('mcp__claude-in-chrome__computer')).toBe('mcp__claude-in-chrome__computer');
    expect(bareStepName('mcp__computer-use__wait')).toBe('mcp__computer-use__wait');
  });
});

describe('batchActs, background acts', () => {
  it('steps that arrive as a JSON string show the pill too', () => {
    expect(batchActs(JSON.stringify([{ name: 'accessibility', arguments: { action: 'set_value', name: 'To', value: 'x', processId: 9 } }]))).toBe(true);
  });
  it('so do the granular names of by-name and page acts', async () => {
    const { getAllTools } = await import('../tools/registry');
    const names = getAllTools().map(t => t.name).filter(n => /^(set_value|invoke_element|toggle_element|select_element|cdp_click|cdp_type|cdp_select_option|cdp_scroll|cdp_switch_tab)$/.test(n));
    expect(names.length).toBeGreaterThan(4);
    expect(names.filter(n => !batchActs([{ name: n, arguments: {} }]))).toEqual([]);
  });
});
