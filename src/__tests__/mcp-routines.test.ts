/**
 * Routines over MCP: the server records what a session changed, `batch save_as` saves it (a processId as the process
 * name), the next session's instructions name the routine, and `batch replay` runs it.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
import { __setRoutinesDirForTests, loadRoutine } from '../tools/routines';
import type { ToolContext } from '../tools/registry';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-mcp-routines-'));
  __setControlDirForTests(dir);
  __setRoutinesDirForTests(path.join(dir, 'routines'));
});
afterAll(() => {
  __setControlDirForTests(null);
  __setRoutinesDirForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const win = { processId: 4242, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false };
const platform = {
  focusWindow: vi.fn(async () => true),
  getActiveWindow: vi.fn(async () => win),
  listWindows: vi.fn(async () => [win]),
};
const ctx = (): ToolContext => ({
  desktop: {} as any, a11y: {} as any, cdp: {} as any, platform: platform as any,
  getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1, ensureInitialized: async () => {},
});

async function session() {
  const { server } = await createMcpServer({ ctx: ctx() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await (server as any).connect(a);
  const client = new Client({ name: 'routines-test', version: '0' });
  await client.connect(b);
  const text = (r: any) => (r.content as Array<{ text?: string }>).map(c => c.text ?? '').join('\n');
  return { client, text, instructions: client.getInstructions() ?? '' };
}

describe('routines over MCP', () => {
  it('records, saves, lists in the next session, and replays', async () => {
    const first = await session();
    expect(first.instructions).toMatch(/save it before you report back: batch with save_as/);
    expect(first.instructions).not.toMatch(/Saved routines on this computer/);
    await first.client.callTool({ name: 'window', arguments: { action: 'focus', processId: 4242 } });
    await first.client.callTool({ name: 'system', arguments: { action: 'system_time' } });   // a read: not recorded
    const saved = await first.client.callTool({ name: 'batch', arguments: { save_as: 'focus-notes', description: 'Bring Notepad to the front' } });
    expect(first.text(saved)).toMatch(/Saved routine "focus-notes" \(1 steps\)/);
    await first.client.close();
    expect(loadRoutine('focus-notes')?.steps).toEqual([{ name: 'window', arguments: { action: 'focus', processName: 'notepad' } }]);

    const second = await session();
    expect(second.instructions).toMatch(/Saved routines on this computer: focus-notes \(1 steps\): Bring Notepad to the front\./);
    platform.focusWindow.mockClear();
    const r = await second.client.callTool({ name: 'batch', arguments: { replay: 'focus-notes' } });
    expect(second.text(r)).toMatch(/Replayed routine "focus-notes"\./);
    expect(platform.focusWindow).toHaveBeenCalledWith(expect.objectContaining({ processName: 'notepad' }));
    await second.client.close();
  });
});
