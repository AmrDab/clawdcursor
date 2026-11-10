/**
 * Session log at the MCP boundary (live macOS blind test 2026-10-15: 66 calls
 * made, 63 logged — the safety-refused ones were missing — and a batch showed
 * up as one act-other row).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
const consent = { given: true };
vi.mock('../surface/onboarding', () => ({
  hasConsent: () => consent.given, writeConsentFile: vi.fn(), revokeConsent: vi.fn(), runOnboarding: vi.fn(),
}));
vi.mock('../core/banner', () => ({
  controlBanner: { touch: vi.fn(), hold: vi.fn(() => () => {}), pin: vi.fn(), unpin: vi.fn(), isVisible: vi.fn(), overlayPids: vi.fn(() => [4242]) },
}));
// Refuse every `computer key` call — on the direct route and inside a batch.
vi.mock('../tools/safety-gate', () => ({
  evaluateToolCall: vi.fn((tool: { name: string }, params: Record<string, unknown>) =>
    tool.name === 'computer' && params.action === 'key' ? { text: 'computer: safety block - blocked key combo' } : undefined),
}));

type HandlerFn = (params: Record<string, unknown>) => Promise<{ isError?: boolean }>;
const handlers = new Map<string, HandlerFn>();
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(name: string, _d: string, _s: unknown, _a: unknown, h: HandlerFn) { handlers.set(name, h); }
    async connect() {}
    server = { getClientCapabilities: () => undefined };
  },
}));

import { createMcpServer } from '../surface/mcp-server';
import { listSessions, readSession } from '../surface/session-log';
import { logger } from '../core/observability/logger';
import { __setForegroundReaderForTests } from '../core/control';
import { guardInputMethods } from '../platform/pointer-guard';
import type { ToolContext } from '../tools/registry';

const ctx = { desktop: {}, a11y: {}, cdp: {}, platform: undefined, getMouseScaleFactor: () => 1,
  getScreenshotScaleFactor: () => 1, ensureInitialized: async () => {} } as unknown as ToolContext;

beforeEach(async () => {
  process.env.CLAWDCURSOR_SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcp-sess-'));
  delete process.env.CLAWDCURSOR_SESSION_LOG;
  handlers.clear();
  consent.given = true;
  await createMcpServer({ ctx, compact: true });
});

describe('MCP session log', () => {
  // Live 2026-11-10: a run could not be traced, the log never said which app a call acted on.
  it('names the app an input went to (its display name, never the window title), and only on the call that sent it', async () => {
    __setForegroundReaderForTests(async () => ({ processId: 7, processName: 'ugraf', appName: 'Designcenter NX', title: 'secret.prt' }));
    (ctx as { platform: unknown }).platform = guardInputMethods({ keyDown: async () => {}, keyUp: async () => {} });
    try {
      await handlers.get('computer')!({ action: 'key_down', combo: 'shift' });
      await handlers.get('computer')!({ action: 'key_up', combo: 'shift' });   // not a guarded input: no window was read
    } finally {
      (ctx as { platform: unknown }).platform = undefined;
      __setForegroundReaderForTests(async () => null);
    }
    const file = listSessions()[0];
    const { calls } = readSession(file);
    expect(calls[0]).toMatchObject({ action: 'key_down', ok: true, app: 'Designcenter NX' });
    expect(calls[1]).toMatchObject({ action: 'key_up', ok: true });
    expect(calls[1]).not.toHaveProperty('app');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('secret');
  });

  it('logs a safety-refused call with outcome "refused"', async () => {
    const r = await handlers.get('computer')!({ action: 'key', key: 'cmd+q' });
    expect(r.isError).toBe(true);
    const { calls } = readSession(listSessions()[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool: 'computer', action: 'key', ok: false, outcome: 'refused' });
  });

  it('logs a call blocked by the consent prompt with outcome "consent_required"', async () => {
    consent.given = false;
    const r = await handlers.get('computer')!({ action: 'screenshot' });
    expect(r.isError).toBe(true);
    const { calls } = readSession(listSessions()[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool: 'computer', action: 'screenshot', ok: false, outcome: 'consent_required' });
  });

  it('logs each batch step with its own class and outcome', async () => {
    await handlers.get('batch')!({ steps: [{ name: 'computer', arguments: { action: 'key', key: 'cmd+q' } }] });
    const { calls } = readSession(listSessions()[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('batch');
    expect(calls[0].steps).toEqual([{ tool: 'computer', action: 'key', cls: 'act-other', ok: false, outcome: 'refused' }]);
  });

  // A batch a guard halted is a refusal, not an error: the report counted it in `errors` and quoted it as the error.
  it('a batch halted by a guard is recorded as refused, and the step refusal is logged', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await handlers.get('batch')!({ steps: [{ name: 'accessibility', arguments: { action: 'read_tree', processId: 4242 } }] });
    expect(warn).toHaveBeenCalledWith('safety.refused', expect.objectContaining({ tool: 'accessibility', guard: 'own_ui', batchStep: 0 }));
    warn.mockRestore();
    const { calls, tally } = readSession(listSessions()[0]);
    expect(calls[0]).toMatchObject({ tool: 'batch', ok: false, outcome: 'refused' });
    expect(tally).toMatchObject({ errors: 0, refused: 1 });
  });

  it('a call stopped by the consent prompt is counted as refused, not as an error', async () => {
    consent.given = false;
    await handlers.get('computer')!({ action: 'screenshot' });
    expect(readSession(listSessions()[0]).tally).toMatchObject({ errors: 0, refused: 1 });
  });
});
