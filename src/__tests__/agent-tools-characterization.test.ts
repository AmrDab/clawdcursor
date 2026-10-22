/**
 * Characterization tests for System B (buildUnifiedTools / agent-loop tool catalog).
 *
 * These tests LOCK DOWN the observable behavior of the agent-loop tool catalog
 * so that the planned MCP re-projection refactor cannot silently regress the
 * hard-won reliability tweaks baked in here.
 *
 * Every assertion documents a CURRENT behavior. When a test fails after the
 * refactor, that is a regression, not a test to be deleted.
 *
 * Pinned behaviors:
 *  1. buildUnifiedTools() tool sets per mode (blind / hybrid / vision)
 *  2. coerceCoord: smushed "x,y" string splits + warns
 *  3. coordBreadcrumb: click result text contains the "(x,y) → screen (x,y)" pattern
 *  4. Conditional coord scaling: space:'image' scales; space:'screen' does not
 *  5. ensureTargetForeground no-ops when ctx.targetWindow is undefined
 *  6. resolveAgentPid fallback: a11y tool with no processId uses active-window pid
 *  7. type tool paste-fast-path: result text says "(paste)"
 *  8. done HEDGING_PATTERN: speculative evidence is rejected; concrete evidence accepted
 *  9. Terminal actions (done/give_up/cannot_read) carry stop:true + correct terminalExit
 */

import { describe, it, expect, vi } from 'vitest';

// ── Mock heavy native deps BEFORE any imports ────────────────────────────────

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class {
    constructor(
      public left: number, public top: number,
      public width: number, public height: number,
    ) {}
  },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  })),
}));

