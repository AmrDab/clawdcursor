/**
 * The tools/list wire must be portable across MODEL PROVIDERS, not just Claude.
 *
 * MCP hosts (Cursor, Codex, Windsurf, Zed, VS Code, Gemini CLI, Goose, …)
 * forward a server's inputSchema to whichever model the user picked. A schema
 * feature one provider rejects makes the host fail to register the WHOLE
 * server, usually with an opaque error. Three such features were on the wire:
 *
 *   - `anyOf` with a sibling `description` — Gemini 400:
 *       "schema specified other fields alongside any_of"
 *   - `items: {}` with no `type` — OpenAI strict:true 400:
 *       "schema must have a 'type' key"
 *   - root `$schema` — Gemini 400:
 *       Unknown name "$schema" at 'tools.function_declarations[0].parameters'
 *
 * These tests read the REAL tools/list response through an SDK client, so they
 * also catch an SDK upgrade that changes how schemas are serialized.
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
import { getAllTools, type ToolContext } from '../tools/registry';

const ctx = (): ToolContext => ({
  desktop: {} as any, a11y: {} as any, cdp: {} as any, platform: undefined,
  getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1,
  ensureInitialized: async () => {},
});

async function listTools(compact: boolean) {
  const { server } = await createMcpServer({ compact, ctx: ctx() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await (server as any).connect(a);
  const client = new Client({ name: 'portability-test', version: '0' });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

/** Walk every node of a JSON schema. */
function walk(node: unknown, visit: (n: Record<string, unknown>, path: string) => void, path = '') {
  if (!node || typeof node !== 'object') return;
  visit(node as Record<string, unknown>, path);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (v && typeof v === 'object') walk(v, visit, `${path}/${k}`);
  }
}

describe.each([
  ['compact', true],
  ['granular', false],
])('tools/list wire is provider-portable (%s surface)', (_label, compact) => {
  it('has no root $schema (Gemini rejects the unknown field)', async () => {
    for (const t of await listTools(compact)) {
      expect(t.inputSchema, t.name).not.toHaveProperty('$schema');
    }
  });

  it('has no anyOf / oneOf / allOf anywhere (Gemini + strict hosts)', async () => {
    for (const t of await listTools(compact)) {
      walk(t.inputSchema, (n, p) => {
        for (const k of ['anyOf', 'oneOf', 'allOf']) {
          expect(n, `${t.name}${p} has ${k}`).not.toHaveProperty(k);
        }
      });
    }
  });

  it('every `items` declares a type (OpenAI strict rejects items:{})', async () => {
    for (const t of await listTools(compact)) {
      walk(t.inputSchema, (n, p) => {
        if (n.type === 'array') {
          expect(n.items, `${t.name}${p} array without items`).toBeDefined();
          expect((n.items as any)?.type, `${t.name}${p}/items has no type`).toBeTruthy();
        }
      });
    }
  });
});

describe('array params keep their real shape', () => {
  it('every array param in the registry declares items (source invariant)', () => {
    for (const t of getAllTools()) {
      for (const [k, d] of Object.entries(t.parameters)) {
        if ((d as any).type === 'array') {
          expect((d as any).items, `${t.name}.${k} must declare items`).toBeDefined();
        }
      }
    }
  });

  it('the wire carries the declared item shape, not an empty schema', async () => {
    const tools = await listTools(false);
    const drag = tools.find(t => t.name === 'mouse_drag');
    const path = (drag?.inputSchema as any)?.properties?.path;
    expect(path?.type).toBe('array');
    expect(path?.items?.properties).toHaveProperty('x');
    expect(path?.items?.properties).toHaveProperty('y');
  });
});
