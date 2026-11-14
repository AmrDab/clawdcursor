/**
 * CDP DOM fallback in find_element, and the CDP-browser hint of find_element and read_screen.
 *
 * Edge/Chrome UIA trees stop at browser chrome — canvas-rendered content,
 * single-page apps, and any page that bypasses MSAA are invisible to a pure
 * UIA query. When the focused window IS a browser and clawdcursor's CDP
 * driver is attached, find_element consults the DOM.
 *
 * These tests pin the four routing decisions (UIA hit / browser+CDP fallback
 * hit / not-a-browser path / CDP not connected path) for find_element. No real
 * CDP or platform is needed.
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
import { getTool } from '../tools/registry';
import type { ToolContext } from '../tools/types';

const findElement = getA11yTools().find(t => t.name === 'find_element')!;

function makeCtx(opts: {
  processName?: string;
  platformFindElements?: any[];
  platformUiTree?: any[];
  cdpConnected?: boolean;
  cdpPageEvaluate?: any;
  activeWindowTitle?: string;
  cdpTitle?: string;
  cdpBrowserPid?: number | null;
  cdpMode?: 'dedicated' | 'attached';
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
      getBrowserPid: vi.fn().mockResolvedValue(opts.cdpBrowserPid ?? null),
      getConnectionMode: vi.fn().mockReturnValue(opts.cdpMode ?? 'dedicated'),
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

  // Review of #315: a bridge failure ('error', set on Windows/macOS/Linux) must not pre-empt the browser DOM fallback.
  it('still queries CDP when the accessibility bridge failed, and says FAILED only when CDP finds nothing too', async () => {
    const cdpEvaluate = vi.fn().mockResolvedValue([
      { name: 'Submit Order', controlType: 'web.button', bounds: { x: 200, y: 400, width: 80, height: 30 } },
    ]);
    const ctx = makeCtx({ processName: 'msedge', platformFindElements: [], cdpConnected: true, cdpPageEvaluate: cdpEvaluate });
    ctx.platform.lastFindError = 'error';
    const hit = await findElement.handler({ name: 'Submit' }, ctx);
    expect(hit.text).toContain('Submit Order');
    cdpEvaluate.mockResolvedValue([]);
    const miss = await findElement.handler({ name: 'Submit' }, ctx);
    expect(miss.isError).toBe(true);
    expect(miss.text).toMatch(/FAILED/);
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

// #235: the fallback ignored processId and the hint ignored the CDP browser.
describe('find_element — scoped to the CDP browser by processId (#235)', () => {
  const hit = [{ name: 'Upgrade', controlType: 'web.button', bounds: { x: 900, y: 20, width: 80, height: 30 } }];

  it('answers from the CDP DOM when processId is the CDP browser, even with another app in front', async () => {
    const cdpEvaluate = vi.fn().mockResolvedValue(hit);
    const ctx = makeCtx({
      processName: 'Terminal', activeWindowTitle: 'zsh',      // another app is frontmost
      cdpTitle: 'Miro | Dashboard',
      platformFindElements: [], cdpConnected: true, cdpPageEvaluate: cdpEvaluate, cdpBrowserPid: 4321,
    });
    const result = await findElement.handler({ name: 'Upgrade', processId: 4321 }, ctx);
    expect(cdpEvaluate).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('Upgrade');
    expect(result.text).toContain('CDP DOM');
  });

  it('never answers a query scoped to a DIFFERENT process from the CDP DOM', async () => {
    const cdpEvaluate = vi.fn().mockResolvedValue(hit);
    const ctx = makeCtx({
      processName: 'msedge', activeWindowTitle: 'Checkout - Microsoft Edge', cdpTitle: 'Checkout',
      platformFindElements: [], cdpConnected: true, cdpPageEvaluate: cdpEvaluate, cdpBrowserPid: 4321,
    });
    const result = await findElement.handler({ name: 'Upgrade', processId: 1234 }, ctx);
    expect(cdpEvaluate).not.toHaveBeenCalled();
    expect(result.text).toMatch(/^\(no elements found\)/);
  });

  it('macOS app names count as browsers for the unscoped fallback ("Google Chrome")', async () => {
    const cdpEvaluate = vi.fn().mockResolvedValue(hit);
    const ctx = makeCtx({
      processName: 'Google Chrome', activeWindowTitle: 'Miro | Dashboard - Google Chrome', cdpTitle: 'Miro | Dashboard',
      platformFindElements: [], cdpConnected: true, cdpPageEvaluate: cdpEvaluate,
    });
    const result = await findElement.handler({ name: 'Upgrade' }, ctx);
    expect(cdpEvaluate).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('Upgrade');
  });
});

describe('blind hint for the CDP browser (#235)', () => {
  const empty = () => vi.fn().mockResolvedValue([]);

  it("clawdcursor's own browser: lead with the browser tools, no restart advice", async () => {
    const ctx = makeCtx({
      processName: 'Google Chrome', activeWindowTitle: 'Other - Google Chrome', cdpTitle: 'Miro',
      platformFindElements: [], cdpConnected: true, cdpPageEvaluate: empty(), cdpBrowserPid: 4321, cdpMode: 'dedicated',
    });
    const { text } = await findElement.handler({ name: 'Upgrade', processId: 4321 }, ctx);
    const hint = text.slice(text.indexOf('→'));
    expect(hint).toMatch(/^→ .*browser \{"action":"page_context"\}/);
    expect(hint).toContain('read_text');
    expect(hint).toMatch(/own browser/);
    expect(hint).not.toMatch(/Restarting it|--force-renderer-accessibility/);
  });

  it('a browser attached on the debug port: lead with the browser tools too', async () => {
    const ctx = makeCtx({
      processName: 'chrome', platformFindElements: [], cdpConnected: true, cdpPageEvaluate: empty(),
      cdpBrowserPid: 1234, cdpMode: 'attached',
    });
    const { text } = await findElement.handler({ name: 'Upgrade', processId: 1234 }, ctx);
    expect(text).toMatch(/→ .*browser \{"action":"page_context"\}/);
    expect(text).not.toMatch(/own browser/);
  });

  it('any other app keeps the generic advice', async () => {
    const ctx = makeCtx({
      processName: 'Slack', platformFindElements: [], cdpConnected: true, cdpPageEvaluate: empty(), cdpBrowserPid: 4321,
    });
    const { text } = await findElement.handler({ name: 'Upgrade', processId: 1234 }, ctx);
    expect(text).not.toContain('page_context');
    expect(text).toMatch(/copy_all_text/);
  });
});

// The live read_screen (the projected one agents call) had only the generic hint: #235's went into a copy that never ran.
describe('read_screen (the projected tool) — blind hint for the CDP browser (#235)', () => {
  const readTree = () => getTool('read_screen')!;
  const bar = [{ name: 'Address and search bar', controlType: 'Edit', bounds: { x: 0, y: 0, width: 800, height: 30 } }];
  const page = Array.from({ length: 8 }, (_, i) => ({ name: `Link ${i}`, controlType: 'Hyperlink', bounds: { x: 0, y: 40 + i * 30, width: 200, height: 20 } }));

  it('a thin read of the CDP browser leads with the browser tools', async () => {
    const ctx = makeCtx({
      processName: 'Google Chrome', platformUiTree: bar, cdpConnected: true, cdpBrowserPid: 1234, cdpMode: 'dedicated',
    });
    const { text } = await readTree().handler({}, ctx);
    expect(text).toMatch(/→ .*browser \{"action":"page_context"\}/);
    expect(text).toMatch(/own browser/);
    expect(text).not.toMatch(/Little or no accessibility structure/);
  });

  it('an empty read of the CDP browser, scoped by processId, too', async () => {
    const ctx = makeCtx({ processName: 'Terminal', platformUiTree: [], cdpConnected: true, cdpBrowserPid: 4321, cdpMode: 'attached' });
    const { text } = await readTree().handler({ processId: 4321 }, ctx);
    expect(text).toMatch(/^\(empty a11y tree[^\n]*\n→ .*browser \{"action":"page_context"\}/);
    expect(text).not.toMatch(/own browser/);
  });

  it('a full read of the CDP browser still names the browser tools', async () => {
    const ctx = makeCtx({ processName: 'msedge', platformUiTree: [...bar, ...page], cdpConnected: true, cdpBrowserPid: 1234 });
    const { text } = await readTree().handler({}, ctx);
    expect(text).toMatch(/→ .*browser \{"action":"page_context"\}/);
  });

  it('another app, or a browser not attached over CDP, keeps the generic advice', async () => {
    const other = await readTree().handler({}, makeCtx({ processName: 'Slack', platformUiTree: [{ name: '', controlType: 'Pane', bounds: { x: 0, y: 0, width: 800, height: 600 } }], cdpConnected: true, cdpBrowserPid: 4321 }));
    expect(other.text).not.toContain('page_context');
    expect(other.text).toMatch(/Little or no accessibility structure/);
    const unattached = await readTree().handler({}, makeCtx({ processName: 'msedge', platformUiTree: [...bar, ...page], cdpConnected: false }));
    expect(unattached.text).not.toContain('page_context');
  });
});
