/**
 * What the projected tools (src/tools/projected/tools.ts) answer, as agents receive it on the granular and the compact
 * surface: their results name MCP tools (cdp_connect, navigate_browser, ocr_read_screen…), never the old agent-loop
 * names (browser_connect, browser_read, read_text…). And their MCP defaults: click / drag / scroll take image-space
 * coordinates when `space` is omitted, mouse_move_relative scales dx/dy from image space.
 *
 * Characterization: the texts are pinned as they were when a regex renamed them on the way out (project-mcp toMcpNames),
 * so writing the MCP names into the tools changes nothing an agent reads.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { getAllTools, getCompactSurface } from '../tools/registry';
import { setLastFrame } from '../platform/coord-scale';
import type { ToolContext } from '../tools/types';
import { makeMockPlatform } from './helpers/mock-platform';

/** Agent-loop names that exist on neither MCP surface. */
const AGENT_LOOP_NAMES = /\b(browser_(connect|navigate|read|click|type)|read_text|list_windows)\b/;

function driver(over: Record<string, unknown> = {}) {
  return {
    isConnected: vi.fn(async () => true),
    ensureConnected: vi.fn(async () => true),
    getConnectError: () => 'port 9222 refused',
    getConnectionMode: () => 'dedicated',
    getUrl: vi.fn(async () => 'about:blank'),
    getTitle: vi.fn(async () => 'Agent browser'),
    getBrowserPid: vi.fn(async () => 4242),
    getPageContext: vi.fn(async () => 'PAGE "x"\nINTERACTIVE ELEMENTS (0)'),
    clickByText: vi.fn(async () => ({ success: false, error: 'no element with that text' })),
    click: vi.fn(async () => ({ success: true, method: 'selector' })),
    typeByLabel: vi.fn(async () => ({ success: false, error: 'no field with that label' })),
    typeInField: vi.fn(async () => ({ success: false, error: 'no such input' })),
    ...over,
  };
}

function ctxWith(cdp: unknown, mouseScale = 1): ToolContext {
  return {
    desktop: { getScreenSize: vi.fn().mockReturnValue({ width: 2560, height: 1440 }) },
    a11y: { invalidateCache: vi.fn() },
    cdp,
    platform: makeMockPlatform(),
    getMouseScaleFactor: () => mouseScale,
    getScreenshotScaleFactor: () => mouseScale,
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
  } as unknown as ToolContext;
}

const granular = (name: string) => getAllTools().find(t => t.name === name)!;
const compact = (name: string) => getCompactSurface().find(t => t.name === name)!;

let wakeBudget: string | undefined;
beforeAll(() => { wakeBudget = process.env.CLAWDCURSOR_WAKE_BUDGET_MS; process.env.CLAWDCURSOR_WAKE_BUDGET_MS = '0'; setLastFrame(null); });
afterAll(() => { if (wakeBudget === undefined) delete process.env.CLAWDCURSOR_WAKE_BUDGET_MS; else process.env.CLAWDCURSOR_WAKE_BUDGET_MS = wakeBudget; });

