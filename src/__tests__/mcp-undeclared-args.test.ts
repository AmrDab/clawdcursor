/**
 * Mac, 2026-11-17, over stdio `mcp --compact`: system ocr with processId still read the whole screen, though the compact
 * dispatcher refuses such a read. The MCP SDK validates a call with zod, which drops keys the schema does not list, so
 * processId never reached the dispatcher (and no "ignored an argument" warning either). Through a real MCP client here.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
vi.mock('../surface/onboarding', () => ({
  hasConsent: () => true, writeConsentFile: vi.fn(), revokeConsent: vi.fn(), runOnboarding: vi.fn().mockResolvedValue(true),
}));
vi.mock('../core/banner', () => ({
  controlBanner: { touch: vi.fn(), hold: vi.fn(() => () => {}), pin: vi.fn(), unpin: vi.fn(), isVisible: vi.fn(), overlayPids: vi.fn(() => []) },
}));
const reads = vi.hoisted(() => ({ ocr: vi.fn() }));
vi.mock('../platform/ocr-engine', async (orig) => ({
  ...(await orig<typeof import('../platform/ocr-engine')>()),
  ocrEngine: () => ({
    isAvailable: () => true,
    recognizeScreen: async () => { reads.ocr(); return { elements: [], fullText: '', durationMs: 1 }; },
    recognizeRegion: async () => { reads.ocr(); return { elements: [], fullText: '', durationMs: 1 }; },
    invalidateCache() {},
  }),
}));
vi.mock('../platform/mac-ax', async (orig) => ({ ...(await orig<typeof import('../platform/mac-ax')>()), screenLockedMessage: async () => null }));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../surface/mcp-server';
import { __setControlDirForTests } from '../core/control';
import type { ToolContext } from '../tools/registry';

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'clawd-undeclared-'));
  __setControlDirForTests(dir);   // not stopped, whatever the machine running the tests says
});
afterAll(async () => {
  __setControlDirForTests(null);
  await fs.rm(dir, { recursive: true, force: true });
});
beforeEach(() => reads.ocr.mockClear());

async function call(name: string, args: Record<string, unknown>) {
  const ctx: ToolContext = {
    desktop: { getDpiRatio: () => 1 } as any, a11y: { invalidateCache() {} } as any, cdp: {} as any, platform: {} as any,
    getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1, ensureInitialized: async () => {},
  };
  const { server } = await createMcpServer({ ctx });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await (server as any).connect(a);
  const client = new Client({ name: 'undeclared-args-test', version: '0' });
  await client.connect(b);
  try {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: (r.content as Array<{ text?: string }>).map(c => c.text ?? '').join('\n') };
  } finally { await client.close(); }
}

describe('a compound call\'s arguments that its schema does not list, over MCP', () => {
  // ocr takes processId itself now; processName is not in the `system` schema.
  it('system ocr with processName is refused, and nothing is read', async () => {
    const r = await call('system', { action: 'ocr', processName: 'Terminal' });
    expect(reads.ocr).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/system ocr NOT EXECUTED: it cannot be limited to one window by processName/);
    expect(r.text).toContain('the window tool, action focus, processName "Terminal"');
  });

  it('ocr without it still reads', async () => {
    const r = await call('system', { action: 'ocr' });
    expect(reads.ocr).toHaveBeenCalledTimes(1);
    expect(r.isError).toBe(false);
  });

  it('a surplus argument on another call is reported, not dropped in silence', async () => {
    const r = await call('system', { action: 'system_time', bogus_arg: 'x' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/ignored an argument it does not accept: bogus_arg/);
  });
});
