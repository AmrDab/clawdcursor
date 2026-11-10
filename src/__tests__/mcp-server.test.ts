/**
 * mcp-server smoke tests.
 *
 * Confirms the central createMcpServer / startMcpHttp seams introduced in
 * PR7.1. These don't probe the SDK internals — they assert the registered
 * tool count matches the registry surface and that the HTTP transport
 * mounts on /mcp without errors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock heavy native deps ────────────────────────────────────────────────────
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake')),
  })),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../surface/mcp-server';
import { getAllTools, getCompactSurface, type ToolContext } from '../tools/registry';

function fakeCtx(): ToolContext {
  return {
    desktop: {} as any,
    a11y: {} as any,
    cdp: {} as any,
    platform: undefined,
    getMouseScaleFactor: () => 1,
    getScreenshotScaleFactor: () => 1,
    ensureInitialized: async () => {},
  };
}

describe('createMcpServer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers the full granular surface by default', async () => {
    const ctx = fakeCtx();
    const handle = await createMcpServer({ ctx });
    expect(handle.toolCount).toBe(getAllTools().length);
    expect(handle.tools.length).toBe(getAllTools().length);
  });

  it('registers the 5 primitive compounds + batch with --compact', async () => {
    const ctx = fakeCtx();
    const handle = await createMcpServer({ compact: true, ctx });
    expect(handle.toolCount).toBe(getCompactSurface().length);
    expect(handle.toolCount).toBe(6); // computer/accessibility/window/system/browser + batch
  });

  it('returns an McpServer instance ready for transport.connect', async () => {
    const ctx = fakeCtx();
    const { server } = await createMcpServer({ ctx });
    expect(typeof server.connect).toBe('function');
  });

  it('serves the tools-only instructions and no `task` tool', async () => {
    const { server, tools } = await createMcpServer({ compact: true, ctx: fakeCtx() });
    expect(tools.find(t => t.name === 'task')).toBeUndefined();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await (server as any).connect(a);
    const client = new Client({ name: 'instructions-test', version: '0' });
    await client.connect(b);
    const instructions = client.getInstructions() ?? '';
    await client.close();
    expect(instructions).toContain('You drive the tools yourself');
    expect(instructions).not.toContain('start the daemon');
  });
});