describe('projected browser tools name MCP tools in their results', () => {
  it('cdp_connect', async () => {
    const none = await granular('cdp_connect').handler({}, ctxWith(null));
    expect(none.text).toBe('cdp_connect: CDP not available in this build — use ocr_read_screen/smart_click for the page instead.');

    const failed = await granular('cdp_connect').handler({}, ctxWith(driver({ ensureConnected: vi.fn(async () => false) })));
    expect(failed.text).toBe('cdp_connect: could not launch or attach to a CDP browser: port 9222 refused. Otherwise fall back to ocr_read_screen/smart_click.');

    const ok = await granular('cdp_connect').handler({}, ctxWith(driver()));
    expect(ok.text).toBe('cdp_connect: connected to "Agent browser" at "about:blank". (dedicated agent-owned instance — safe to drive freely). NOTE: this browser has its OWN profile — login state may DIFFER from the window you were driving. If a site demands login here but the on-screen window looked logged in, drive the on-screen window instead (keyboard/OCR) or use relaunch_with_cdp. Use navigate_browser to open a URL, cdp_page_context to see the page, cdp_click/cdp_type to interact.');

    const attached = await granular('cdp_connect').handler({}, ctxWith(driver({ getConnectionMode: () => 'attached' })));
    expect(attached.text).toContain(' ⚠ ATTACHED to an EXISTING browser (likely the user\'s own session). navigate_browser automatically works in the agent\'s OWN tab');

    // A name that came from the page itself is the page's, quoted as it is.
    const titled = await granular('cdp_connect').handler({}, ctxWith(driver({ getTitle: vi.fn(async () => 'browser_read docs') })));
    expect(titled.text).toMatch(/^cdp_connect: connected to "(browser_read|cdp_page_context) docs"/);

    const viaCompact = await compact('browser').handler({ action: 'connect' }, ctxWith(driver()));
    expect(viaCompact.text).toMatchInlineSnapshot(`"browser {"action":"connect"}: connected to "Agent browser" at "about:blank". (dedicated agent-owned instance — safe to drive freely). NOTE: this browser has its OWN profile — login state may DIFFER from the window you were driving. If a site demands login here but the on-screen window looked logged in, drive the on-screen window instead (keyboard/OCR) or use system {"action":"relaunch_with_cdp"}. Use browser {"action":"navigate"} to open a URL, browser {"action":"page_context"} to see the page, browser {"action":"click"}/browser {"action":"type"} to interact."`);
  });

  it('cdp_page_context, cdp_click, cdp_type', async () => {
    const off = driver({ isConnected: vi.fn(async () => false) });
    expect((await granular('cdp_page_context').handler({}, ctxWith(off))).text).toBe('cdp_page_context: not connected — call cdp_connect first.');
    expect((await granular('cdp_click').handler({ text: 'OK' }, ctxWith(off))).text).toBe('cdp_click: not connected — call cdp_connect first.');
    expect((await granular('cdp_type').handler({ text: 'x', label: 'City' }, ctxWith(off))).text).toBe('cdp_type: not connected — call cdp_connect first.');

    expect((await granular('cdp_click').handler({}, ctxWith(driver()))).text).toBe('cdp_click: provide text or selector.');
    expect((await granular('cdp_click').handler({ text: 'OK' }, ctxWith(driver()))).text).toBe('cdp_click failed: no element with that text. Call cdp_page_context to see the actual elements, then retry.');
    expect((await granular('cdp_click').handler({ selector: '#ok' }, ctxWith(driver()))).text).toMatch(/^cdp_click: clicked #ok \(selector\)/);

    expect((await granular('cdp_type').handler({ text: 'x' }, ctxWith(driver()))).text).toBe('cdp_type: provide selector or label.');
    expect((await granular('cdp_type').handler({ text: 'x', label: 'City' }, ctxWith(driver()))).text).toBe('cdp_type failed: no field with that label');

    const viaCompact = await compact('browser').handler({ action: 'click', text: 'OK' }, ctxWith(driver()));
    expect(viaCompact.text).toMatchInlineSnapshot(`"browser {"action":"click"} failed: no element with that text. Call browser {"action":"page_context"} to see the actual elements, then retry."`);
  });

  it('read_screen on the browser clawdcursor drives over CDP points at the browser tools', async () => {
    const r = await granular('read_screen').handler({ processId: 4242 }, ctxWith(driver({ getConnectionMode: () => 'attached' })));
    expect(r.text).toMatchInlineSnapshot(`
      "(empty a11y tree — app may be custom-canvas)
      → This is the browser clawdcursor is attached to over CDP: read and act on its page with browser {"action":"page_context"} (interactive elements) · browser {"action":"ocr_read_screen"} · browser {"action":"click"} — they see the whole page, whatever the accessibility tree shows."
    `);
    const viaCompact = await compact('accessibility').handler({ action: 'read_tree', processId: 4242 }, ctxWith(driver({ getConnectionMode: () => 'attached' })));
    expect(viaCompact.text).toMatchInlineSnapshot(`
      "(empty a11y tree — app may be custom-canvas)
      → This is the browser clawdcursor is attached to over CDP: read and act on its page with browser {"action":"page_context"} (interactive elements) · browser {"action":"ocr_read_screen"} · browser {"action":"click"} — they see the whole page, whatever the accessibility tree shows."
    `);
  });

  it('every result above is free of agent-loop names', async () => {
    const texts = [
      (await granular('cdp_connect').handler({}, ctxWith(null))).text,
      (await granular('cdp_connect').handler({}, ctxWith(driver()))).text,
      (await granular('cdp_click').handler({ text: 'OK' }, ctxWith(driver()))).text,
      (await granular('cdp_page_context').handler({}, ctxWith(driver({ isConnected: vi.fn(async () => false) })))).text,
    ];
    for (const t of texts) expect(t).not.toMatch(AGENT_LOOP_NAMES);
  });
});

describe('projected pointer tools take image space by default on MCP', () => {
  it('mouse_click / mouse_drag / mouse_scroll without space scale image coordinates', async () => {
    const ctx = ctxWith(null, 2);
    const click = await granular('mouse_click').handler({ x: 100, y: 50 }, ctx);
    expect(ctx.platform!.mouseClick).toHaveBeenLastCalledWith(200, 100, expect.anything());
    expect(click.text).toMatch(/^Clicked left x1 at image \(100,50\) → screen \(200,100\) \[×2/);
    const screen = await granular('mouse_click').handler({ x: 100, y: 50, space: 'screen' }, ctx);
    expect(ctx.platform!.mouseClick).toHaveBeenLastCalledWith(100, 50, expect.anything());
    expect(screen.text).toMatch(/^Clicked left x1 at screen \(100,50\) \[×1/);

    const drag = await granular('mouse_drag').handler({ startX: 10, startY: 10, endX: 20, endY: 30 }, ctx);
    expect(ctx.platform!.mouseDrag).toHaveBeenLastCalledWith(20, 20, 40, 60);
    expect(drag.text).toMatch(/^Dragged image \(10,10\)→\(20,30\) → screen \(20,20\)→\(40,60\) \[×2\]/);

    const scroll = await granular('mouse_scroll').handler({ x: 10, y: 20, direction: 'down' }, ctx);
    expect(ctx.platform!.mouseScroll).toHaveBeenLastCalledWith(20, 40, 'down', 3);
    expect(scroll.text).toBe('Scrolled down 3 at (20,40)');

    await granular('mouse_click').handler({ path: [{ x: 1, y: 2 }], interval_ms: 0 }, ctx);
    expect(ctx.platform!.mouseClick).toHaveBeenLastCalledWith(2, 4, expect.anything());
  });

  it('mouse_move_relative scales dx/dy from image space and reports the scaled offset', async () => {
    const ctx = ctxWith(null, 2);
    const r = await granular('mouse_move_relative').handler({ dx: 15, dy: -4 }, ctx);
    expect(ctx.platform!.mouseMoveRelative).toHaveBeenLastCalledWith(30, -8);
    expect(r.text).toBe('Cursor moved by (30, -8)');
  });

  it('the published `space` text states the image default', () => {
    for (const n of ['mouse_click', 'mouse_drag', 'mouse_scroll']) {
      expect(granular(n).parameters.space.description).toMatch(/^Coordinate space\. Omit \(default\) → image-space coords/);
    }
  });
});
