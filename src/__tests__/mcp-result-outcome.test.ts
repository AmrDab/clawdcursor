/**
 * The MCP wrapper ends every action result and every error with one line: confirmed / unverified / refused / failed,
 * plus a code, hint and next call for failures (result-codes.ts). Driven through the real createMcpServer handlers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
const mockHasConsent = vi.fn<[], boolean>();
vi.mock('../surface/onboarding', () => ({
  hasConsent: () => mockHasConsent(),
  writeConsentFile: vi.fn(),
  revokeConsent: vi.fn(),
  runOnboarding: vi.fn().mockResolvedValue(true),
}));

const mockSafety = vi.fn<unknown[], unknown>(() => undefined);
// ── Mock the safety gate so WITH-CONSENT tests reach the handler ─────────────
// evaluateToolCall returns undefined (allow) or a {text} error object.
vi.mock('../tools/safety-gate', () => ({
  evaluateToolCall: (...a: unknown[]) => mockSafety(...a),
}));

// ── Mock controlBanner so touch() is a no-op ────────────────────────────────
vi.mock('../core/banner', () => ({
  controlBanner: { touch: vi.fn(), hold: vi.fn(() => () => {}), pin: vi.fn(), unpin: vi.fn(), isVisible: vi.fn(), overlayPids: vi.fn(() => [4242]) },
}));

import { createMcpServer, type McpServerLike, type McpToolResult } from '../surface/mcp-server';
import type { ToolContext } from '../tools/registry';
import { logger } from '../core/observability/logger';

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
const mockClientCaps = vi.fn<[], Record<string, unknown> | undefined>(() => undefined);
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

describe('MCP results carry an outcome line', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    vi.clearAllMocks();
    mockClientCaps.mockReturnValue(undefined);
    mockHasConsent.mockReturnValue(true);
    mockSafety.mockReturnValue(undefined);
  });

  async function handler(name: string): Promise<HandlerFn> {
    await createMcpServer({ ctx: fakeCtx(), compact: true });
    const h = capturedHandlers.get(name);
    expect(h).toBeTruthy();
    return h!;
  }
  const text = (r: McpToolResult) => r.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('\n');

  it('no consent → refused · CONSENT_REQUIRED', async () => {
    mockHasConsent.mockReturnValue(false);
    const r = await (await handler('computer'))({ action: 'click', x: 1, y: 1 });
    expect(text(r)).toMatch(/\n\[refused · CONSENT_REQUIRED · hint: /);
  });

  it('a safety refusal → refused, with the pause as the safe next call', async () => {
    mockSafety.mockReturnValue({ text: 'computer: safety confirm - "Pay" needs approval (requires user confirmation).', isError: true });
    const r = await (await handler('computer'))({ action: 'click', x: 1, y: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/\[refused · NEEDS_CONFIRMATION · .*next: system \{"action":"pause_for_user"/);
  });

  it('a bad action → failed · INVALID_ARGS (nothing ran)', async () => {
    const r = await (await handler('computer'))({ action: 'clik' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/\[failed · INVALID_ARGS · hint: fix the arguments; nothing ran\]$/);
  });

  it('a value a caller will use (build_uri\'s URI) comes back exactly as built — no line appended', async () => {
    const r = await (await handler('system'))({ action: 'build_uri', scheme: 'mailto', path: 'a@b.com' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('mailto:a@b.com');
  });

  it('exactly one outcome line per result', async () => {
    const r = await (await handler('computer'))({ action: 'clik' });
    expect(text(r).match(/\n\[(?:failed|refused|confirmed|unverified)/g)?.length).toBe(1);
  });
});


describe('screenshot-bound clicks through the MCP wrapper', () => {
  beforeEach(async () => {
    capturedHandlers.clear();
    vi.clearAllMocks();
    mockClientCaps.mockReturnValue(undefined);
    mockHasConsent.mockReturnValue(true);
    mockSafety.mockReturnValue(undefined);
    (await import('../core/screen-binding')).__resetShotsForTests();
  });

  function ctxWithFront(front: { processId: number; title: string; handle?: number }) {
    const state = { front, windows: [front] as Array<{ processId: number; title: string; handle?: number }> };
    const ctx = { ...fakeCtx(), platform: {
      getActiveWindow: vi.fn(async () => state.front),
      listWindows: vi.fn(async () => state.windows),
    } as any };
    return { state, ctx };
  }
  const text = (r: McpToolResult) => r.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('\n');
  const app = { processId: 1, title: 'App', handle: 11 };

  it('an image click with no screenshot is refused before anything moves', async () => {
    const { ctx } = ctxWithFront(app);
    await createMcpServer({ ctx, compact: true });
    const r = await capturedHandlers.get('computer')!({ action: 'click', x: 10, y: 10 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/none has been taken[\s\S]*\[refused · STALE_SCREENSHOT/);
  });

  it('a dialog opened after the screenshot → the next image click is refused; space:"screen" is not checked', async () => {
    const { state, ctx } = ctxWithFront(app);
    await createMcpServer({ ctx, compact: true });
    (await import('../core/screen-binding')).recordShot(state.windows);   // as computer screenshot does
    state.front = { processId: 1, title: 'Delete file?', handle: 12 };
    const refused = await capturedHandlers.get('computer')!({ action: 'click', x: 10, y: 10 });
    expect(text(refused)).toMatch(/a window that was not on screenshot s1 is in front/);
    const screen = await capturedHandlers.get('computer')!({ action: 'click', x: 10, y: 10, space: 'screen' });
    expect(text(screen)).not.toMatch(/STALE_SCREENSHOT/);
  });

  it('a click naming an older screenshot is refused', async () => {
    const { state, ctx } = ctxWithFront(app);
    await createMcpServer({ ctx, compact: true });
    const sb = await import('../core/screen-binding');
    sb.recordShot(state.windows);
    sb.recordShot(state.windows);
    const r = await capturedHandlers.get('computer')!({ action: 'click', x: 1, y: 1, shot: 's1' });
    expect(text(r)).toMatch(/older screenshot; the latest is s2/);
  });

  it('a batch stops at the image click when a new window came up under it', async () => {
    const { state, ctx } = ctxWithFront(app);
    await createMcpServer({ ctx, compact: true });
    (await import('../core/screen-binding')).recordShot(state.windows);
    state.front = { processId: 2, title: 'Other', handle: 22 };
    const r = await capturedHandlers.get('batch')!({ steps: [{ name: 'computer', arguments: { action: 'click', x: 1, y: 1 } }] });
    expect(text(r)).toMatch(/a window that was not on screenshot s1 is in front/);
  });

  it('a window that was on the screenshot coming to the front is NOT a refusal (click into the app)', async () => {
    const { state, ctx } = ctxWithFront(app);
    state.windows = [{ processId: 9, title: 'Host', handle: 99 }, app];
    state.front = state.windows[0];
    await createMcpServer({ ctx, compact: true });
    (await import('../core/screen-binding')).recordShot(state.windows);
    state.front = app;
    const r = await capturedHandlers.get('computer')!({ action: 'click', x: 1, y: 1 });
    expect(text(r)).not.toMatch(/STALE_SCREENSHOT/);
  });
});

describe('mac report fixes', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    vi.clearAllMocks();
    mockClientCaps.mockReturnValue(undefined);
    mockHasConsent.mockReturnValue(true);
    mockSafety.mockReturnValue(undefined);
  });
  const text = (r: McpToolResult) => r.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('\n');

  it('expect passed to a tool that does not check it is reported as ignored — not silently dropped', async () => {
    await createMcpServer({ ctx: fakeCtx(), compact: true });
    const r = await capturedHandlers.get('system')!({ action: 'build_uri', scheme: 'mailto', path: 'a@b.com', expect: [{ type: 'window_title_contains', value: 'x' }] });
    expect(text(r)).toMatch(/ignored an argument it does not accept: expect/);
  });
});

describe('expect is checked on every compound action (live macOS: window focus dropped it)', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    vi.clearAllMocks();
    mockClientCaps.mockReturnValue(undefined);
    mockHasConsent.mockReturnValue(true);
    mockSafety.mockReturnValue(undefined);
  });
  const text = (r: McpToolResult) => r.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('\n');
  const win = { processId: 1, title: 'Notes - Editor', processName: 'editor', bounds: { x: 0, y: 0, width: 10, height: 10 } };
  const ctxWithWindows = () => ({ ...fakeCtx(), platform: { listWindows: vi.fn(async () => [win, { ...win, processId: 2, title: 'secret-doc rk_live_xyz' }]), getActiveWindow: vi.fn(async () => win) } as any });

  it('a failing expect on a tool that does not check it itself → DEVIATION (no longer ignored)', async () => {
    await createMcpServer({ ctx: ctxWithWindows(), compact: true });
    const r = await capturedHandlers.get('system')!({ action: 'build_uri', scheme: 'mailto', path: 'a@b.com', expect: [{ type: 'window_title_contains', value: 'zzz' }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/DEVIATION/);
    expect(text(r)).not.toMatch(/ignored an argument/);
    // the failure detail names only the window in front, never other apps' titles
    expect(text(r)).toMatch(/the window in front is "Notes - Editor"; 1 other window open/);
    expect(text(r)).not.toMatch(/rk_live/);
  });

  it('a passing expect → verified', async () => {
    await createMcpServer({ ctx: ctxWithWindows(), compact: true });
    const r = await capturedHandlers.get('system')!({ action: 'build_uri', scheme: 'mailto', path: 'a@b.com', expect: [{ type: 'window_title_contains', value: 'Notes' }] });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/verified 1 check\(s\)/);
  });

  it('a malformed expect is refused before the action runs', async () => {
    await createMcpServer({ ctx: ctxWithWindows(), compact: true });
    const r = await capturedHandlers.get('system')!({ action: 'build_uri', scheme: 'mailto', path: 'a@b.com', expect: 'window title has Notes' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^expect rejected \(nothing executed\)/);
    expect(text(r)).not.toMatch(/mailto:a@b\.com/);
  });

  it('a failed action keeps its own error — not relabelled DEVIATION', async () => {
    await createMcpServer({ ctx: ctxWithWindows(), compact: true });
    const r = await capturedHandlers.get('system')!({ action: 'build_uri', scheme: '9bad', expect: [{ type: 'window_title_contains', value: 'zzz' }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/scheme must be lowercase/);
    expect(text(r)).not.toMatch(/DEVIATION/);
  });

  it('an ignored argument does not hide the verified verdict from the outcome line', async () => {
    await createMcpServer({ ctx: ctxWithWindows(), compact: true });
    const r = await capturedHandlers.get('system')!({ action: 'build_uri', scheme: 'mailto', path: 'a@b.com', message: 'x', expect: [{ type: 'window_title_contains', value: 'Notes' }] });
    expect(text(r)).toMatch(/ignored an argument/);
    // the verdict ends the text, so the outcome classifier's anchored ` — verified N check(s)` marker still matches
    expect(text(r)).toMatch(/ — verified 1 check\(s\)$/);
  });
});

describe('the user\'s own controls are never a target (owner requirement, live macOS 2026-10-24)', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    vi.clearAllMocks();
    mockClientCaps.mockReturnValue(undefined);
    mockHasConsent.mockReturnValue(true);
    mockSafety.mockReturnValue(undefined);
  });
  const text = (r: McpToolResult) => r.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('\n');

  it('reading the pill\'s tree by its pid is refused before anything runs', async () => {
    const ctx = fakeCtx();
    await createMcpServer({ ctx, compact: true });
    const r = await capturedHandlers.get('accessibility')!({ action: 'read_tree', processId: 4242 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/pid 4242 is clawdcursor's own on-screen control/);
    expect(text(r)).toMatch(/\[refused · OWN_UI · /);
  });

  // Mac run: stderr showed only the safety gate's `allow` for calls this guard then refused, so the log alone could not
  // tell a refused call from one that ran.
  it('a refusal after the safety gate is logged as a refusal', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await createMcpServer({ ctx: fakeCtx(), compact: true });
    await capturedHandlers.get('accessibility')!({ action: 'read_tree', processId: 4242 });
    expect(warn).toHaveBeenCalledWith('safety.refused', expect.objectContaining({ tool: 'accessibility', action: 'read_tree', guard: 'own_ui' }));
    warn.mockRestore();
  });
});

describe('--no-vision: no screenshot reaches the MCP client\'s model', () => {
  beforeEach(async () => {
    capturedHandlers.clear();
    vi.clearAllMocks();
    mockClientCaps.mockReturnValue(undefined);
    mockHasConsent.mockReturnValue(true);
    mockSafety.mockReturnValue(undefined);
    (await import('../core/screen-binding')).__resetShotsForTests();
  });
  const text = (r: McpToolResult) => r.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('\n');
  const ctxWithScreen = (disableVision: boolean): ToolContext => ({
    ...fakeCtx(),
    disableVision,
    desktop: { captureForLLM: vi.fn(async () => ({ buffer: Buffer.from('pixels'), llmWidth: 10, llmHeight: 10, width: 10, height: 10, scaleFactor: 1 })) },
  });
  const latestShot = async () => (await import('../core/screen-binding')).latestShotId();
  const REFUSED = /vision is disabled on this server[\s\S]*\[refused · VISION_DISABLED · .*next: accessibility \{"action":"compile_ui"\}/;

  // Every surface a screenshot can be taken from: the compact compound, and the two granular screenshot tools.
  const calls: Array<{ compact: boolean; name: string; args: Record<string, unknown> }> = [
    { compact: true, name: 'computer', args: { action: 'screenshot' } },
    { compact: false, name: 'desktop_screenshot', args: {} },
    { compact: false, name: 'screenshot_full', args: {} },
  ];

  describe.each(calls)('$name $args', ({ compact, name, args }) => {
    it('control: without it, the call returns an image and records the screenshot', async () => {
      await createMcpServer({ ctx: ctxWithScreen(false), compact });
      const r = await capturedHandlers.get(name)!(args);
      expect(r.content.some(c => c.type === 'image')).toBe(true);
      expect(await latestShot()).not.toBeNull();
    });

    it('with it, the image is withheld, the call is refused with a blind next step, and nothing is recorded', async () => {
      await createMcpServer({ ctx: ctxWithScreen(true), compact });
      const r = await capturedHandlers.get(name)!(args);
      expect(r.content.some(c => c.type === 'image')).toBe(false);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(REFUSED);
      expect(await latestShot()).toBeNull();
    });

    it('control: without it, the same call as a batch step runs and records the screenshot', async () => {
      await createMcpServer({ ctx: ctxWithScreen(false), compact });
      const r = await capturedHandlers.get('batch')!({ steps: [{ name, arguments: args }] });
      expect(r.isError).toBeFalsy();
      expect(await latestShot()).not.toBeNull();
    });

    it('with it, the same call as a batch step is refused and not recorded as seen', async () => {
      await createMcpServer({ ctx: ctxWithScreen(true), compact });
      const r = await capturedHandlers.get('batch')!({ steps: [{ name, arguments: args }] });
      expect(r.isError).toBe(true);
      expect(r.content.some(c => c.type === 'image')).toBe(false);
      // A batch has no outcome line of its own; the step's [blocked] status is the refusal (logged as refused).
      expect(text(r)).toMatch(/halted at step 0 — step 0 .*: vision is disabled on this server[\s\S]*0\. \[blocked\]/);
      expect(await latestShot()).toBeNull();
    });
  });
});
