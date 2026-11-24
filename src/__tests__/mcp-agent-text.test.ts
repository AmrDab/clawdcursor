/**
 * Text an MCP agent reads must only name tools and behaviour that exist on
 * the MCP surface: no `ask_user` (internal loop only), no "follows context"
 * coordinate default (MCP clicks default to image space).
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
vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(), png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(), toBuffer: vi.fn().mockResolvedValue(Buffer.from('x')),
  })),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../surface/mcp-server';
import type { ToolContext } from '../tools/registry';

const ctx = (): ToolContext => ({
  desktop: {} as any, a11y: {} as any, cdp: {} as any, platform: undefined,
  getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1,
  ensureInitialized: async () => {},
});

async function connect(compact: boolean) {
  const { server } = await createMcpServer({ compact, ctx: ctx() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await (server as any).connect(a);
  const client = new Client({ name: 'agent-text-test', version: '0' });
  await client.connect(b);
  const instructions = client.getInstructions() ?? '';
  const { tools } = await client.listTools();
  await client.close();
  return { instructions, tools };
}

describe('MCP agent-facing text matches the MCP surface', () => {
  it.each([false, true])('instructions never name ask_user (compact=%s)', async (compact) => {
    const { instructions } = await connect(compact);
    expect(instructions).toContain('pause_for_user');
    expect(instructions).not.toContain('ask_user');
  });

  // Agents ended with "the remaining steps are for you": every surface an agent of any provider reads says to do those itself.
  it.each([false, true])('the final-reply check is in the instructions and on the pause tool (compact=%s)', async (compact) => {
    const { instructions, tools } = await connect(compact);
    expect(instructions).toContain('Before your final reply, read it again: a step it leaves for the user on this computer');
    expect(instructions).toContain(`ask for it with ${compact ? 'the system tool, action pause_for_user' : 'the pause_for_user tool'} when you reach it`);
    const pause = tools.find(t => t.name === (compact ? 'system' : 'pause_for_user'));
    const message = (pause?.inputSchema.properties as Record<string, { description?: string }> | undefined)?.message?.description ?? '';
    expect(message).toContain('This is how the user gets a step, never a list of steps at the end of your reply: do every other step yourself.');
    if (!compact) expect(pause?.description).toContain('the only way to hand the user a step: never end your reply with steps for them to do on this computer');
  });

  it('mouse_click and read_screen descriptions describe the MCP behaviour', async () => {
    const { tools } = await connect(false);
    const desc = (n: string) => tools.find(t => t.name === n)?.description ?? '';
    expect(desc('mouse_click')).toContain('Click at');
    expect(desc('mouse_click')).not.toContain('follows context');
    expect(desc('read_screen')).not.toContain('auto-attached');
  });
});
