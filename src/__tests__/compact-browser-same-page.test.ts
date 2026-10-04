/**
 * Compact-surface browser driving (1.5.11 live repro, Ubuntu + Chrome):
 *
 *   window {action:"navigate", url}   → "Opened: … (CDP port 9223 enabled)"
 *   browser {action:"connect"}        → dedicated agent browser at about:blank
 *   browser {action:"page_context"}   → INTERACTIVE ELEMENTS (0)
 *   browser {action:"list_tabs"}      → "Cannot list tabs …"
 *
 * navigate_browser launched a SECOND browser on the user port and never told
 * the driver; cdp_connect then attached to the agent port — a different
 * instance. The contract pinned here: navigate, connect, page_context, type,
 * select_option and list_tabs all operate on ONE driver / ONE page, and every
 * hint names actions that exist on the surface the caller is using.
 *
 * The CDP driver and child_process are mocked — nothing is launched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake')),
  })),
}));

vi.mock('../platform/ocr-engine', () => ({
  OcrEngine: class {
    isAvailable() { return false; }
    async recognizeScreen() { return { elements: [], fullText: '', durationMs: 0 }; }
    invalidateCache() {}
  },
}));

// Never spawn a real browser from a tool under test. `which` and the browser
// binaries "succeed" instantly so the legacy launch path returns "Opened:".
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, _args: unknown, _opts: unknown, cb?: (e: null, so: string, se: string) => void) => {
    const done = typeof _opts === 'function' ? (_opts as typeof cb) : cb;
    done?.(null, '', '');
    return { unref() {} };
  };
  return { ...real, execFile, spawn: vi.fn(() => ({ unref() {} })) };
});

import { getCompactTools } from '../tools/compact';
import { getAllTools } from '../tools/registry';
import type { ToolContext } from '../tools/types';
import { makeMockPlatform } from './helpers/mock-platform';

const FORM_URL = 'http://localhost:8765/form.html';

/**
 * A stateful stand-in for CDPDriver: one browser, one active page. Models the
 * real driver's semantics — ensureConnected() brings up the dedicated blank
 * agent page; navigate() drives the ACTIVE page.
 */
function fakeDriver(mode: 'dedicated' | 'attached' = 'dedicated') {
  const st = {
    connected: false,
    mode: 'unknown' as string,
    pages: [] as Array<{ url: string; title: string }>,
    active: -1,
  };
  const page = () => st.pages[st.active];
  const onForm = () => page()?.url === FORM_URL;
  const drv = {
    st,
    isConnected: vi.fn(async () => st.connected),
    connect: vi.fn(async () => false),
    disconnect: vi.fn(async () => { st.connected = false; }),
    ensureConnected: vi.fn(async () => {
      if (st.connected) return true;
      st.pages = mode === 'attached'
        ? [{ url: 'https://mail.example.com/inbox', title: 'Inbox — user' }]
        : [{ url: 'about:blank', title: 'ClawdCursor — agent browser' }];
      st.active = 0;
      st.connected = true;
      st.mode = mode;
      return true;
    }),
    getConnectionMode: () => st.mode,
    navigate: vi.fn(async (url: string) => {
      if (st.mode === 'attached') {            // tab discipline: own tab, user's untouched
        st.pages.push({ url, title: 'Form' });
        st.active = st.pages.length - 1;
      } else {
        page().url = url; page().title = 'Form';
      }
      return { success: true, method: 'goto', value: url };
    }),
    getPage: vi.fn(() => null),
    getUrl: vi.fn(async () => page().url),
    getTitle: vi.fn(async () => page().title),
    getPageContext: vi.fn(async () => onForm()
      ? `PAGE "Form" at ${FORM_URL}\nINTERACTIVE ELEMENTS (2):\n  input#city label="City"\n  select#size`
      : `PAGE "${page().title}" at ${page().url}\nINTERACTIVE ELEMENTS (0)`),
    typeByLabel: vi.fn(async (label: string) => onForm() && label === 'City'
      ? { success: true, method: 'label' }
      : { success: false, error: `No field found with label "${label}"` }),
    selectOption: vi.fn(async () => onForm()
      ? { success: true, method: 'select' }
      : { success: false, error: 'page.selectOption: Timeout 30000ms exceeded' }),
    listTabs: vi.fn(async () => st.pages.map((p, i) => ({ ...p, active: i === st.active }))),
  };
  return drv;
}

function makeCtx(cdp: ReturnType<typeof fakeDriver>): ToolContext {
  return {
    desktop: { getScreenSize: vi.fn().mockReturnValue({ width: 1920, height: 1080 }) },
    a11y: { invalidateCache: vi.fn() },
    cdp,
    platform: makeMockPlatform(),
    getMouseScaleFactor: () => 1,
    getScreenshotScaleFactor: () => 1,
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
  } as unknown as ToolContext;
}

const compact = (name: string) => getCompactTools().find(t => t.name === name)!;
const granular = (name: string) => getAllTools().find(t => t.name === name)!;