vi.mock('../platform/ocr-engine', () => ({
  OcrEngine: class {
    isAvailable() { return false; }
    async recognizeScreen() { return { elements: [], fullText: '', durationMs: 0 }; }
    invalidateCache() {}
  },
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import { buildUnifiedTools, coerceCoord } from '../core/agent-loop/tools';
import { imageScale, scaleCoord } from '../core/agent-loop/coord-scale';
import type { AgentToolContext } from '../core/agent-loop/types';
import { makeMockPlatform } from './helpers/mock-platform';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal AgentToolContext mock. Every PlatformAdapter method
 * that a tool might call is mocked so there is zero real I/O.
 * The `platform` field is built by the shared makeMockPlatform() helper.
 */
function makeCtx(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    platform: makeMockPlatform(),
    task: 'test task',
    mode: 'blind',
    // Pin a non-darwin platform so these GENERIC physical-scaling tests are
    // deterministic on every CI runner. imageScale() uses LOGICAL width on
    // darwin (#154) → scale 1.5 here, which broke these tests only on macOS.
    // The darwin/logical path is covered separately in coord-scale.test.ts.
    _platform: 'linux',
    screen: {
      logicalWidth: 1920,
      logicalHeight: 1080,
      physicalWidth: 2560,
      physicalHeight: 1440,
      dpiRatio: 2,
    },
    screenshotsCaptured: { n: 0 },
    cdp: null,
    ...overrides,
  };
}

function findTool(tools: ReturnType<typeof buildUnifiedTools>, name: string) {
  const t = tools.find(x => x.name === name);
  if (!t) throw new Error(`tool "${name}" not found in catalog`);
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Tool set composition (flat catalog — mode-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

describe('1. buildUnifiedTools() — flat catalog composition', () => {

  it('includes screenshot (available for on-demand vision)', () => {
    const tools = buildUnifiedTools();
    expect(tools.map(t => t.name)).toContain('screenshot');
  });

  it('excludes cannot_read (no blind→vision escalation path in hybrid loop)', () => {
    const tools = buildUnifiedTools();
    expect(tools.map(t => t.name)).not.toContain('cannot_read');
  });

  it('includes granular click tool', () => {
    const tools = buildUnifiedTools();
    expect(tools.map(t => t.name)).toContain('click');
  });

  it('does NOT include compound mouse/keyboard/window tools (vision-only — not used in thin loop)', () => {
    const tools = buildUnifiedTools();
    const names = tools.map(t => t.name);
    expect(names).not.toContain('mouse');
    expect(names).not.toContain('keyboard');
  });

  it('always has terminal tools (done, give_up)', () => {
    const tools = buildUnifiedTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('done');
    expect(names).toContain('give_up');
  });

  it('inputSchema.required on click is ["x","y"]', () => {
    const tools = buildUnifiedTools();
    const click = findTool(tools, 'click');
    expect(click.inputSchema.required).toContain('x');
    expect(click.inputSchema.required).toContain('y');
  });

  it('inputSchema.required on done is ["evidence"]', () => {
    const tools = buildUnifiedTools();
    const done = findTool(tools, 'done');
    expect(done.inputSchema.required).toEqual(['evidence']);
  });

  it('includes perception tools (read_screen, read_text, smart_click)', () => {
    const tools = buildUnifiedTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('read_screen');
    expect(names).toContain('read_text');
    expect(names).toContain('smart_click');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. coerceCoord — smushed coordinate splitting
// ─────────────────────────────────────────────────────────────────────────────

describe('2. coerceCoord — smushed coordinate handling', () => {

  it('splits "390, 79" (with space) into x=390, y=79 and warns', () => {
    const result = coerceCoord('390, 79', undefined);
    expect(result.x).toBe(390);
    expect(result.y).toBe(79);
    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/split/i);
    expect(result.warning).toMatch(/separate/i);
  });

  it('splits "390,79" (no space) into x=390, y=79 and warns', () => {
    const result = coerceCoord('390,79', undefined);
    expect(result.x).toBe(390);
    expect(result.y).toBe(79);
    expect(result.warning).toBeDefined();
  });

  it('splits "(390, 79)" (with parens) into x=390, y=79 and warns', () => {
    const result = coerceCoord('(390, 79)', undefined);
    expect(result.x).toBe(390);
    expect(result.y).toBe(79);
    expect(result.warning).toBeDefined();
  });

  it('numeric x,y pass through unchanged without a warning', () => {
    const result = coerceCoord(390, 79);
    expect(result.x).toBe(390);
    expect(result.y).toBe(79);
    expect(result.warning).toBeUndefined();
  });

  it('NaN x with numeric y produces NaN x (no crash)', () => {
    const result = coerceCoord('not-a-number', 79);
    expect(Number.isNaN(result.x)).toBe(true);
    expect(result.y).toBe(79);
  });

  it('smushed click: click tool reads the warning and appends it to result.text', async () => {
    const ctx = makeCtx();
    const tools = buildUnifiedTools();
    const clickTool = findTool(tools, 'click');
    // Pass smushed coordinate: x="390, 79", y not meaningful (will be overridden by split)
    const result = await clickTool.execute({ x: '390, 79' as any, y: 0 }, ctx);
    expect(result.success).toBe(true);
    // The warning substring must appear in the result text
    expect(result.text).toMatch(/coord parser/i);
    expect(result.text).toMatch(/390/);
    expect(result.text).toMatch(/79/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. coordBreadcrumb — click result text shape
// ─────────────────────────────────────────────────────────────────────────────

describe('3. coordBreadcrumb — click result contains image→screen breadcrumb', () => {

  it('screen-space click: result text contains the "(x,y)" and screen dimensions', async () => {
    const ctx = makeCtx();
    const tools = buildUnifiedTools();
    const clickTool = findTool(tools, 'click');
    const result = await clickTool.execute({ x: 100, y: 200 }, ctx);
    expect(result.success).toBe(true);
    // Should contain the coords
    expect(result.text).toContain('100');
    expect(result.text).toContain('200');
    // Should mention the physical screen dimensions (2560x1440 from our mock)
    expect(result.text).toContain('2560');
    expect(result.text).toContain('1440');
  });

  it('image-space click: result text contains "image (x,y) → screen (sx,sy)" with scale', async () => {
    // physicalWidth=2560, LLM_TARGET_WIDTH=1280 → imageScale=2
    const ctx = makeCtx();
    const tools = buildUnifiedTools();
    const clickTool = findTool(tools, 'click');
    const result = await clickTool.execute({ x: 100, y: 200, space: 'image' }, ctx);
    expect(result.success).toBe(true);
    // Breadcrumb must show original image coords AND the scaled screen coords
    expect(result.text).toContain('100');
    expect(result.text).toContain('200');
    // The scaled values at 2× should appear: 100*2=200, 200*2=400
    expect(result.text).toContain('200');
    expect(result.text).toContain('400');
    // Must show the arrow breadcrumb
    expect(result.text).toContain('→ screen');
  });

  it('screen-space click: no "→ screen" breadcrumb (scale is 1, no transformation needed)', async () => {
    const ctx = makeCtx();
    const tools = buildUnifiedTools();
    const clickTool = findTool(tools, 'click');
    // Screen space with scale=1: no transformation arrow should appear
    const result = await clickTool.execute({ x: 100, y: 200, space: 'screen' }, ctx);
    expect(result.success).toBe(true);
    // The coordBreadcrumb only adds "→ screen (sx,sy)" when scale !== 1
    expect(result.text).not.toContain('→ screen');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Conditional coordinate scaling
// ─────────────────────────────────────────────────────────────────────────────

describe('4. Conditional coordinate scaling', () => {

  it('imageScale: physicalWidth=2560, LLM_TARGET_WIDTH=1280 → scale=2', () => {
    const ctx = makeCtx(); // physicalWidth=2560
    expect(imageScale(ctx)).toBe(2);
  });

  it('imageScale: physicalWidth=1280 → scale=1 (no downscale)', () => {
    const ctx = makeCtx({ screen: { logicalWidth: 1280, logicalHeight: 720, physicalWidth: 1280, physicalHeight: 720, dpiRatio: 1 } });
    expect(imageScale(ctx)).toBe(1);
  });

  it('imageScale: physicalWidth=0 (missing) → scale=1', () => {
    expect(imageScale({ screen: { physicalWidth: 0 } } as any)).toBe(1);
  });

  it('scaleCoord rounds correctly', () => {
    expect(scaleCoord(100, 2)).toBe(200);
    expect(scaleCoord(101, 2)).toBe(202);
    expect(scaleCoord(100.6, 2)).toBe(201); // Math.round(201.2) = 201
  });

  it('space:"image" click: platform receives SCALED coords', async () => {
    const ctx = makeCtx(); // physicalWidth=2560, scale=2
    const tools = buildUnifiedTools();
    const clickTool = findTool(tools, 'click');
    await clickTool.execute({ x: 100, y: 200, space: 'image' }, ctx);
    // mouseClick should be called with scaled coords: x=200, y=400
    expect(ctx.platform.mouseClick).toHaveBeenCalledWith(200, 400, expect.any(Object));
  });

  it('space:"screen" click: platform receives ORIGINAL coords (no scaling)', async () => {
    const ctx = makeCtx(); // physicalWidth=2560, scale would be 2 if image
    const tools = buildUnifiedTools();
    const clickTool = findTool(tools, 'click');
    await clickTool.execute({ x: 100, y: 200, space: 'screen' }, ctx);
    // mouseClick should be called with unscaled coords: x=100, y=200
    expect(ctx.platform.mouseClick).toHaveBeenCalledWith(100, 200, expect.any(Object));
  });

  it('default (no space arg) behaves as screen-space', async () => {
    const ctx = makeCtx();
    const tools = buildUnifiedTools();
    const clickTool = findTool(tools, 'click');
    await clickTool.execute({ x: 100, y: 200 }, ctx);
    // No space arg → defaults to 'screen' → unscaled
    expect(ctx.platform.mouseClick).toHaveBeenCalledWith(100, 200, expect.any(Object));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ensureTargetForeground no-ops when ctx.targetWindow is undefined
// ─────────────────────────────────────────────────────────────────────────────

describe('5. ensureTargetForeground — no-op without targetWindow', () => {

  it('click succeeds when ctx.targetWindow is undefined (no focus-guard call)', async () => {
    const ctx = makeCtx({ targetWindow: undefined });
    const tools = buildUnifiedTools();
    const clickTool = findTool(tools, 'click');
    const result = await clickTool.execute({ x: 100, y: 200 }, ctx);
    expect(result.success).toBe(true);
    // focusWindow should NOT have been called by the guard
    expect(ctx.platform.focusWindow).not.toHaveBeenCalled();
  });

  it('click result text does NOT contain "·raised" when no target window set', async () => {
    const ctx = makeCtx({ targetWindow: undefined });
    const tools = buildUnifiedTools();
    const clickTool = findTool(tools, 'click');
    const result = await clickTool.execute({ x: 100, y: 200 }, ctx);
    expect(result.text).not.toContain('raised');
  });

  it('click with targetWindow set but same foreground process: no raise', async () => {
    const ctx = makeCtx({
      targetWindow: { title: 'TestApp', processName: 'test.exe' },
    });
    // getActiveWindow returns processName: 'test.exe' (same as targetWindow)
    (ctx.platform.getActiveWindow as any).mockResolvedValue({
      title: 'TestApp',
      processName: 'test.exe',
      processId: 42,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    const tools = buildUnifiedTools();
    const clickTool = findTool(tools, 'click');
    const result = await clickTool.execute({ x: 100, y: 200 }, ctx);
    expect(result.success).toBe(true);
    // No raise needed — processes match; focusWindow should not be called for focus-guard
    // (getActiveWindow is called, but focusWindow specifically for the guard should not be)
    expect(ctx.platform.focusWindow).not.toHaveBeenCalled();
  });

  it('click with targetWindow set and DIFFERENT foreground: guard raises the target', async () => {
    const ctx = makeCtx({
      targetWindow: { title: 'TargetApp', processName: 'target.exe' },
    });
    // foreground is a DIFFERENT process
    (ctx.platform.getActiveWindow as any).mockResolvedValue({
      title: 'OtherApp',
      processName: 'other.exe',
      processId: 99,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    });
    const tools = buildUnifiedTools();
    const clickTool = findTool(tools, 'click');
    const result = await clickTool.execute({ x: 100, y: 200 }, ctx);
    expect(result.success).toBe(true);
    // The guard should have called focusWindow to raise the target
    expect(ctx.platform.focusWindow).toHaveBeenCalledWith({ processName: 'target.exe' });
    expect(result.text).toContain('raised');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. resolveAgentPid fallback — a11y tool without processId uses active pid
// ─────────────────────────────────────────────────────────────────────────────

describe('6. resolveAgentPid — active-window pid fallback', () => {

  it('invoke_element with no processId calls getActiveWindow for pid resolution', async () => {
    const ctx = makeCtx();
    // Active window returns pid=42
    (ctx.platform.getActiveWindow as any).mockResolvedValue({
      title: 'TestApp', processName: 'test.exe', processId: 42,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    const tools = buildUnifiedTools();
    // Note: invoke_element does NOT call resolveAgentPid (uses processId from args directly)
    // But a11y_expand DOES use resolveAgentPid
    const expandTool = findTool(tools, 'a11y_expand');
    const result = await expandTool.execute({ name: 'File Menu' }, ctx);
    // Should not throw / hang
    expect(result).toBeDefined();
    // getActiveWindow should have been called (for pid fallback)
    expect(ctx.platform.getActiveWindow).toHaveBeenCalled();
    // invokeElement should have been called with the resolved pid (42)
    expect(ctx.platform.invokeElement).toHaveBeenCalledWith(
      expect.objectContaining({ processId: 42 }),
    );
  });

  it('a11y_expand: getActiveWindow throws → tool still returns a result (no hang)', async () => {
    const ctx = makeCtx();
    (ctx.platform.getActiveWindow as any).mockRejectedValue(new Error('platform error'));
    const tools = buildUnifiedTools();
    const expandTool = findTool(tools, 'a11y_expand');
    // Should not throw
    const result = await expandTool.execute({ name: 'SomeMenu' }, ctx);
    expect(result).toBeDefined();
    expect(result.success).toBeDefined();
    // processId should be undefined when fallback fails
    expect(ctx.platform.invokeElement).toHaveBeenCalledWith(
      expect.objectContaining({ processId: undefined }),
    );
  });

  it('a11y_toggle: explicit processId overrides active-window fallback', async () => {
    const ctx = makeCtx();
    const tools = buildUnifiedTools();
    const toggleTool = findTool(tools, 'a11y_toggle');
    await toggleTool.execute({ name: 'DarkMode', processId: 77 }, ctx);
    expect(ctx.platform.invokeElement).toHaveBeenCalledWith(
      expect.objectContaining({ processId: 77 }),
    );
    // getActiveWindow should NOT have been called for pid resolution
    // (it IS called by ensureTargetForeground in click tools, but toggle doesn't click)
    // For a11y tools that use resolveAgentPid, explicit pid skips the getActiveWindow call
    // Note: getActiveWindow may still be called by other paths; we just verify the pid is correct
    const lastCall = (ctx.platform.invokeElement as any).mock.calls.at(-1)?.[0];
    expect(lastCall?.processId).toBe(77);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. type tool — paste fast-path
// ─────────────────────────────────────────────────────────────────────────────

describe('7. type tool — keys for short text, verified paste for long text, read back', () => {
  // Over TYPE_KEYS_MAX: keystrokes would take too long, so this is pasted.
  const LONG = 'Lorem ipsum dolor sit amet, '.repeat(6);

  it('short text is typed as keystrokes: the clipboard is never touched', async () => {
    const ctx = makeCtx();
    const typeTool = findTool(buildUnifiedTools(), 'type');
    const result = await typeTool.execute({ text: 'Hello World' }, ctx);
    expect(result.success).toBe(true);
    expect(result.text).toContain('(keys)');
    expect(ctx.platform.typeText).toHaveBeenCalledWith('Hello World');
    expect(ctx.platform.writeClipboard).not.toHaveBeenCalled();
    expect(ctx.platform.readClipboard).not.toHaveBeenCalled();
  });

  it('a trailing newline types the rest, then presses Return', async () => {
    const ctx = makeCtx();
    const typeTool = findTool(buildUnifiedTools(), 'type');
    await typeTool.execute({ text: 'dashboard.stripe.com/webhooks\n' }, ctx);
    expect(ctx.platform.typeText).toHaveBeenCalledWith('dashboard.stripe.com/webhooks');
    expect((ctx.platform.keyPress as any).mock.calls.map((c: unknown[]) => c[0])).toEqual(['Return']);
  });

  it('long text is pasted: clipboard write + mod+v, not typeText', async () => {
    const ctx = makeCtx();
    const typeTool = findTool(buildUnifiedTools(), 'type');
    const result = await typeTool.execute({ text: LONG }, ctx);
    expect(result.text).toContain('(paste)');
    expect(ctx.platform.writeClipboard).toHaveBeenCalledWith(LONG);
    expect(ctx.platform.keyPress).toHaveBeenCalledWith('mod+v');
    expect(ctx.platform.typeText).not.toHaveBeenCalled();
  });

  it('long text: the prior clipboard is put back', async () => {
    const ctx = makeCtx();
    await ctx.platform.writeClipboard('my-prior-content');
    (ctx.platform.writeClipboard as any).mockClear();
    await findTool(buildUnifiedTools(), 'type').execute({ text: LONG }, ctx);
    const writeCalls = (ctx.platform.writeClipboard as any).mock.calls;
    expect(writeCalls[0][0]).toBe(LONG);
    expect(writeCalls[1][0]).toBe('my-prior-content');
  });

  it('type tool: empty text returns success without any I/O', async () => {
    const ctx = makeCtx();
    const result = await findTool(buildUnifiedTools(), 'type').execute({ text: '' }, ctx);
    expect(result.success).toBe(true);
    expect(result.text).toContain('0 chars');
    expect(ctx.platform.writeClipboard).not.toHaveBeenCalled();
    expect(ctx.platform.keyPress).not.toHaveBeenCalled();
  });

  it("long text, a clipboard write that silently does nothing: never pasted (the user's clipboard would go in) — typed instead", async () => {
    const ctx = makeCtx();
    await ctx.platform.writeClipboard("the user's own clipboard");
    (ctx.platform.writeClipboard as any).mockImplementation(async () => { /* Set-Clipboard timed out — nothing written */ });
    const result = await findTool(buildUnifiedTools(), 'type').execute({ text: LONG + '\n' }, ctx);
    const keys = (ctx.platform.keyPress as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(keys).not.toContain('mod+v');
    expect(keys).toEqual(['Return']);
    expect(ctx.platform.typeText).toHaveBeenCalledWith(LONG);
    expect(result.text).toContain('(keys)');
  });

  it('long text: falls back to typeText when the clipboard write throws', async () => {
    const ctx = makeCtx();
    (ctx.platform.writeClipboard as any).mockRejectedValue(new Error('clipboard denied'));
    const result = await findTool(buildUnifiedTools(), 'type').execute({ text: LONG }, ctx);
    expect(result.success).toBe(true);
    expect(ctx.platform.typeText).toHaveBeenCalledWith(LONG);
    expect(result.text).toContain('(keys)');
  });

  it('read back: the field shows the text → "read back ✓"', async () => {
    const ctx = makeCtx();
    (ctx.platform as any).getFocusedElement = vi.fn(async () => ({ name: 'Search', controlType: 'Edit', value: 'prefix Hello World', bounds: { x: 0, y: 0, width: 1, height: 1 } }));
    const result = await findTool(buildUnifiedTools(), 'type').execute({ text: 'Hello World' }, ctx);
    expect(result.text.startsWith('Typed 11 chars (keys, read back ✓): "Hello World"')).toBe(true);
  });

  it('read back: autocomplete swapped the text → Return is NOT pressed (live: an address bar)', async () => {
    const ctx = makeCtx();
    (ctx.platform as any).getFocusedElement = vi.fn(async () => ({ name: 'Address and search bar', controlType: 'Edit', value: 'https://glama.ai/mcp/servers/x', bounds: { x: 0, y: 0, width: 1, height: 1 } }));
    const result = await findTool(buildUnifiedTools(), 'type').execute({ text: 'https://github.com/login/device\n' }, ctx);
    expect(result.success).toBe(false);
    expect(result.text).toMatch(/field shows different text.*Return not pressed/);
    expect(ctx.platform.keyPress).not.toHaveBeenCalledWith('Return');
    // what the field shows is reported — as untrusted screen content — so the caller can decide
    expect(result.text).toMatch(/It shows: <untrusted-screen-content>[\s\S]*glama/);
  });

  it('read back: a password field (value withheld) or an empty value is "unknown" — Return still pressed', async () => {
    for (const el of [{ secure: true, value: '' }, { value: '' }, null]) {
      const ctx = makeCtx();
      (ctx.platform as any).getFocusedElement = vi.fn(async () => el);
      const result = await findTool(buildUnifiedTools(), 'type').execute({ text: 'hunter2\n' }, ctx);
      expect(result.success).toBe(true);
      expect(ctx.platform.keyPress).toHaveBeenCalledWith('Return');
      expect(result.text).not.toMatch(/read back/);
    }
  });

  it('read back before a submit: an inline autocomplete suffix after the typed text blocks Return', async () => {
    const ctx = makeCtx();
    (ctx.platform as any).getFocusedElement = vi.fn(async () => ({ name: 'Address', controlType: 'Edit', value: 'github.com/login/device/extra-suggestion', bounds: { x: 0, y: 0, width: 1, height: 1 } }));
    const result = await findTool(buildUnifiedTools(), 'type').execute({ text: 'github.com/login/device\n' }, ctx);
    expect(result.success).toBe(false);
    expect(ctx.platform.keyPress).not.toHaveBeenCalledWith('Return');
  });

  it('read back without a submit: the text anywhere in the field is a match (existing content is fine)', async () => {
    const ctx = makeCtx();
    (ctx.platform as any).getFocusedElement = vi.fn(async () => ({ name: 'Doc', controlType: 'Document', value: 'before Hello World after', bounds: { x: 0, y: 0, width: 1, height: 1 } }));
    const result = await findTool(buildUnifiedTools(), 'type').execute({ text: 'Hello World' }, ctx);
    expect(result.text).toMatch(/^Typed 11 chars \(keys, read back ✓\)/);
  });

  it('where typing is not private (the text would be visible to other processes) short text is pasted instead', async () => {
    const ctx = makeCtx();
    (ctx.platform as any).typingIsPrivate = () => false;
    const result = await findTool(buildUnifiedTools(), 'type').execute({ text: 'hunter2' }, ctx);
    expect(result.text).toContain('(paste');
    expect(ctx.platform.typeText).not.toHaveBeenCalled();
  });

  it('non-ASCII, newlines and tabs are pasted as literal text, even short (keys would press Return/Tab; some OSes refuse non-ASCII keys)', async () => {
    for (const text of ['café 日本語', 'line1\nline2', 'a\tb', '😀']) {
      const ctx = makeCtx();
      const result = await findTool(buildUnifiedTools(), 'type').execute({ text }, ctx);
      expect(result.text).toContain('(paste');
      expect(ctx.platform.typeText).not.toHaveBeenCalled();
      expect(ctx.platform.writeClipboard).toHaveBeenCalledWith(text);
    }
  });

  it('where typing is not private, a failed paste stops — it never falls back to typing the text', async () => {
    const ctx = makeCtx();
    (ctx.platform as any).typingIsPrivate = () => false;
    (ctx.platform.writeClipboard as any).mockRejectedValue(new Error('wl-copy missing'));
    await expect(findTool(buildUnifiedTools(), 'type').execute({ text: 'hunter2' }, ctx)).rejects.toThrow();
    expect(ctx.platform.typeText).not.toHaveBeenCalled();
  });

  it('a reformatting field before a submit: Return not pressed, and the result says what the field shows', async () => {
    const ctx = makeCtx();
    (ctx.platform as any).getFocusedElement = vi.fn(async () => ({ name: 'Phone', controlType: 'Edit', value: '(555) 123-4567', bounds: { x: 0, y: 0, width: 1, height: 1 } }));
    const result = await findTool(buildUnifiedTools(), 'type').execute({ text: '5551234567\n' }, ctx);
    expect(result.success).toBe(false);
    expect(result.text).toMatch(/if it is right, press Return/);
    expect(result.text).toMatch(/\(555\) 123-4567/);
  });

  it('a refused keystroke (a system dialog owns the keyboard) throws: nothing typed, and the clipboard untouched', async () => {
    const ctx = makeCtx();
    (ctx.platform.typeText as any).mockRejectedValue(new Error('A system dialog owns the keyboard: "X"'));
    await expect(findTool(buildUnifiedTools(), 'type').execute({ text: 'secret' }, ctx)).rejects.toThrow(/system dialog/);
    expect(ctx.platform.writeClipboard).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. done tool — HEDGING_PATTERN enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('8. done — HEDGING_PATTERN enforcement', () => {

  async function callDone(evidence: string) {
    const tools = buildUnifiedTools();
    const doneTool = findTool(tools, 'done');
    return doneTool.execute({ evidence }, makeCtx());
  }

  // Hedging phrases that must be rejected
  const hedgingCases: [string, string][] = [
    ['should have been sent', 'the email should have been sent'],
    ['should be', 'the file should be saved'],
    ['I think', 'I think the task is complete'],
    ['I believe', 'I believe it worked correctly'],
    ['might have', 'the dialog might have closed'],
    ['probably', 'it probably submitted successfully'],
    ['appears to', 'the app appears to be open'],
    ['seems to', 'the form seems to be filled'],
    ['I assume', 'I assume the export was done'],
    ['assuming', 'assuming the button was clicked'],
    ['may have', 'the email may have been sent'],
    ['could have', 'it could have been deleted'],
  ];

  for (const [phrase, evidence] of hedgingCases) {
    it(`rejects evidence containing "${phrase}"`, async () => {
      const result = await callDone(evidence);
      expect(result.success).toBe(false);
      expect(result.text).toMatch(/hedging/i);
      expect(result.stop).toBeUndefined();
      expect(result.terminalExit).toBeUndefined();
    });
  }

  // Concrete evidence that must be accepted
  const concreteOkCases: [string, string][] = [
    ['window title', 'Notepad window title shows "Untitled — Notepad" confirming it opened'],
    ['visible text', 'The status bar reads "File saved" at 14:32:01'],
    ['focused element', 'The "Send" button is focused and the recipient field shows "bob@example.com"'],
    ['looks present', 'The document looks complete with 3 pages showing in the preview pane'],
    ['shown on screen', 'The confirmation dialog shown on screen reads "Upload complete"'],
    ['displayed in UI', 'The email is displayed in the Sent folder'],
    ['confirmed in UI', 'The file "report.pdf" now appears in the Downloads folder'],
  ];

  for (const [label, evidence] of concreteOkCases) {
    it(`accepts concrete evidence: ${label}`, async () => {
      const result = await callDone(evidence);
      expect(result.success).toBe(true);
      expect(result.stop).toBe(true);
      expect(result.terminalExit).toBe('done');
      expect(result.text).toContain('done:');
    });
  }

  it('rejects evidence shorter than 8 characters', async () => {
    const result = await callDone('ok');
    expect(result.success).toBe(false);
    expect(result.text).toMatch(/too short|empty/i);
  });

  it('rejects empty evidence', async () => {
    const result = await callDone('');
    expect(result.success).toBe(false);
  });

  it('concrete done works (HEDGING_PATTERN is mode-agnostic)', async () => {
    const result = await callDone('The YouTube video "Never Gonna Give You Up" is playing at 0:10');
    expect(result.success).toBe(true);
    expect(result.stop).toBe(true);
    expect(result.terminalExit).toBe('done');
  });

  it('hedging done is rejected regardless of scenario', async () => {
    const result = await callDone('the video should be playing');
    expect(result.success).toBe(false);
    expect(result.stop).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Terminal actions — stop:true and correct terminalExit
// ─────────────────────────────────────────────────────────────────────────────

describe('9. Terminal actions — stop and terminalExit', () => {

  it('done (concrete): stop=true, terminalExit="done", success=true', async () => {
    const tools = buildUnifiedTools();
    const doneTool = findTool(tools, 'done');
    const result = await doneTool.execute({ evidence: 'The "File saved" toast is visible in the bottom-right corner.' }, makeCtx());
    expect(result.stop).toBe(true);
    expect(result.terminalExit).toBe('done');
    expect(result.success).toBe(true);
  });

  it('done (hedging): stop is absent (undefined), no terminalExit', async () => {
    const tools = buildUnifiedTools();
    const doneTool = findTool(tools, 'done');
    const result = await doneTool.execute({ evidence: 'the email should have been sent' }, makeCtx());
    expect(result.stop).toBeUndefined();
    expect(result.terminalExit).toBeUndefined();
    expect(result.success).toBe(false);
  });

  it('give_up: stop=true, terminalExit="give_up", success=false', async () => {
    const tools = buildUnifiedTools();
    const giveUpTool = findTool(tools, 'give_up');
    const result = await giveUpTool.execute({ reason: 'captcha requires human' }, makeCtx());
    expect(result.stop).toBe(true);
    expect(result.terminalExit).toBe('give_up');
    expect(result.success).toBe(false);
    expect(result.text).toContain('give_up');
    expect(result.text).toContain('captcha');
  });

  it('cannot_read is absent from the flat catalog (no escalation path)', () => {
    const tools = buildUnifiedTools();
    expect(tools.find(t => t.name === 'cannot_read')).toBeUndefined();
  });

  it('both terminals (done, give_up) have terminal:true flag', () => {
    const tools = buildUnifiedTools();
    expect(findTool(tools, 'done').terminal).toBe(true);
    expect(findTool(tools, 'give_up').terminal).toBe(true);
  });

  it('non-terminal tools do NOT have terminal:true', () => {
    const tools = buildUnifiedTools();
    const click = findTool(tools, 'click');
    expect(click.terminal).not.toBe(true);
    const type = findTool(tools, 'type');
    expect(type.terminal).not.toBe(true);
  });

  it('give_up: result text includes the reason', async () => {
    const tools = buildUnifiedTools();
    const giveUpTool = findTool(tools, 'give_up');
    const result = await giveUpTool.execute({ reason: 'credentials missing' }, makeCtx());
    expect(result.text).toContain('credentials missing');
  });
});
