import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock heavy native deps (required by tool registry on import) ─────────────
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class {
    constructor(
      public left: number,
      public top: number,
      public width: number,
      public height: number,
    ) {}
  },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake')),
  })),
}));

// ── The key mock: control hasConsent() return value per test ─────────────────
const mockHasConsent = vi.fn<() => boolean>(() => true);
vi.mock('../surface/onboarding', () => ({
  hasConsent: () => mockHasConsent(),
  writeConsentFile: vi.fn(),
  revokeConsent: vi.fn(),
  runOnboarding: vi.fn().mockResolvedValue(true),
}));

// ── Mock controlBanner so touch() is a no-op ────────────────────────────────
vi.mock('../core/banner', () => ({
  controlBanner: { touch: vi.fn(), hold: vi.fn(() => () => {}), pin: vi.fn(), unpin: vi.fn(), isVisible: vi.fn(), overlayPids: vi.fn(() => [4242]) },
}));

import { createMcpServer, type McpServerLike, type McpToolResult } from '../surface/mcp-server';
import type { ToolContext } from '../tools/registry';

// ── Minimal fake ToolContext — matches mcp-server.test.ts fakeCtx() ──────────
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

// ── Capture handlers via a fake McpServer ────────────────────────────────────
// createMcpServer dynamically imports the SDK's McpServer. We intercept by
// mocking the SDK so our fake constructor is used instead.
type HandlerFn = (params: Record<string, unknown>) => Promise<McpToolResult>;
const capturedHandlers = new Map<string, HandlerFn>();
// The host's side of MCP elicitation (the low-level server under McpServer).
// Default: a host without elicitation support, so older tests are unaffected.
const mockClientCaps = vi.fn<() => Record<string, unknown> | undefined>(() => undefined);
const mockElicitInput = vi.fn();

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  class FakeMcpServer implements McpServerLike {
    constructor(_info: unknown, _opts: unknown) {}
    tool(
      name: string,
      _description: string,
      _schema: Record<string, unknown>,
      _annotations: Record<string, unknown>,
      handler: HandlerFn,
    ): void {
      capturedHandlers.set(name, handler);
    }
    async connect(_transport: unknown): Promise<void> {}
    server = {
      getClientCapabilities: () => mockClientCaps(),
      elicitInput: (params: unknown) => mockElicitInput(params),
    };
  }
  return { McpServer: FakeMcpServer };
});


import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stopControl, STOPPED_TEXT, __setControlDirForTests } from '../core/control';
import { controlBanner } from '../core/banner';

/**
 * The user's stop (control.ts) is the first refusal after consent. Live 2026-11 (Windows, 1.5.27 candidate): with the stop
 * active, `computer move` was refused with "no screenshot taken" and `system clipboard_write` with another refusal, so the
 * agent never learned the user had stopped it.
 */
describe('the stop comes before every other refusal in the MCP tool wrapper', () => {
  let dir: string;
  beforeEach(() => {
    capturedHandlers.clear();
    vi.clearAllMocks();
    mockClientCaps.mockReturnValue(undefined);
    mockHasConsent.mockReturnValue(true);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-stop-order-'));
    __setControlDirForTests(dir);
  });
  afterEach(() => {
    __setControlDirForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const text = (r: McpToolResult) => (r.content.find(b => b.type === 'text') as { text: string }).text;
  async function handlers() {
    await createMcpServer({ ctx: fakeCtx(), compact: true });
    return capturedHandlers;
  }

  it('a clipboard write says "stopped", and its handler never runs', async () => {
    stopControl('pill');
    const r = await (await handlers()).get('system')!({ action: 'clipboard_write', text: 'x' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(STOPPED_TEXT);
    expect(controlBanner.hold).not.toHaveBeenCalled();   // taken right before a handler runs
  });

  it('a screenshot-bound pointer call (no screenshot taken) says "stopped", not "no screenshot"', async () => {
    stopControl('pill');
    const r = await (await handlers()).get('computer')!({ action: 'move', x: 10, y: 10 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(STOPPED_TEXT);
    expect(text(r)).not.toMatch(/no screenshot/i);
  });

  it('what the stop allows (asking the user) is not refused by it', async () => {
    stopControl('pill');
    await (await handlers()).get('system')!({ action: 'pause_for_user', message: 'May I continue?' }).catch(() => null);
    expect(controlBanner.hold).toHaveBeenCalled();
  });
});
