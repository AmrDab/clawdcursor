/**
 * Browser tool fixes: a trailing newline in `browser type` presses Enter; a wrapper element is resolved to the input inside it;
 * `browser click text:` prefers exact matches, skips hidden and disabled ones, and says what it clicked; a selector that matches
 * nothing is an error; `browser connect` takes a port. Fake Playwright objects: no browser.
 */
import { describe, it, expect, vi } from 'vitest';
import { CDPDriver } from '../platform/cdp-driver';
import { buildCoreTools } from '../tools/core-tools';
import { getCdpTools } from '../tools/cdp';

const agentTool = (n: string) => buildCoreTools().find(t => t.name === n)!;
const URL = 'https://app.example/';

/** A locator whose evaluate answers "is it a field itself" with `isField`, and holds `inner` as the field inside it. */
function fakeLocator(log: string[], name: string, opts: { isField?: boolean; inner?: ReturnType<typeof fakeLocator>; fillFails?: boolean } = {}) {
  const loc: any = {
    first: () => loc,
    count: async () => 1,
    boundingBox: async () => null,
    evaluate: async (_fn: unknown, arg: unknown) => (typeof arg === 'string' ? (opts.isField ?? true) : { value: `read:${name}`, readable: true }),
    locator: () => opts.inner ?? { first: () => ({ count: async () => 0 }), count: async () => 0 },
    fill: async (t: string) => { if (opts.fillFails) throw new Error('not an input'); log.push(`fill ${name}=${t}`); },
    click: async () => { log.push(`click ${name}`); },
  };
  return loc;
}

function driverOn(locators: Record<string, any>, focusEditable = true, log: string[] = []) {
  const frame: any = {
    url: () => URL, name: () => '', parent: null, parentFrame: () => null,
    locator: (sel: string) => locators[sel] ?? { first: () => ({ count: async () => 0 }), count: async () => 0 },
    evaluate: async () => focusEditable,
  };
  const page: any = {
    mainFrame: () => frame, frames: () => [frame], url: () => URL, title: async () => 'App',
    keyboard: { press: async (k: string) => { log.push(`press ${k}`); }, type: async (t: string) => { log.push(`type ${t}`); } },
  };
  const d = new CDPDriver();
  d.attachToPage(page);
  return { d, log };
}

describe('browser type: a trailing newline presses Enter (#12)', () => {
  const ctxWith = (shown: object | null) => {
    const cdp = {
      isConnected: vi.fn(async () => true),
      typeInField: vi.fn(async () => ({ success: true, read: async () => shown })),
      pressKey: vi.fn(async () => ({ success: true })),
    };
    return { cdp, ctx: { platform: {}, cdp } as any };
  };

  it('types the text without the newline, then presses Enter, and says so', async () => {
    const { cdp, ctx } = ctxWith({ value: 'pizza', readable: true });
    const r = await agentTool('cdp_type').execute({ selector: '#q', text: 'pizza\n' }, ctx);
    expect(cdp.typeInField).toHaveBeenCalledWith('#q', 'pizza', undefined);
    expect(cdp.pressKey).toHaveBeenCalledWith('Enter');
    expect(r.success).toBe(true);
    expect(r.text).toContain('Then pressed Enter');
  });

  it('text without a newline presses nothing', async () => {
    const { cdp, ctx } = ctxWith({ value: 'pizza', readable: true });
    const r = await agentTool('cdp_type').execute({ selector: '#q', text: 'pizza' }, ctx);
    expect(cdp.pressKey).not.toHaveBeenCalled();
    expect(r.text).not.toContain('Enter');
  });

  it('a field that did not take the text is not submitted', async () => {
    const { cdp, ctx } = ctxWith({ value: '', readable: true });
    const r = await agentTool('cdp_type').execute({ selector: '#q', text: 'pizza\r\n' }, ctx);
    expect(cdp.pressKey).not.toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(r.text).toContain('Enter was NOT pressed');
  });
});

describe('browser type: a wrapper is resolved to its input (#13)', () => {
  it('fills the input inside a wrapper and reads that input back', async () => {
    const log: string[] = [];
    const inner = fakeLocator(log, 'inner');
    const { d } = driverOn({ '#box': fakeLocator(log, 'wrapper', { isField: false, inner }) }, true, log);
    const r = await d.typeInField('#box', 'hello');
    expect(r.success).toBe(true);
    expect(log).toContain('fill inner=hello');
    expect(log.some(l => l.startsWith('fill wrapper'))).toBe(false);
    expect(await r.read!()).toMatchObject({ value: 'read:inner' });
  });

  it('a wrapper with no input whose click focuses nothing editable fails, and types nothing', async () => {
    const log: string[] = [];
    const { d } = driverOn({ '#box': fakeLocator(log, 'wrapper', { isField: false, fillFails: true }) }, false, log);
    const r = await d.typeInField('#box', 'hello');
    expect(r.success).toBe(false);
    expect(r.error).toContain('not an editable field');
    expect(log.some(l => l.startsWith('type '))).toBe(false);
  });
});

