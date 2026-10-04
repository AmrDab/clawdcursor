/**
 * `expect` must be validated BEFORE the action runs, on every execution path,
 * and the JSON-encoded-array string form the compound MCP schema advertises
 * must be accepted.
 *
 * Live regression (Windows + Linux, 2026-10): `accessibility invoke ... expect:
 * "window_title_contains:Identity"` CLICKED the element and only then returned
 * isError "expect rejected: assertions must be an array (got string)". A
 * retrying agent double-acts. Same with `computer key combo:"Escape"
 * expect:"[{\"type\":\"app_running\",...}]"` — a JSON-encoded array that every
 * other array param on the compound surface accepts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public l: number, public t: number, public w: number, public h: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('../platform/ocr-engine', () => ({
  OcrEngine: class {
    isAvailable() { return false; }
    async recognizeScreen() { return { elements: [], fullText: '', durationMs: 0 }; }
    invalidateCache() {}
  },
}));

import { parseAssertions, validateExpect } from '../core/verify/assertions';
import { projectToToolDefinition } from '../core/agent-loop/project-mcp';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { ToolContext } from '../tools/types';
import type { AgentToolContext } from '../core/agent-loop/types';

const NOTEPAD = { processId: 9, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false };

function makePlatform() {
  return {
    platform: 'win32' as const,
    getActiveWindow: vi.fn().mockResolvedValue(NOTEPAD),
    listWindows: vi.fn().mockResolvedValue([NOTEPAD]),
    focusWindow: vi.fn().mockResolvedValue(true),
    getUiTree: vi.fn().mockResolvedValue([]),
    findElements: vi.fn().mockResolvedValue([]),
    invokeElement: vi.fn().mockResolvedValue({ success: true }),
    getFocusedElement: vi.fn().mockResolvedValue(null),
    mouseClick: vi.fn().mockResolvedValue(undefined),
    keyPress: vi.fn().mockResolvedValue(undefined),
    typeText: vi.fn().mockResolvedValue(undefined),
    readClipboard: vi.fn().mockResolvedValue(''),
    getScreenSize: vi.fn().mockResolvedValue({ logicalWidth: 1920, logicalHeight: 1080, physicalWidth: 1920, physicalHeight: 1080, dpiRatio: 1 }),
    listDisplays: vi.fn().mockResolvedValue([]),
  };
}

function makeToolCtx(platform = makePlatform()): ToolContext {
  return {
    desktop: { getScreenSize: vi.fn().mockReturnValue({ width: 1920, height: 1080 }) },
    a11y: { invalidateCache: vi.fn() },
    cdp: { isConnected: vi.fn().mockResolvedValue(false) },
    platform: platform as any,
    getMouseScaleFactor: vi.fn().mockReturnValue(1),
    getScreenshotScaleFactor: vi.fn().mockReturnValue(1),
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
  } as unknown as ToolContext;
}

const tool = (name: string) => buildUnifiedTools().find(t => t.name === name)!;

describe('parseAssertions — accepts the JSON-encoded array string the schema advertises', () => {
  it('parses a JSON-encoded array string', () => {
    const parsed = parseAssertions('[{"type":"app_running","name":"notepad"}]');
    expect('assertions' in parsed && parsed.assertions).toEqual([{ type: 'app_running', name: 'notepad' }]);
  });

  it('still rejects a bare prose string, naming the accepted forms', () => {
    const parsed = parseAssertions('window_title_contains:Identity');
    expect('error' in parsed && parsed.error).toMatch(/array/);
  });

  it('validateExpect: null/undefined is fine, malformed is an error string', () => {
    expect(validateExpect(undefined)).toBeNull();
    expect(validateExpect(null)).toBeNull();
    expect(validateExpect([{ type: 'app_running', name: 'x' }])).toBeNull();
    expect(validateExpect('garbage')).toMatch(/array/);
    expect(validateExpect([{ type: 'nope' }])).toMatch(/unknown type/);
  });
});

describe('projected MCP handler — expect is checked BEFORE the action', () => {
  let platform: ReturnType<typeof makePlatform>;
  beforeEach(() => { platform = makePlatform(); });

  it('a malformed string expect rejects WITHOUT executing (key)', async () => {
    const def = projectToToolDefinition(tool('key'));
    const r = await def.handler({ combo: 'Escape', expect: 'window_title_contains:Identity' }, makeToolCtx(platform));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/expect rejected \(nothing executed\)/);
    expect(platform.keyPress).not.toHaveBeenCalled();
  });

  it('a malformed string expect rejects WITHOUT executing (invoke_element by name)', async () => {
    const def = projectToToolDefinition(tool('invoke_element'));
    const r = await def.handler({ name: 'Switch', expect: 'window_title_contains:Identity' }, makeToolCtx(platform));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/nothing executed/);
    expect(platform.invokeElement).not.toHaveBeenCalled();
    expect(platform.mouseClick).not.toHaveBeenCalled();
  });

  it('a JSON-encoded array string expect executes and verifies', async () => {
    const def = projectToToolDefinition(tool('key'));
    const r = await def.handler({ combo: 'Escape', expect: '[{"type":"app_running","name":"notepad"}]' }, makeToolCtx(platform));
    expect(r.isError).toBe(false);
    expect(platform.keyPress).toHaveBeenCalledTimes(1);
    expect(r.text).toMatch(/verified 1 check/);
  });
});

describe('verify / done — accept the JSON-encoded array string', () => {
  it('verify parses a string assertions payload', async () => {
    const platform = makePlatform();
    const ctx = { platform, task: 't', screen: { logicalWidth: 1, logicalHeight: 1, physicalWidth: 1, physicalHeight: 1, dpiRatio: 1 }, screenshotsCaptured: { n: 0 } } as unknown as AgentToolContext;
    const r = await tool('verify').execute({ assertions: '[{"type":"app_running","name":"notepad"}]' }, ctx);
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/VERIFIED/);
  });
});
