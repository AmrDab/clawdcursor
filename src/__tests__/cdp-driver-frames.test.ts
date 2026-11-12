/**
 * The browser tool searches iframes too (#398): document.querySelector and page locators stop at an iframe's edge, so a
 * control inside an editor iframe was "not found" by click / type / read_text / wait_for. The main frame is still searched
 * first, exactly as before; an iframe is searched only when the page itself has no match. A fake Playwright page: no browser.
 */
import { describe, it, expect } from 'vitest';
import { CDPDriver } from '../platform/cdp-driver';
import { classifyResult } from '../core/result-codes';

type Has = {
  texts?: string[]; plain?: string[]; selectors?: Record<string, string>; labels?: string[]; options?: string[];
  elements?: Array<Record<string, unknown>>; box?: { x: number; y: number }; detached?: boolean; hidden?: boolean; hung?: boolean;
};
/**
 * A frame holding clickable controls `texts`, plain text `plain`, `selectors` (selector → its text), `labels`, select `options`
 * and page_context `elements`; evaluate is answered by what it asks. `hidden`: its owner iframe is display:none. `hung`: never answers.
 */
function fakeFrame(url: string, has: Has = {}) {
  const f = {
    url: () => url,
    name: () => '',
    clicked: [] as string[],
    filled: [] as string[],
    async evaluate(fn: unknown, arg: unknown) {
      if (has.hung) return new Promise(() => {});
      if (has.detached) throw new Error('Frame was detached');
      const src = String(fn);
      if (src.includes('innerText')) {                  // readText
        const { sel, max } = arg as { sel: string; max: number };
        return has.selectors?.[sel]?.substring(0, max) ?? null;
      }
      if (src.includes('interactiveSelectors')) return has.elements ?? [];   // page_context
      if (src.includes('querySelector(sel)')) {         // click(selector)'s JS pass
        const hit = (arg as string) in (has.selectors ?? {});
        if (hit) f.clicked.push(arg as string);
        return hit;
      }
      if (src.includes('searchLabel')) return null;     // findFieldByLabel's own finder
      throw new Error(`unexpected evaluate: ${src.slice(0, 60)}`);
    },
    async evaluateHandle(_fn: unknown, text: string) {   // clickByText's control pass
      if (has.hung) return new Promise(() => {});
      if (has.detached) throw new Error('Frame was detached');
      const hit = (has.texts ?? []).includes(text);
      return { asElement: () => hit ? { evaluate: async () => { f.clicked.push(text); } } : null };
    },
    frameElement: async () => ({ evaluate: async () => !has.hidden, boundingBox: async () => has.box ?? null }),
    getByRole: () => none(),
    getByText: (t: string) => (has.plain ?? []).includes(t) ? some(() => f.clicked.push(`text:${t}`)) : none(),
    getByLabel: (label: string) => (has.labels ?? []).includes(label) ? some(() => f.filled.push(label)) : none(),
    locator: (sel: string) => (sel in (has.selectors ?? {})) ? some(() => {}) : none(),
    async fill(sel: string, text: string) { f.filled.push(`${sel}=${text}`); },
    async selectOption(sel: string, v: string) {
      if (!(has.options ?? []).includes(v)) return [];
      f.filled.push(`${sel}=${v}`);
      return [v];
    },
  };
  return f;
}
function none() {
  return { count: async () => 0, first: () => ({ isVisible: async () => false, boundingBox: async () => null }) };
}
function some(act: () => void) {
  const el = { isVisible: async () => true, boundingBox: async () => null, fill: async () => { act(); }, click: async () => { act(); } };
  return { count: async () => 1, first: () => el };
}

function driverOn(main: ReturnType<typeof fakeFrame>, ...children: Array<ReturnType<typeof fakeFrame>>) {
  const page = { mainFrame: () => main, frames: () => [main, ...children], url: () => main.url(), title: async () => 'App' };
  const d = new CDPDriver();
  d.attachToPage(page as never);
  return d;
}

