/**
 * CDP DOM fallback in find_element + read_screen.
 *
 * Edge/Chrome UIA trees stop at browser chrome — canvas-rendered content,
 * single-page apps, and any page that bypasses MSAA are invisible to a pure
 * UIA query. When the focused window IS a browser and clawdcursor's CDP
 * driver is attached, find_element and read_screen now consult the DOM.
 *
 * These tests pin the four routing decisions (UIA hit / browser+CDP fallback
 * hit / not-a-browser path / CDP not connected path) for find_element, plus
 * the read_screen append behavior. No real CDP or platform is needed.
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
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake')),
  })),
}));

import { getA11yTools } from '../tools/a11y';
import type { ToolContext } from '../tools/types';

const findElement = getA11yTools().find(t => t.name === 'find_element')!;
const readScreen = getA11yTools().find(t => t.name === 'read_screen')!;

function makeCtx(opts: {
  processName?: string;
  platformFindElements?: any[];
  platformUiTree?: any[];
  cdpConnected?: boolean;
  cdpPageEvaluate?: any;
  activeWindowTitle?: string;
  cdpTitle?: string;
}): ToolContext {
  return {
    desktop: {} as any,
    a11y: {
      getActiveWindow: vi.fn().mockResolvedValue({
        title: 'Test App',
        processName: opts.processName ?? 'msedge',
        processId: 1234,
      }),
      findElement: vi.fn().mockResolvedValue([]),
      getScreenContext: vi.fn().mockResolvedValue('legacy-a11y-tree'),
    } as any,
    platform: opts.platformFindElements !== undefined || opts.platformUiTree !== undefined ? {
      getActiveWindow: vi.fn().mockResolvedValue({
        title: opts.activeWindowTitle ?? 'Test App',
        processName: opts.processName ?? 'msedge',
        processId: 1234,
      }),
      findElements: vi.fn().mockResolvedValue(opts.platformFindElements ?? []),
      listWindows: vi.fn().mockResolvedValue([]),
      getFocusedElement: vi.fn().mockResolvedValue(null),
      getUiTree: vi.fn().mockResolvedValue(opts.platformUiTree ?? []),
    } as any : undefined,
    cdp: {
      isConnected: vi.fn().mockResolvedValue(opts.cdpConnected ?? false),
      getTitle: vi.fn().mockResolvedValue(opts.cdpTitle ?? null),
      getPage: vi.fn().mockReturnValue(
        opts.cdpPageEvaluate
          ? { evaluate: vi.fn().mockImplementation(opts.cdpPageEvaluate) }
          : null,
      ),
    } as any,
    getMouseScaleFactor: () => 1,
    getScreenshotScaleFactor: () => 1,
    ensureInitialized: async () => {},
  } as any;
}

describe('find_element — UIA hits short-circuit before CDP', () => {
  it('returns UIA elements without consulting CDP when matches exist', async () => {
    const cdpEvaluate = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({
      platformFindElements: [
        { name: 'Begin Exam', controlType: 'Button', bounds: { x: 10, y: 10, width: 100, height: 30 } },
      ],
      cdpConnected: true,
      cdpPageEvaluate: cdpEvaluate,
    });
    const result = await findElement.handler({ name: 'Begin Exam' }, ctx);
    expect(result.text).toContain('Begin Exam');
    expect(cdpEvaluate).not.toHaveBeenCalled();
  });
});

describe('find_element — CDP DOM fallback', () => {
  it('queries CDP when UIA is empty AND focused window is a browser AND CDP connected', async () => {
    const cdpEvaluate = vi.fn().mockResolvedValue([
      { name: 'Submit Order', controlType: 'web.button', bounds: { x: 200, y: 400, width: 80, height: 30 } },
    ]);
    const ctx = makeCtx({
      processName: 'msedge',
      platformFindElements: [],
      cdpConnected: true,
      cdpPageEvaluate: cdpEvaluate,
    });
    const result = await findElement.handler({ name: 'Submit' }, ctx);
    expect(cdpEvaluate).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('CDP DOM');
    expect(result.text).toContain('Submit Order');
  });

  it('does NOT query CDP when active window is not a browser', async () => {
    const cdpEvaluate = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({
      processName: 'notepad',
      platformFindElements: [],
      cdpConnected: true,
      cdpPageEvaluate: cdpEvaluate,
    });
    const result = await findElement.handler({ name: 'Foo' }, ctx);
    expect(cdpEvaluate).not.toHaveBeenCalled();
    // Empty is never a dead end: the next blind step follows (blind-first fix).
    expect(result.text).toMatch(/^\(no elements found\)\n→ .*copy_all_text/);
  });

  it('does NOT query CDP when CDP is not connected', async () => {
    const cdpEvaluate = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({
      processName: 'msedge',
      platformFindElements: [],
      cdpConnected: false,
      cdpPageEvaluate: cdpEvaluate,
    });
    const result = await findElement.handler({ name: 'Foo' }, ctx);
    expect(cdpEvaluate).not.toHaveBeenCalled();
    // Empty is never a dead end: the next blind step follows (blind-first fix).
    expect(result.text).toMatch(/^\(no elements found\)\n→ .*copy_all_text/);
  });

  it('returns "(no elements found)" when both UIA and CDP DOM return empty for a browser', async () => {
    const cdpEvaluate = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({
      processName: 'msedge',
      platformFindElements: [],
      cdpConnected: true,
      cdpPageEvaluate: cdpEvaluate,
    });
    const result = await findElement.handler({ name: 'NoSuchTarget' }, ctx);
    expect(cdpEvaluate).toHaveBeenCalledTimes(1);
    // Empty is never a dead end: the next blind step follows (blind-first fix).
    expect(result.text).toMatch(/^\(no elements found\)\n→ .*copy_all_text/);
  });

  // #bug 2026-06-11: the CDP connection was to a DIFFERENT browser than the
  // focused window, so the fallback answered an Edge query with a relay
  // Chrome's DOM. Scope the fallback to the focused window by title.
  it('does NOT use CDP DOM when the connected page is a DIFFERENT window (cross-browser)', async () => {
    const cdpEvaluate = vi.fn().mockResolvedValue([
      { name: 'Continue with Google', controlType: 'web.button', bounds: { x: 445, y: 425, width: 80, height: 30 } },
    ]);
    const ctx = makeCtx({
      processName: 'msedge',
      activeWindowTitle: 'Device Activation - Microsoft Edge',   // focused: Edge
      cdpTitle: 'Sign in to GitHub',                             // CDP target: a DIFFERENT page (relay Chrome)
      platformFindElements: [],
      cdpConnected: true,
      cdpPageEvaluate: cdpEvaluate,
    });
    const result = await findElement.handler({ name: 'Continue' }, ctx);
    expect(cdpEvaluate).not.toHaveBeenCalled();           // never queried the wrong browser's DOM
    expect(result.text).not.toContain('Continue with Google');
    // Empty is never a dead end: the next blind step follows (blind-first fix).
    expect(result.text).toMatch(/^\(no elements found\)\n→ .*copy_all_text/);
  });

  it('DOES use CDP DOM when the connected page corresponds to the focused window', async () => {
    const cdpEvaluate = vi.fn().mockResolvedValue([
      { name: 'Submit Order', controlType: 'web.button', bounds: { x: 200, y: 400, width: 80, height: 30 } },
    ]);
    const ctx = makeCtx({
      processName: 'msedge',
      activeWindowTitle: 'Checkout - Shop - Microsoft Edge',
      cdpTitle: 'Checkout',                                     // contained in the window title → same window
      platformFindElements: [],
      cdpConnected: true,
      cdpPageEvaluate: cdpEvaluate,
    });
    const result = await findElement.handler({ name: 'Submit' }, ctx);
    expect(cdpEvaluate).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('Submit Order');
  });
});

describe('read_screen — CDP DOM digest', () => {
  it('appends BROWSER DOM section when focused window is a browser with CDP attached', async () => {
    const cdpEvaluate = vi.fn().mockResolvedValue([
      { name: 'Login', controlType: 'web.button', bounds: { x: 50, y: 80, width: 100, height: 40 } },
      { name: 'Username', controlType: 'web.input', bounds: { x: 50, y: 30, width: 200, height: 25 } },
    ]);
    const ctx = makeCtx({
      processName: 'msedge',
      platformUiTree: [
        { name: 'Address bar', controlType: 'Edit', bounds: { x: 0, y: 0, width: 800, height: 30 } },
      ],
      cdpConnected: true,
      cdpPageEvaluate: cdpEvaluate,
    });
    const result = await readScreen.handler({}, ctx);
    expect(result.text).toContain('FOCUSED WINDOW UI TREE');
    expect(result.text).toContain('Address bar');
    expect(result.text).toContain('BROWSER DOM (via CDP, viewport-relative coords)');
    expect(result.text).toContain('Login');
    expect(result.text).toContain('Username');
    expect(cdpEvaluate).toHaveBeenCalledTimes(1);
  });

  it('omits BROWSER DOM section when focused window is not a browser', async () => {
    const cdpEvaluate = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({
      processName: 'notepad',
      platformUiTree: [
        { name: 'Document', controlType: 'Document', bounds: { x: 0, y: 0, width: 800, height: 600 } },
      ],
      cdpConnected: true,
      cdpPageEvaluate: cdpEvaluate,
    });
    const result = await readScreen.handler({}, ctx);
    expect(result.text).toContain('Document');
    expect(result.text).not.toContain('BROWSER DOM');
    expect(cdpEvaluate).not.toHaveBeenCalled();
  });
});
