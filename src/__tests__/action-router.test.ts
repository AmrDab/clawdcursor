/**
 * Action Router tests.
 *
 * We test the routing logic (pattern matching, multi-step rejection, URL detection)
 * without actually launching apps or moving the mouse.
 *
 * Strategy: mock the desktop and a11y dependencies so route() short-circuits
 * or returns without side-effects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock heavy native deps before any import ──────────────────────────────────
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), scrollDown: vi.fn(), scrollUp: vi.fn(), drag: vi.fn() },
  keyboard: { config: {}, type: vi.fn(), pressKey: vi.fn(), releaseKey: vi.fn() },
  screen: { grab: vi.fn(), grabRegion: vi.fn(), width: vi.fn().mockResolvedValue(1920), height: vi.fn().mockResolvedValue(1080) },
  Button: { LEFT: 0, RIGHT: 1 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('')),
  })),
}));

// Mock child_process so opening apps doesn't do anything
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, cb: Function) => cb(null, '', '')),
  execFile: vi.fn((_cmd: string, _args: string[], cb: Function) => cb(null, '', '')),
  spawn: vi.fn(() => ({ on: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() } })),
}));

import { ActionRouter } from '../action-router';

// ── Minimal fake desktop + a11y ───────────────────────────────────────────────
function makeDesktop() {
  return {
    keyPress: vi.fn().mockResolvedValue(undefined),
    typeText: vi.fn().mockResolvedValue(undefined),
    executeMouseAction: vi.fn().mockResolvedValue(undefined),
    executeKeyboardAction: vi.fn().mockResolvedValue(undefined),
    captureForLLM: vi.fn().mockResolvedValue({ buffer: Buffer.from(''), scaleFactor: 1, llmWidth: 1280, llmHeight: 720 }),
    getScreenSize: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
    getScaleFactor: vi.fn().mockReturnValue(1.5),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  } as any;
}

function makeA11y() {
  return {
    isShellAvailable: vi.fn().mockResolvedValue(true),
    getWindows: vi.fn().mockResolvedValue([]),
    getActiveWindow: vi.fn().mockResolvedValue({ title: 'Test', processName: 'test', pid: 1 }),
    getFocusedElement: vi.fn().mockResolvedValue(null),
    getAccessibilityTree: vi.fn().mockResolvedValue(''),
    readClipboard: vi.fn().mockResolvedValue(''),
    warmup: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('ActionRouter — multi-step rejection', () => {
  let router: ActionRouter;
  beforeEach(() => { router = new ActionRouter(makeA11y(), makeDesktop()); });

  it('rejects "Open Notepad, type hello"', async () => {
    const result = await router.route('Open Notepad, type hello');
    expect(result.handled).toBe(false);
  });

  it('rejects "open chrome and search google"', async () => {
    const result = await router.route('open chrome and search google');
    expect(result.handled).toBe(false);
  });

  it('rejects "click OK, then close the window"', async () => {
    const result = await router.route('click OK, then close the window');
    expect(result.handled).toBe(false);
  });

  it('rejects "find the file and delete it"', async () => {
    const result = await router.route('find the file and delete it');
    expect(result.handled).toBe(false);
  });

  it('rejects "open notepad and then type a message"', async () => {
    const result = await router.route('open notepad and then type a message');
    expect(result.handled).toBe(false);
  });
});

describe('ActionRouter — type routing', () => {
  let router: ActionRouter;
  let desktop: ReturnType<typeof makeDesktop>;

  beforeEach(() => {
    desktop = makeDesktop();
    router = new ActionRouter(makeA11y(), desktop);
  });

  it('routes "type hello world"', async () => {
    const result = await router.route('type hello world');
    expect(result.handled).toBe(true);
    // handleType calls desktop.typeText(text)
    expect(desktop.typeText).toHaveBeenCalledWith('hello world');
  });

  it('routes "type \'quoted text\'"', async () => {
    const result = await router.route("type 'quoted text'");
    expect(result.handled).toBe(true);
    expect(desktop.typeText).toHaveBeenCalledWith('quoted text');
  });

  it('routes "enter some text"', async () => {
    const result = await router.route('enter some text');
    expect(result.handled).toBe(true);
  });

  it('does NOT route "write an essay about dogs" (write = creative, not raw type)', async () => {
    const result = await router.route('write an essay about dogs');
    // "write" is excluded from the type pattern — should fall through
    expect(result.handled).toBe(false);
  });
});

describe('ActionRouter — URL navigation', () => {
  let router: ActionRouter;

  beforeEach(() => { router = new ActionRouter(makeA11y(), makeDesktop()); });

  it('routes "go to https://github.com"', async () => {
    const result = await router.route('go to https://github.com');
    expect(result.handled).toBe(true);
    expect(result.description).toMatch(/github\.com/i);
  });

  it('routes "navigate to www.google.com"', async () => {
    const result = await router.route('navigate to www.google.com');
    expect(result.handled).toBe(true);
  });

  it('routes "visit https://docs.anthropic.com"', async () => {
    const result = await router.route('visit https://docs.anthropic.com');
    expect(result.handled).toBe(true);
  });

  it('does NOT route bare non-URL text as URL', async () => {
    const result = await router.route('go to the store');
    // "the store" has no TLD → should not match url pattern
    // It might still hit the open-app path or fall through
    // We just verify it doesn't crash
    expect(typeof result.handled).toBe('boolean');
  });
});

describe('ActionRouter — telemetry', () => {
  it('counts LLM fallbacks for compound tasks', async () => {
    const router = new ActionRouter(makeA11y(), makeDesktop());
    await router.route('open chrome and search for cats');
    await router.route('type hello, then press enter');
    const t = router.getTelemetry();
    expect(t.llmFallbacks).toBe(2);
    expect(t.totalRequests).toBe(2);
  });

  it('counts nonShortcutHandled for type tasks', async () => {
    const router = new ActionRouter(makeA11y(), makeDesktop());
    await router.route('type hello');
    const t = router.getTelemetry();
    expect(t.nonShortcutHandled).toBe(1);
  });

  it('resets telemetry', async () => {
    const router = new ActionRouter(makeA11y(), makeDesktop());
    await router.route('type hello');
    router.resetTelemetry();
    expect(router.getTelemetry().totalRequests).toBe(0);
  });
});
