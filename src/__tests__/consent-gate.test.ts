/**
 * Consent gate regression test (PR #169 — fix/consent-non-fatal).
 *
 * Approach: BEHAVIORAL.
 * `hasConsent` is a simple `fs.existsSync` call on a known path — it is
 * trivially mockable with `vi.mock`. The McpServerLike interface used by
 * `createMcpServer` is structural: we capture the registered handler callbacks
 * by replacing `server.tool()` with a spy. We then invoke those callbacks
 * directly (no SDK needed), controlling consent via the vi.mock, and assert:
 *   1. NO-CONSENT  → isError:true + consent-prompt text, handler NOT called.
 *   2. WITH-CONSENT → the call goes on to the handler.
 *
 * We do NOT use a source-guard approach because the real behaviour is
 * straightforward to exercise without heavy SDK setup.
 */

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
const mockHasConsent = vi.fn<[], boolean>();
vi.mock('../surface/onboarding', () => ({
  hasConsent: () => mockHasConsent(),
  writeConsentFile: vi.fn(),
  revokeConsent: vi.fn(),
  runOnboarding: vi.fn().mockResolvedValue(true),
}));

// The agent's opt-out writes ~/.clawdcursor/telemetry.json: a spy here, never the real file.
const mockSetTelemetry = vi.fn((_on: boolean) => true);
vi.mock('../core/observability/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/observability/telemetry')>()),
  setTelemetryEnabled: (on: boolean) => mockSetTelemetry(on),
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

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('consent gate in createMcpServer tool handlers (PR #169)', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    vi.clearAllMocks();
    mockClientCaps.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function buildAndGetHandler(): Promise<HandlerFn> {
    const ctx = fakeCtx();
    await createMcpServer({ ctx, compact: true }); // compact → fewer tools, faster
    // Pick any registered handler — every tool goes through the same gate.
    const [name, handler] = [...capturedHandlers.entries()][0];
    expect(name).toBeTruthy(); // sanity: at least one tool was registered
    return handler;
  }

  // ── 1. NO CONSENT ───────────────────────────────────────────────────────────
  describe('without consent', () => {
    it('returns isError: true', async () => {
      mockHasConsent.mockReturnValue(false);
      const handler = await buildAndGetHandler();

      const result = await handler({});

      expect(result.isError).toBe(true);
    });

    it('returns a message containing the consent command', async () => {
      mockHasConsent.mockReturnValue(false);
      const handler = await buildAndGetHandler();

      const result = await handler({});

      const text = result.content.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined;
      expect(text).toBeDefined();
      expect(text!.text).toContain('clawdcursor consent --accept');
    });

    it('does NOT call the underlying tool handler', async () => {
      mockHasConsent.mockReturnValue(false);

      // Spy on the tool handler to verify it's never reached.
      // The call takes the pill (controlBanner.hold) right before its handler runs:
      // if that happened, the consent check was passed.
      const { controlBanner } = await import('../core/banner');
      const gateSpy = vi.mocked(controlBanner.hold);
      gateSpy.mockClear();

      const handler = await buildAndGetHandler();
      await handler({});

      // If the pill was taken, the consent check was bypassed (regression).
      expect(gateSpy).not.toHaveBeenCalled();
    });
  });

  // ── 2. WITH CONSENT ──────────────────────────────────────────────────────────
  describe('with consent', () => {
    it('does NOT return a consent-error when consent is present', async () => {
      // When consent IS present, the handler must not return the consent-prompt
      // error text. The call may succeed or fail for tool reasons — that's fine.
      // We only care that the consent gate itself doesn't fire.
      mockHasConsent.mockReturnValue(true);

      const handler = await buildAndGetHandler();
      // Allow any tool-level errors; we only inspect the consent-error shape.
      const result = await handler({}).catch((): null => null);

      if (result !== null) {
        const text = result.content.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined;
        const isConsentError = text?.text.includes('clawdcursor consent --accept');
        expect(isConsentError).toBe(false);
      }
      // If the promise rejected that's also fine — it means a tool threw, which
      // is past the consent gate.
    });

    it('passes through to the handler (the call takes the pill)', async () => {
      // The decisive proof that the consent gate let a call through is that the
      // call takes the pill (controlBanner.hold), which happens right before its
      // handler runs. With consent=false the test above confirmed it does NOT.
      mockHasConsent.mockReturnValue(true);

      const { controlBanner } = await import('../core/banner');
      const gateSpy = vi.mocked(controlBanner.hold);
      gateSpy.mockClear();

      const handler = await buildAndGetHandler();
      // Handler may throw/return error from the real tool, but that's after the gate.
      await handler({}).catch(() => { /* tool errors are not the concern here */ });

      // The handler was reached — the consent gate did NOT short-circuit.
      expect(gateSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── 3. Per-call re-evaluation (no restart needed) ───────────────────────────
  describe('per-call consent re-evaluation', () => {
    it('respects consent state change between calls without server restart', async () => {
      // First call: no consent
      mockHasConsent.mockReturnValue(false);
      const handler = await buildAndGetHandler();
      const resultBefore = await handler({});
      expect(resultBefore.isError).toBe(true);

      // Simulate `clawdcursor consent --accept` — flip consent on
      mockHasConsent.mockReturnValue(true);

      // Second call on the SAME handler: now consent is present.
      // The call may succeed or produce a tool-level error, but must NOT return
      // the consent-gate error.
      const resultAfter = await handler({}).catch((): null => null);

      if (resultAfter !== null) {
        const text = resultAfter.content.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined;
        expect(text?.text).not.toContain('clawdcursor consent --accept');
      }
      // Rejection also means the tool ran (past the consent gate).
    });
  });

  // ── 4. cli.ts mcp command no longer exits on missing consent ────────────────
  describe('cli.ts — mcp command is non-fatal on missing consent', () => {
    it('does NOT contain process.exit(1) in the mcp consent branch', () => {
      const { readFileSync } = require('node:fs');
      const { join } = require('node:path');
      const cliSrc = readFileSync(
        join(__dirname, '..', 'surface', 'cli.ts'),
        'utf8',
      ) as string;

      // Locate the mcp consent block (the new non-fatal comment is the anchor).
      // The comment starts with "Consent gate — REQUIRED before any tool runs".
      const anchorPhrase = 'Consent gate — REQUIRED before any tool runs';
      const anchorIdx = cliSrc.indexOf(anchorPhrase);
      expect(anchorIdx).toBeGreaterThan(-1); // guard: block must exist

      // Slice ~800 chars from the anchor to cover the full consent block
      // (comment + the if-block that follows it).
      const section = cliSrc.slice(anchorIdx, anchorIdx + 800);

      // Must NOT exit the process on missing consent (old fatal behaviour removed).
      expect(section).not.toContain('process.exit(1)');

      // Must write a visible warning to stderr instead of silently dying.
      expect(section).toContain('process.stderr.write');
    });
  });

  // ── 3. CONSENT ASKED IN THE HOST'S OWN UI (MCP elicitation) ──────────────────
  // Plugin / Cursor / VS Code users installed clawdcursor and then had to open a
  // terminal to run `clawdcursor consent --accept`. When the host supports MCP
  // elicitation, the first tool call asks the USER directly (the model cannot
  // answer an elicitation) and carries on if they allow it.
  describe('consent via the host UI (elicitation)', () => {
    it('asks the user, records consent and runs the call when they allow it', async () => {
      mockHasConsent.mockReturnValue(false);
      mockClientCaps.mockReturnValue({ elicitation: {} });
      mockElicitInput.mockResolvedValue({ action: 'accept', content: { allow: true } });
      const { controlBanner } = await import('../core/banner');
      const { writeConsentFile } = await import('../surface/onboarding');
      const handler = await buildAndGetHandler();

      await handler({}).catch(() => null);

      expect(mockElicitInput).toHaveBeenCalledTimes(1);
      expect(vi.mocked(writeConsentFile)).toHaveBeenCalledWith('mcp-elicitation');
      expect(vi.mocked(controlBanner.hold)).toHaveBeenCalled();
    });

    it('a decline keeps the gate shut and is not re-asked on every call', async () => {
      mockHasConsent.mockReturnValue(false);
      mockClientCaps.mockReturnValue({ elicitation: {} });
      mockElicitInput.mockResolvedValue({ action: 'decline' });
      const { controlBanner } = await import('../core/banner');
      const handler = await buildAndGetHandler();

      const first = await handler({});
      const second = await handler({});

      expect(first.isError).toBe(true);
      expect(second.isError).toBe(true);
      expect(mockElicitInput).toHaveBeenCalledTimes(1);
      expect(vi.mocked(controlBanner.hold)).not.toHaveBeenCalled();
    });

    it('"accept" with the box unticked is not consent', async () => {
      mockHasConsent.mockReturnValue(false);
      mockClientCaps.mockReturnValue({ elicitation: {} });
      mockElicitInput.mockResolvedValue({ action: 'accept', content: { allow: false } });
      const { controlBanner } = await import('../core/banner');
      const handler = await buildAndGetHandler();

      expect((await handler({})).isError).toBe(true);
      expect(vi.mocked(controlBanner.hold)).not.toHaveBeenCalled();
    });

    it('a host without elicitation gets the terminal instructions, unasked', async () => {
      mockHasConsent.mockReturnValue(false);
      const handler = await buildAndGetHandler();

      const result = await handler({});

      expect(mockElicitInput).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });
  });

  // ── 5. Turning off error reports needs no consent ──────────────────────────
  it('system telemetry_optout works before consent (it touches nothing on screen)', async () => {
    mockHasConsent.mockReturnValue(false);
    await createMcpServer({ ctx: fakeCtx(), compact: true });

    const result = await capturedHandlers.get('system')!({ action: 'telemetry_optout' });

    expect(JSON.stringify(result.content)).not.toContain('consent --accept');
    expect(mockSetTelemetry).toHaveBeenCalledWith(false);
  });
});
