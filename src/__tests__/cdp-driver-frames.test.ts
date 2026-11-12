/**
 * The browser tool searches iframes too (#398): document.querySelector and page locators stop at an iframe's edge, so a
 * control inside an editor iframe was "not found" by click / type / read_text / wait_for. The main frame is still searched
 * first, exactly as before; an iframe is searched only when the page itself has no match. A fake Playwright page: no browser.
 */
import { describe, it, expect } from 'vitest';
import { CDPDriver } from '../platform/cdp-driver';
import { classifyResult } from '../core/result-codes';

/** A frame holding clickable `texts`, `selectors` (selector → its text) and `labels`; evaluate is answered by what it asks. */
function fakeFrame(url: string, has: { texts?: string[]; selectors?: Record<string, string>; labels?: string[]; detached?: boolean } = {}) {
  const f = {
    url: () => url,
    name: () => '',
    clicked: [] as string[],
    filled: [] as string[],
    async evaluate(fn: unknown, arg: string) {
      if (has.detached) throw new Error('Frame was detached');
      const src = String(fn);
      if (src.includes('searchText')) {                 // clickByText's JS pass
        const hit = (has.texts ?? []).includes(arg);
        if (hit) f.clicked.push(arg);
        return hit;
      }
      if (src.includes('innerText')) return has.selectors?.[arg] ?? null;   // readText
      if (src.includes('searchLabel')) return null;     // findFieldByLabel's own finder
      throw new Error(`unexpected evaluate: ${src.slice(0, 60)}`);
    },
    getByRole: () => none(),
    getByText: () => none(),
    getByLabel: (label: string) => (has.labels ?? []).includes(label) ? some(() => f.filled.push(label)) : none(),
    locator: (sel: string) => (sel in (has.selectors ?? {})) ? some(() => {}) : none(),
  };
  return f;
}
function none() {
  return { count: async () => 0, first: () => ({ isVisible: async () => false, boundingBox: async () => null }) };
}
function some(onFill: () => void) {
  const el = { isVisible: async () => true, boundingBox: async () => null, fill: async () => { onFill(); }, click: async () => {} };
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

  it('an iframe that detaches mid-search is skipped; a miss everywhere is NOT_FOUND and says what was searched', async () => {
    const r = await driverOn(fakeFrame('https://app.example/'), fakeFrame('about:blank', { detached: true }), fakeFrame('https://ads.example/'))
      .clickByText('Generate');
    expect(r.success).toBe(false);
    expect(r.error).toBe('no element found with text "Generate" in the page and its 2 iframes');
    expect(classifyResult(`browser_click failed: ${r.error}`, true, true)?.code).toBe('NOT_FOUND');
  });

  it('typing by label reaches a field inside an iframe', async () => {
    const form = fakeFrame('https://forms.example/embed', { labels: ['Email'] });
    const r = await driverOn(fakeFrame('https://app.example/'), form).typeByLabel('Email', 'a@b.c');
    expect(r).toMatchObject({ success: true, frame: 'https://forms.example/embed' });
    expect(form.filled).toEqual(['Email']);
  });

  it('read_text adds each iframe\'s text, after the page\'s; a selector in no frame is reported missing', async () => {
    const d = driverOn(
      fakeFrame('https://app.example/', { selectors: { body: 'Outer page' } }),
      fakeFrame('https://editor.example/frame', { selectors: { body: '{ "a": 1 }' } }),
    );
    expect(await d.readText('body')).toBe('Outer page\n\n--- iframe https://editor.example/frame ---\n{ "a": 1 }');
    expect(await d.readText('#nope')).toBe('[element not found: #nope]');
  });

  it('wait_for finds a selector that is visible only inside an iframe', async () => {
    const r = await driverOn(fakeFrame('https://app.example/'), fakeFrame('https://editor.example/frame', { selectors: { '#answer': '' } }))
      .waitForSelector('#answer', 1000);
    expect(r).toEqual({ success: true, frame: 'https://editor.example/frame' });
  });
});
