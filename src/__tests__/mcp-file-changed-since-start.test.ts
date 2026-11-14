/**
 * `expect` / `verify` file_changed_since_start over MCP (audit 2026-11-13). Only the removed agent loop set the start time
 * it measures from, so over MCP it always failed ("no task-start timestamp"). The start is now the MCP session's: when the
 * agent connected.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../surface/mcp-server';
import { __setControlDirForTests } from '../core/control';
import type { ToolContext } from '../tools/registry';

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'clawd-since-start-'));
  __setControlDirForTests(dir);   // not stopped, whatever the machine running the tests says
});
afterAll(async () => {
  __setControlDirForTests(null);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('file_changed_since_start over MCP', () => {
  it('measures from when the agent connected: a file written in the session passes, an older one fails', async () => {
    const ctx: ToolContext = {
      desktop: {} as any, a11y: {} as any, cdp: {} as any, platform: {} as any,
      getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1, ensureInitialized: async () => {},
    };
    const { server } = await createMcpServer({ ctx });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await (server as any).connect(a);
    const client = new Client({ name: 'since-start-test', version: '0' });
    await client.connect(b);
    try {
      const written = join(dir, 'written.txt');
      const old = join(dir, 'old.txt');
      await fs.writeFile(old, 'x');
      const day = new Date(Date.now() - 86_400_000);
      await fs.utimes(old, day, day);
      await new Promise(r => setTimeout(r, 20));
      await fs.writeFile(written, 'x');
      const verify = async (path: string) => {
        const r = await client.callTool({ name: 'verify', arguments: { assertions: [{ type: 'file_changed_since_start', path }] } });
        return { isError: !!r.isError, text: (r.content as Array<{ text?: string }>).map(c => c.text ?? '').join('\n') };
      };
      const ok = await verify(written);
      expect(ok.text).toMatch(/after the session started/);
      expect(ok.isError).toBe(false);
      const no = await verify(old);
      expect(no.isError).toBe(true);
      expect(no.text).toMatch(/NOT modified since the session started/);
    } finally { await client.close(); }
  });
});