/** Names that do NOT exist on the compact surface (granular + agent-loop). */
const NOT_ON_COMPACT = /\b(cdp_\w+|navigate_browser|browser_(connect|navigate|read|click|type))\b/;
/** Agent-loop (System B) names that do NOT exist on the granular MCP surface. */
const NOT_ON_GRANULAR = /\bbrowser_(connect|navigate|read|click|type)\b/;

const realFetch = globalThis.fetch;
beforeEach(() => {
  // No live sockets: the legacy list_tabs path probed 127.0.0.1:9223 directly.
  globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('compact surface — navigate, connect and page actions share one page', () => {
  it('window navigate → browser connect → page_context/type/select_option/list_tabs all see the navigated page', async () => {
    const cdp = fakeDriver();
    const ctx = makeCtx(cdp);
    const win = compact('window');
    const browser = compact('browser');

    const nav = await win.handler({ action: 'navigate', url: FORM_URL }, ctx);
    expect(nav.isError).toBeFalsy();
    // The driver — not a side-launched process — must have been used.
    expect(cdp.navigate).toHaveBeenCalledWith(FORM_URL);

    const conn = await browser.handler({ action: 'connect' }, ctx);
    expect(conn.isError).toBeFalsy();
    expect(conn.text).toContain(FORM_URL);

    const pc = await browser.handler({ action: 'page_context' }, ctx);
    expect(pc.text).toContain('INTERACTIVE ELEMENTS (2)');

    const typed = await browser.handler({ action: 'type', label: 'City', text: 'Berlin' }, ctx);
    expect(typed.isError).toBeFalsy();

    const sel = await browser.handler({ action: 'select_option', selector: '#size', value: 'L' }, ctx);
    expect(sel.isError).toBeFalsy();

    const tabs = await browser.handler({ action: 'list_tabs' }, ctx);
    expect(tabs.isError).toBeFalsy();
    expect(tabs.text).toContain(FORM_URL);
  });

  it('browser navigate exists on the compact browser compound and needs no prior connect', async () => {
    const cdp = fakeDriver();
    const ctx = makeCtx(cdp);
    const browser = compact('browser');
    expect((browser.parameters.action.enum ?? [])).toContain('navigate');

    const nav = await browser.handler({ action: 'navigate', url: FORM_URL }, ctx);
    expect(nav.isError).toBeFalsy();
    const pc = await browser.handler({ action: 'page_context' }, ctx);
    expect(pc.text).toContain('INTERACTIVE ELEMENTS (2)');
  });

  it('attached to an existing browser: navigate goes through the driver (own tab) and discloses it', async () => {
    const cdp = fakeDriver('attached');
    const ctx = makeCtx(cdp);
    const nav = await compact('window').handler({ action: 'navigate', url: FORM_URL }, ctx);
    expect(nav.isError).toBeFalsy();
    expect(cdp.navigate).toHaveBeenCalledWith(FORM_URL);
    expect(nav.text).toMatch(/existing browser/i);
    // The user's inbox tab is untouched; the form opened in the agent's own tab.
    expect(cdp.st.pages[0].url).toBe('https://mail.example.com/inbox');
    expect(cdp.st.pages[1].url).toBe(FORM_URL);
  });
});

describe('hints name only tools/actions that exist on the active surface', () => {
  it('compact: connect/navigate results and not-connected errors never name granular or agent-loop tools', async () => {
    const cdp = fakeDriver();
    const ctx = makeCtx(cdp);
    const browser = compact('browser');

    const notConnected = await browser.handler({ action: 'type', label: 'City', text: 'x' }, ctx);
    expect(notConnected.isError).toBe(true);
    expect(notConnected.text).not.toMatch(NOT_ON_COMPACT);
    expect(notConnected.text).toContain('browser {action:"connect"}');

    const tabs = await browser.handler({ action: 'list_tabs' }, ctx);
    expect(tabs.text).not.toMatch(NOT_ON_COMPACT);

    const conn = await browser.handler({ action: 'connect' }, ctx);
    expect(conn.text).not.toMatch(NOT_ON_COMPACT);
    expect(conn.text).toContain('browser {action:"navigate"}');

    const nav = await browser.handler({ action: 'navigate', url: FORM_URL }, ctx);
    expect(nav.text).not.toMatch(NOT_ON_COMPACT);

    for (const t of getCompactTools()) expect(t.description).not.toMatch(NOT_ON_COMPACT);
  });

  it('granular: cdp_connect names navigate_browser / cdp_page_context, not the agent-loop browser_* names', async () => {
    const cdp = fakeDriver();
    const ctx = makeCtx(cdp);
    const conn = await granular('cdp_connect').handler({}, ctx);
    expect(conn.text).not.toMatch(NOT_ON_GRANULAR);
    expect(conn.text).toContain('navigate_browser');
    expect(granular('cdp_connect').description).not.toMatch(NOT_ON_GRANULAR);
  });
});