describe('browser tool reaches into iframes (#398)', () => {
  it('a click by text the page lacks is found and clicked in an iframe, and the result names that iframe', async () => {
    const main = fakeFrame('https://app.example/');
    const editor = fakeFrame('https://editor.example/frame', { texts: ['Select All'] });
    const r = await driverOn(main, editor).clickByText('Select All');
    expect(r).toMatchObject({ success: true, method: 'js.clickByText', frame: 'https://editor.example/frame' });
    expect(editor.clicked).toEqual(['Select All']);
  });

  it('a match on the page itself is clicked there; no iframe is searched', async () => {
    const main = fakeFrame('https://app.example/', { texts: ['Save'] });
    const editor = fakeFrame('https://editor.example/frame', { texts: ['Save'] });
    const r = await driverOn(main, editor).clickByText('Save');
    expect(r.success).toBe(true);
    expect(r.frame).toBeUndefined();
    expect(editor.clicked).toEqual([]);
  });

  it('a button in an iframe beats a plain-text mention on the page', async () => {
    const main = fakeFrame('https://app.example/', { plain: ['Select All'] });
    const editor = fakeFrame('https://editor.example/frame', { texts: ['Select All'] });
    const r = await driverOn(main, editor).clickByText('Select All');
    expect(r).toMatchObject({ success: true, method: 'js.clickByText', frame: 'https://editor.example/frame' });
    expect(main.clicked).toEqual([]);
    expect(editor.clicked).toEqual(['Select All']);
  });

  it('an iframe that detaches mid-search is skipped; a miss everywhere is NOT_FOUND and says what was searched', async () => {
    const r = await driverOn(fakeFrame('https://app.example/'), fakeFrame('about:blank', { detached: true }), fakeFrame('https://ads.example/'))
      .clickByText('Generate');
    expect(r.success).toBe(false);
    expect(r.error).toBe('no element found with text "Generate" in the page and its 2 iframes');
    expect(classifyResult(`browser_click failed: ${r.error}`, true, true)?.code).toBe('NOT_FOUND');
  });

  it('a hidden iframe is neither read nor clicked: its text is not on screen', async () => {
    const tracker = fakeFrame('https://tracker.example/x', { hidden: true, texts: ['Submit'], selectors: { body: 'secret' } });
    const d = driverOn(fakeFrame('https://app.example/', { selectors: { body: 'Outer page' } }), tracker);
    expect(await d.readText('body')).toBe('Outer page');
    expect(await d.clickByText('Submit')).toMatchObject({ success: false, error: 'no element found with text "Submit" in the page' });
    expect(tracker.clicked).toEqual([]);
  });

  it('an iframe that never answers is skipped, not waited on forever', async () => {
    const d = driverOn(fakeFrame('https://app.example/', { selectors: { body: 'Outer page' } }), fakeFrame('https://ads.example/', { hung: true }));
    expect(await d.readText('body')).toBe('Outer page');
    expect((await d.clickByText('Generate')).success).toBe(false);
  }, 10_000);

  it('typing by label reaches a field inside an iframe', async () => {
    const form = fakeFrame('https://forms.example/embed', { labels: ['Email'] });
    const r = await driverOn(fakeFrame('https://app.example/'), form).typeByLabel('Email', 'a@b.c');
    expect(r).toMatchObject({ success: true, frame: 'https://forms.example/embed' });
    expect(form.filled).toEqual(['Email']);
  });

  it('a selector action reaches an iframe: click, type and select', async () => {
    const form = fakeFrame('https://forms.example/embed', { selectors: { '#go': '', '#email': '', '#plan': '' }, options: ['pro'] });
    const d = driverOn(fakeFrame('https://app.example/'), form);
    expect(await d.click('#go')).toMatchObject({ success: true, method: 'js.click', frame: 'https://forms.example/embed' });
    expect(await d.typeInField('#email', 'a@b.c')).toMatchObject({ success: true, frame: 'https://forms.example/embed' });
    expect(await d.selectOption('#plan', 'pro')).toMatchObject({ success: true, frame: 'https://forms.example/embed' });
    expect(form.clicked).toEqual(['#go']);
    expect(form.filled).toEqual(['#email=a@b.c', '#plan=pro']);
  }, 10_000);

  it('a selector the page renders a moment later is used there, not a widget iframe\'s match', async () => {
    const page: Has = { selectors: {} };
    const main = fakeFrame('https://app.example/', page);
    const widget = fakeFrame('https://chat.example/widget', { selectors: { textarea: '' } });
    setTimeout(() => { page.selectors!.textarea = ''; }, 300);
    const r = await driverOn(main, widget).typeInField('textarea', 'my reply');
    expect(r.success).toBe(true);
    expect(r.frame).toBeUndefined();
    expect(main.filled).toEqual(['textarea=my reply']);
    expect(widget.filled).toEqual([]);
  });

  it('read_text adds each iframe\'s text, after the page\'s; a selector in no frame is reported missing', async () => {
    const d = driverOn(
      fakeFrame('https://app.example/', { selectors: { body: 'Outer page' } }),
      fakeFrame('https://editor.example/frame', { selectors: { body: '{ "a": 1 }' } }),
    );
    expect(await d.readText('body')).toBe('Outer page\n\n--- iframe https://editor.example/frame ---\n{ "a": 1 }');
    expect(await d.readText('#nope')).toBe('[element not found: #nope]');
  });

  it('read_text on a page longer than the limit says how many iframes it did not read', async () => {
    const d = driverOn(
      fakeFrame('https://app.example/', { selectors: { body: 'x'.repeat(5000) } }),
      fakeFrame('https://editor.example/frame', { selectors: { body: 'code' } }),
    );
    expect(await d.readText('body', 3000))
      .toBe(`${'x'.repeat(3000)}\n\n[+1 iframe not read: past the 3000-character limit. Read one with a selector inside it]`);
  });

  it('page_context lists an iframe\'s controls at page positions, offset by the iframe\'s own', async () => {
    const run = { tagName: 'button', text: 'Run', bounds: { x: 10, y: 20, width: 40, height: 20 } };
    const d = driverOn(fakeFrame('https://app.example/'), fakeFrame('https://editor.example/frame', { elements: [run], box: { x: 100, y: 200 } }));
    expect(await d.getPageContext()).toContain('IFRAME https://editor.example/frame (1; click / type / read_text reach these):\n  [button] "Run" @110,220\n');
  });

  it('page_context lists at most 60 iframe controls in all, and counts the rest', async () => {
    const els = Array.from({ length: 50 }, (_, i) => ({ tagName: 'a', text: `ad ${i}`, bounds: { x: 0, y: i, width: 1, height: 1 } }));
    const ads = ['a', 'b', 'c'].map(n => fakeFrame(`https://ads.example/${n}`, { elements: els }));
    const ctx = await driverOn(fakeFrame('https://app.example/'), ...ads).getPageContext();
    expect(ctx.match(/"ad \d+"/g)).toHaveLength(60);
    expect(ctx).toContain('+90 more in 2 iframes, not listed');
  });

  it('wait_for finds a selector that is visible only inside an iframe', async () => {
    const r = await driverOn(fakeFrame('https://app.example/'), fakeFrame('https://editor.example/frame', { selectors: { '#answer': '' } }))
      .waitForSelector('#answer', 1000);
    expect(r).toEqual({ success: true, frame: 'https://editor.example/frame' });
  });
});