describe('browser click text: exact, then prefix, then substring; visible and enabled only (#14)', () => {
  type Btn = { text: string; hidden?: boolean; disabled?: boolean };
  /**
   * A frame whose evaluateHandle runs the real page function against `buttons`, in a minimal DOM: just enough of
   * document / getComputedStyle for controlByText.
   */
  function driverWith(buttons: Btn[]) {
    const clicked: string[] = [];
    const els = buttons.map(b => ({
      tagName: 'BUTTON', textContent: b.text, disabled: !!b.disabled,
      getAttribute: () => null, getClientRects: () => (b.hidden ? [] : [{}]),
      click: () => clicked.push(b.text),
    }));
    const frame: any = {
      url: () => URL, name: () => '', parent: null, parentFrame: () => null,
      evaluateHandle: async (fn: (t: string) => unknown, text: string) => {
        const g: any = globalThis;
        g.document = { querySelectorAll: (sel: string) => (sel === 'button, [role="button"]' ? els : []) };
        g.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
        const out = fn(text) as any;
        const isEl = els.includes(out);
        return {
          asElement: () => (isEl ? { evaluate: async (f: (e: unknown) => unknown) => f(out) } : null),
          jsonValue: async () => (isEl ? {} : out),
        };
      },
      getByRole: () => ({ count: async () => 0 }), getByText: () => ({ count: async () => 0 }),
      evaluate: async () => null,
    };
    const page: any = { mainFrame: () => frame, frames: () => [frame], url: () => URL, title: async () => 'App' };
    const d = new CDPDriver();
    d.attachToPage(page);
    return { d, clicked };
  }

  it('an exact match beats an earlier substring match, and the reply names what was clicked', async () => {
    const { d, clicked } = driverWith([{ text: 'Search tips' }, { text: 'Search' }]);
    const r = await d.clickByText('search');
    expect(r.success).toBe(true);
    expect(clicked).toEqual(['Search']);
    expect(r.clicked).toBe('<button> "Search"');
  });

  it('hidden and disabled controls are skipped', async () => {
    const { d, clicked } = driverWith([{ text: 'Go', hidden: true }, { text: 'Go', disabled: true }, { text: 'Go now' }]);
    const r = await d.clickByText('Go');
    expect(r.success).toBe(true);
    expect(clicked).toEqual(['Go now']);
  });

  it('several inexact matches fail with a short list and click nothing', async () => {
    const { d, clicked } = driverWith([{ text: 'Search tips' }, { text: 'Search results' }]);
    const r = await d.clickByText('Search');
    expect(r.success).toBe(false);
    expect(r.error).toContain('matches several elements');
    expect(r.error).toContain('Search tips');
    expect(r.error).toContain('Search results');
    expect(clicked).toEqual([]);
  });

  it('browser_click reports the element it hit', async () => {
    const cdp = { isConnected: async () => true, clickByText: async () => ({ success: true, method: 'js.clickByText', clicked: '<button> "Search"' }) };
    const r = await agentTool('cdp_click').execute({ text: 'search' }, { platform: {}, cdp } as any);
    expect(r.text).toContain(`hit "<button> 'Search'"`);
  });
});

describe('a selector that matches nothing is an error (#15)', () => {
  const missing = () => ({
    isConnected: async () => true,
    readText: async () => { throw new Error('element not found: "#nope" in the page'); },
    getPageContext: async () => '',
  });

  it('browser read with a selector fails instead of returning the miss as content', async () => {
    const r = await agentTool('cdp_page_context').execute({ selector: '#nope' }, { platform: {}, cdp: missing() } as any);
    expect(r.success).toBe(false);
    expect(r.text).toContain('element not found');
  });

  it('cdp_read_text fails the same way', async () => {
    const t = getCdpTools().find(x => x.name === 'cdp_read_text')!;
    const r = await t.handler({ selector: '#nope' }, { cdp: missing() } as any);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('element not found');
  });
});

describe('browser connect takes a port (#29)', () => {
  const ctxFor = (connect: (p: number) => Promise<boolean>, connected = false) => {
    const cdp = {
      ensureConnected: vi.fn(async () => true),
      connect: vi.fn(connect),
      disconnect: vi.fn(async () => {}),
      isConnected: vi.fn(async () => connected),
      getUrl: async () => 'https://app.example/', getTitle: async () => 'App',
      getConnectError: () => 'nothing listens on port 9222',
      getConnectionMode: () => 'attached',
    };
    return { cdp, ctx: { platform: {}, cdp } as any };
  };

  it('with a port: connects to that port and launches nothing', async () => {
    const { cdp, ctx } = ctxFor(async () => true);
    const r = await agentTool('cdp_connect').execute({ port: 9222 }, ctx);
    expect(cdp.connect).toHaveBeenCalledWith(9222);
    expect(cdp.ensureConnected).not.toHaveBeenCalled();
    expect(r.success).toBe(true);
  });

  it('a port nothing answers on fails and does not fall back to the agent browser', async () => {
    const { cdp, ctx } = ctxFor(async () => false);
    const r = await agentTool('cdp_connect').execute({ port: 9222 }, ctx);
    expect(r.success).toBe(false);
    expect(r.text).toContain('port 9222');
    expect(cdp.ensureConnected).not.toHaveBeenCalled();
  });

  it('a bad port is refused', async () => {
    const { cdp, ctx } = ctxFor(async () => true);
    const r = await agentTool('cdp_connect').execute({ port: 70000 }, ctx);
    expect(r.success).toBe(false);
    expect(cdp.connect).not.toHaveBeenCalled();
  });

  it('without a port: today\'s behaviour', async () => {
    const { cdp, ctx } = ctxFor(async () => true);
    await agentTool('cdp_connect').execute({}, ctx);
    expect(cdp.ensureConnected).toHaveBeenCalled();
    expect(cdp.connect).not.toHaveBeenCalled();
  });
});
