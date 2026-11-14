/**
 * A tool call the MCP server receives and the same call as a batch step pass the same checks in the same order:
 * the user's Stop, then a screenshot-bound pointer call, then clawdcursor's own controls / a pending pause.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
vi.mock('../surface/onboarding', () => ({ hasConsent: () => true, writeConsentFile: vi.fn(), revokeConsent: vi.fn(), runOnboarding: vi.fn() }));
vi.mock('../core/banner', () => ({
  controlBanner: { touch: vi.fn(), hold: vi.fn(() => () => {}), pin: vi.fn(), unpin: vi.fn(), isVisible: vi.fn(), overlayPids: vi.fn(() => []) },
}));
const pause = vi.hoisted(() => ({ pending: null as null | { message: string } }));
vi.mock('../core/pause-gate', () => ({ pauseGate: { current: () => pause.pending } }));

type Handler = (params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(name: string, _d: string, _s: unknown, _a: unknown, h: Handler) { handlers.set(name, h); }
    async connect() {}
    server = { getClientCapabilities: () => undefined };
  },
}));

import { createMcpServer } from '../surface/mcp-server';
import { executeBatch } from '../tools/batch';
import { __resetShotsForTests } from '../core/screen-binding';
import { noteScreenshot } from '../tools/screen-guard';
import { afterCall, guardedCall } from '../tools/call-guards';
import { ocrEngine } from '../platform/ocr-engine';
import { stopControl, STOPPED_TEXT, __setControlDirForTests } from '../core/control';
import type { ToolContext } from '../tools/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ctx = { desktop: {}, a11y: {}, cdp: {}, platform: undefined, getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1,
  ensureInitialized: async () => {} } as unknown as ToolContext;
const NO_SHOT = /none has been taken/;
const PAUSED = /a pause is waiting for the user on screen/;

async function mcpText(params: Record<string, unknown>): Promise<string> {
  await createMcpServer({ ctx, compact: false });
  const r = await handlers.get('mouse_click')!(params);
  return r.content.map(c => c.text ?? '').join('\n');
}
async function batchText(params: Record<string, unknown>): Promise<string> {
  const r = await executeBatch([{ name: 'mouse_click', arguments: params }], ctx);
  return r.steps[0].text;
}

beforeEach(() => { __resetShotsForTests(); pause.pending = null; });
afterEach(() => __setControlDirForTests(null));

describe.each([['the MCP server', mcpText], ['a batch step', batchText]] as const)('%s', (_name, run) => {
  it('an image click with no screenshot taken, while a pause waits: the screen binding answers first', async () => {
    pause.pending = { message: 'Sign in' };
    const text = await run({ x: 10, y: 10 });
    expect(text).toMatch(NO_SHOT);
    expect(text).not.toMatch(PAUSED);
  });

  it('the same call after the user stopped clawdcursor: the Stop answers first', async () => {
    __setControlDirForTests(fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-guards-')));
    stopControl('test');
    pause.pending = { message: 'Sign in' };
    const text = await run({ x: 10, y: 10 });
    expect(text).toContain(STOPPED_TEXT.slice(0, 60));
    expect(text).not.toMatch(NO_SHOT);
  });

  it('a screen-space click while a pause waits: the pause answers', async () => {
    pause.pending = { message: 'Sign in' };
    expect(await run({ x: 10, y: 10, space: 'screen' })).toMatch(PAUSED);
  });
});

describe('a batch step with a precondition', () => {
  it('is checked again after the precondition: a window that came to the front meanwhile refuses the image click', async () => {
    const editor = { title: 'Editor', processId: 7, processName: 'editor', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false };
    const dialog = { title: 'Save changes?', processId: 8, processName: 'dialog', bounds: { x: 100, y: 100, width: 300, height: 200 }, isMinimized: false };
    let front = editor;
    const platform = {
      getActiveWindow: vi.fn(async () => front),
      listWindows: vi.fn(async () => [editor]),
      mouseClick: vi.fn(async () => undefined),
    };
    const live = { ...ctx, platform } as unknown as ToolContext;
    await noteScreenshot(live);   // the screenshot shows the editor only
    // The first read is the check before the precondition; the second is the precondition's own (get_active_window), and
    // a dialog opens while it runs.
    let reads = 0;
    platform.getActiveWindow.mockImplementation(async () => { const w = front; if (++reads === 2) front = dialog; return w; });

    const r = await executeBatch([{ name: 'mouse_click', arguments: { x: 10, y: 10 }, expect: { window: 'Editor' } }], live);
    expect(r.steps[0].status).toBe('blocked');
    expect(r.steps[0].text).toMatch(/is in front now/);
    expect(platform.mouseClick).not.toHaveBeenCalled();
  });
});

describe('after a call', () => {
  it('a call that acts empties the OCR cache, input or not (a launch, a URL, a relaunch); a read does not', async () => {
    const empty = vi.spyOn(ocrEngine(), 'invalidateCache');
    try {
      for (const [tool, action] of [['window', 'open_url'], ['system', 'open_uri'], ['window', 'open_app'], ['system', 'relaunch_with_cdp'], ['navigate_browser', undefined]] as const) {
        empty.mockClear();
        await afterCall(guardedCall(tool, action, {}), { text: 'ok' }, ctx);
        expect(empty, `${tool} ${action ?? ''}`).toHaveBeenCalledTimes(1);
      }
      empty.mockClear();
      await afterCall(guardedCall('accessibility', 'read_tree', {}), { text: 'ok' }, ctx);
      await afterCall(guardedCall('read_screen', undefined, {}), { text: 'ok' }, ctx);
      expect(empty).not.toHaveBeenCalled();
    } finally {
      empty.mockRestore();
    }
  });
});
