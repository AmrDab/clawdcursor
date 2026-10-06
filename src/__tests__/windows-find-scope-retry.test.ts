/**
 * Windows findElements scopes an unscoped query to the LIVE foreground window.
 * Live regression (Windows 11, 2026-10): right after `window focus` succeeded
 * on Edge, `accessibility find name:"Identity validation"` (no processId)
 * returned "(no elements found)" — the MCP host's window was foreground at
 * that instant, so the wrong app was searched, and nothing said which.
 *
 * Fix under test: when the foreground-scoped search is empty and the caller
 * gave no processId, retry once scoped to the window clawdcursor most
 * recently focused (if different), and expose which scopes were searched so
 * the "(no elements found)" text can say so.
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

const runCalls: Array<Record<string, unknown>> = [];
const HOST = { processId: 1111, processName: 'claude', title: 'Claude', bounds: { x: 0, y: 0, width: 10, height: 10 }, isMinimized: false };
const EDGE = { processId: 3292, processName: 'msedge', title: 'Azure portal - Edge', bounds: { x: 0, y: 0, width: 10, height: 10 }, isMinimized: false };
const BUTTON = { name: 'Identity validation', controlType: 'ControlType.Text', bounds: { x: 1, y: 1, width: 5, height: 5 }, processId: 3292 };

vi.mock('../platform/ps-runner', () => ({
  psRunner: {
    run: (payload: Record<string, unknown>) => {
      runCalls.push(payload);
      switch (payload.cmd) {
        case 'get-foreground-window': return Promise.resolve({ success: true, ...HOST });
        case 'focus-window': return Promise.resolve({ success: true, foreground: true });
        case 'find-element': return Promise.resolve(payload.processId === EDGE.processId ? [BUTTON] : []);
        default: return Promise.resolve({});
      }
    },
    start: vi.fn(), stop: vi.fn(),
  },
}));

import { WindowsAdapter } from '../platform/windows';
import { getA11yTools } from '../tools/a11y';
import type { ToolContext } from '../tools/types';

describe('WindowsAdapter.findElements — last-focused window retry', () => {
  let adapter: WindowsAdapter;
  beforeEach(() => {
    runCalls.length = 0;
    adapter = new WindowsAdapter();
    vi.spyOn(adapter, 'listWindows').mockResolvedValue([HOST, EDGE] as never);
  });

  it('retries once against the window clawdcursor last focused when the foreground search is empty', async () => {
    expect(await adapter.focusWindow({ processId: EDGE.processId })).toBe(true);
    const hits = await adapter.findElements({ name: 'Identity validation' });
    expect(hits.map(h => h.name)).toEqual(['Identity validation']);
    const finds = runCalls.filter(c => c.cmd === 'find-element').map(c => c.processId);
    expect(finds).toEqual([HOST.processId, EDGE.processId]);
  });

  it('does not retry when the caller scoped the query explicitly', async () => {
    await adapter.focusWindow({ processId: EDGE.processId });
    const hits = await adapter.findElements({ name: 'Identity validation', processId: HOST.processId });
    expect(hits).toEqual([]);
    expect(runCalls.filter(c => c.cmd === 'find-element')).toHaveLength(1);
  });

  it('records the searched scopes so a miss can say where it looked', async () => {
    const hits = await adapter.findElements({ name: 'nothing' });
    expect(hits).toEqual([]);
    expect(adapter.lastFindScope?.map(s => s.processId)).toEqual([HOST.processId]);
  });
});

describe('find_element — "(no elements found)" names the searched window', () => {
  it('appends the scope(s) the adapter searched', async () => {
    const tool = getA11yTools().find(t => t.name === 'find_element')!;
    const ctx = {
      ensureInitialized: vi.fn(),
      cdp: { isConnected: vi.fn().mockResolvedValue(false) },
      platform: {
        findElements: vi.fn().mockResolvedValue([]),
        lastFindScope: [{ processId: 1111, processName: 'claude', title: 'Claude' }],
      },
    } as unknown as ToolContext;
    const r = await tool.handler({ name: 'Identity validation' }, ctx);
    expect(r.text).toMatch(/no elements found/);
    expect(r.text).toMatch(/pid 1111/);
    expect(r.text).toMatch(/claude/);
  });
});
