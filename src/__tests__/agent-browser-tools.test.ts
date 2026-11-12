/**
 * browser_* in the agent-loop catalog — the CDP/DOM web-automation path
 * (dedicated agent-owned browser, driven by selector/text, no pixels).
 * The CDPDriver is mocked so these run OS-agnostically and never launch a
 * real browser. Asserts the happy paths AND graceful degradation to OCR
 * when CDP is absent or not connected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext } from '../core/agent-loop/types';

const tool = (name: string) => buildUnifiedTools().find(t => t.name === name)!;

/** A mock CDPDriver exposing only the methods the browser_* tools call. */
function mockCdp(overrides: Partial<Record<string, any>> = {}) {
  return {
    ensureConnected: vi.fn(async () => true),
    isConnected: vi.fn(async () => true),
    getUrl: vi.fn(async () => 'https://www.youtube.com/'),
    getTitle: vi.fn(async () => 'YouTube'),
    navigate: vi.fn(async (url: string) => ({ success: true, method: 'goto', value: url })),
    getPageContext: vi.fn(async () => 'PAGE: "YouTube"\nINTERACTIVE ELEMENTS:\n- input#search\n- button "Search"'),
    readText: vi.fn(async () => 'some page text'),
    clickByText: vi.fn(async () => ({ success: true, method: 'text' })),
    click: vi.fn(async () => ({ success: true, method: 'selector' })),
    typeInField: vi.fn(async () => ({ success: true, method: 'fill' })),
    typeByLabel: vi.fn(async () => ({ success: true, method: 'label' })),
    getConnectError: vi.fn(() => ''),
    ...overrides,
  };
}

function ctx(cdp: any): AgentToolContext {
  return {
    platform: { platform: 'win32' } as any,
    task: 'open youtube and play a song',
    mode: 'blind',
    screen: { logicalWidth: 2560, logicalHeight: 1440, physicalWidth: 2560, physicalHeight: 1440, dpiRatio: 1 },
    screenshotsCaptured: { n: 0 },
    cdp,
  };
}

const ENV = process.env.CLAWD_AGENT_CDP_OFF;
beforeEach(() => { delete process.env.CLAWD_AGENT_CDP_OFF; });
afterEach(() => { if (ENV === undefined) delete process.env.CLAWD_AGENT_CDP_OFF; else process.env.CLAWD_AGENT_CDP_OFF = ENV; });

describe('browser_connect', () => {
  it('connects (launching when allowed) and reports url/title', async () => {
    const cdp = mockCdp();
    const r = await tool('browser_connect').execute({}, ctx(cdp));
    expect(r.success).toBe(true);
    expect(cdp.ensureConnected).toHaveBeenCalledWith(expect.objectContaining({ launch: true }));
    expect(r.text).toMatch(/YouTube/);
  });

  it('degrades gracefully when CDP is not wired (null) — points to OCR', async () => {
    const r = await tool('browser_connect').execute({}, ctx(null));
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/read_text|smart_click/i);
  });

  it('CLAWD_AGENT_CDP_OFF=1 → attach-only (never launches a new instance)', async () => {
    process.env.CLAWD_AGENT_CDP_OFF = '1';
    const cdp = mockCdp({
      ensureConnected: vi.fn(async () => false),
      getConnectError: vi.fn(() => 'nothing is listening on port 9223 (ECONNREFUSED)'),
    });
    const r = await tool('browser_connect').execute({}, ctx(cdp));
    expect(cdp.ensureConnected).toHaveBeenCalledWith(expect.objectContaining({ launch: false }));
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/attach/i);
    // Says why, and what to do about a browser that is still starting (#378).
    expect(r.text).toContain('nothing is listening on port 9223 (ECONNREFUSED)');
    expect(r.text).toMatch(/connect again in a few seconds; it must run with --remote-debugging-port=9223/);
  });
});

describe('browser_navigate / read / click / type', () => {
  it('navigate loads the url when connected', async () => {
    const cdp = mockCdp();
    const r = await tool('browser_navigate').execute({ url: 'https://www.youtube.com' }, ctx(cdp));
    expect(r.success).toBe(true);
    expect(cdp.navigate).toHaveBeenCalledWith('https://www.youtube.com');
  });

  it('every browser_* action refuses (no throw) when not connected → tells model to connect', async () => {
    const cdp = mockCdp({ isConnected: vi.fn(async () => false) });
    for (const name of ['browser_navigate', 'browser_read', 'browser_click', 'browser_type']) {
      const args = name === 'browser_navigate' ? { url: 'x' } : name === 'browser_type' ? { text: 'x', selector: '#a' } : name === 'browser_click' ? { text: 'x' } : {};
      const r = await tool(name).execute(args, ctx(cdp));
      expect(r.success).toBe(false);
      expect(r.text).toMatch(/browser_connect/);
    }
  });

  it('read returns structured DOM (interactive elements) and does not change the screen', async () => {
    const cdp = mockCdp();
    const r = await tool('browser_read').execute({}, ctx(cdp));
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/INTERACTIVE ELEMENTS/);
    expect(tool('browser_read').changesScreen).toBe(false);
    expect(cdp.getPageContext).toHaveBeenCalled();
  });

  it('click by visible text uses clickByText; failure nudges to browser_read', async () => {
    const ok = mockCdp();
    expect((await tool('browser_click').execute({ text: 'Search' }, ctx(ok))).success).toBe(true);
    expect(ok.clickByText).toHaveBeenCalledWith('Search', Infinity, undefined);

    const bad = mockCdp({ clickByText: vi.fn(async () => ({ success: false, error: 'not found' })) });
    const r = await tool('browser_click').execute({ text: 'Nope' }, ctx(bad));
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/browser_read/);
  });

  it('type requires a selector or label', async () => {
    const cdp = mockCdp();
    const r = await tool('browser_type').execute({ text: 'adele' }, ctx(cdp));
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/selector or label/i);
    const ok = await tool('browser_type').execute({ text: 'adele', selector: '#search' }, ctx(cdp));
    expect(ok.success).toBe(true);
    expect(cdp.typeInField).toHaveBeenCalledWith('#search', 'adele', undefined);
  });
});
