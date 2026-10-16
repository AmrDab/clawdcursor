/**
 * CDP ownership-by-port + attached-mode tab discipline (root-cause fix 2026-06-11).
 *
 * Incident: the dedicated agent instance and the user's browser shared port
 * 9223 — the driver couldn't tell whose browser it attached to, and in
 * attached mode it drove the user's most-recently-active tab (their playing
 * music tab got navigated away). The contract pinned here:
 *
 *   1. ensureConnected attaches on AGENT_CDP_PORT first → 'dedicated'.
 *   2. Falls back to the user port (constructor port) → 'attached'.
 *   3. In 'attached' mode, navigate() claims ONE new agent tab and drives it —
 *      the user's tabs are never navigated. Mechanical, not prompt-dependent.
 *   4. connect() encodes ownership from the port it connected to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── playwright mock ──────────────────────────────────────────────────────────
const state = {
  livePorts: new Set<number>(),
  userPage: null as any,
  newPages: [] as any[],
  cdpCalls: [] as string[],
};

function fakePage(url: string) {
  return {
    _url: url,
    _gotos: [] as string[],
    url() { return this._url; },
    isClosed() { return false; },
    async title() { return 'fake'; },
    async goto(u: string) { this._gotos.push(u); this._url = u; },
    async evaluate() { /* labeling no-op */ },
  };
}

vi.mock('playwright', () => ({
  chromium: {
    connectOverCDP: vi.fn(async (endpoint: string) => {
      const port = Number(new URL(endpoint).port);
      if (!state.livePorts.has(port)) throw new Error(`ECONNREFUSED ${port}`);
      return {
        contexts: () => [{
          pages: () => [state.userPage],
          newPage: async () => { const p = fakePage('about:blank'); state.newPages.push(p); return p; },
        }],
        isConnected: () => true,
        newBrowserCDPSession: async () => ({
          send: async (method: string) => {
            state.cdpCalls.push(method);
            return { processInfo: [{ type: 'renderer', id: 77 }, { type: 'browser', id: 4321 }] };
          },
          detach: async () => {},
        }),
      };
    }),
  },
}));

import { CDPDriver, agentBrowserArgs } from '../platform/cdp-driver';
import { AGENT_CDP_PORT, DEFAULT_CDP_PORT } from '../llm/browser-config';

beforeEach(() => {
  state.livePorts.clear();
  state.userPage = fakePage('https://www.youtube.com/watch?v=music');
  state.newPages.length = 0;
});

describe('CDPDriver — ownership is encoded in the port', () => {
  it('agent port and user port are actually different', () => {
    expect(AGENT_CDP_PORT).not.toBe(DEFAULT_CDP_PORT);
  });

  it('ensureConnected prefers the agent port → mode "dedicated"', async () => {
    state.livePorts.add(AGENT_CDP_PORT);
    state.livePorts.add(DEFAULT_CDP_PORT);   // user browser also on the wire
    const d = new CDPDriver();
    expect(await d.ensureConnected()).toBe(true);
    expect(d.getConnectionMode()).toBe('dedicated');
  });

  it('falls back to the user port → mode "attached"', async () => {
    state.livePorts.add(DEFAULT_CDP_PORT);
    const d = new CDPDriver();
    expect(await d.ensureConnected()).toBe(true);
    expect(d.getConnectionMode()).toBe('attached');
  });

  it('attach-only (no launch) with nothing on the wire → false', async () => {
    const d = new CDPDriver();
    expect(await d.ensureConnected()).toBe(false);
    expect(d.getConnectionMode()).toBe('unknown');
  });
});

describe('CDPDriver — attached mode never navigates the user\'s tab', () => {
  it('navigate() claims a NEW agent tab; the user page is never goto()ed', async () => {
    state.livePorts.add(DEFAULT_CDP_PORT);
    const d = new CDPDriver();
    await d.ensureConnected();
    expect(d.getConnectionMode()).toBe('attached');

    const r = await d.navigate('https://news.ycombinator.com');
    expect(r.success).toBe(true);
    // A new tab was created and navigated…
    expect(state.newPages.length).toBe(1);
    expect(state.newPages[0]._gotos).toEqual(['https://news.ycombinator.com']);
    // …and the user's tab was left exactly where it was.
    expect(state.userPage._gotos).toEqual([]);
    expect(state.userPage.url()).toContain('youtube.com');
  });

  it('subsequent navigations reuse the SAME agent tab (one tab, not tab spam)', async () => {
    state.livePorts.add(DEFAULT_CDP_PORT);
    const d = new CDPDriver();
    await d.ensureConnected();
    await d.navigate('https://example.com/one');
    await d.navigate('https://example.com/two');
    expect(state.newPages.length).toBe(1);
    expect(state.newPages[0]._gotos).toEqual(['https://example.com/one', 'https://example.com/two']);
  });

  it('dedicated mode navigates its own page directly (no extra tab)', async () => {
    state.livePorts.add(AGENT_CDP_PORT);
    state.userPage = fakePage('about:blank');   // fresh dedicated instance
    const d = new CDPDriver();
    await d.ensureConnected();
    expect(d.getConnectionMode()).toBe('dedicated');
    await d.navigate('https://example.com');
    expect(state.newPages.length).toBe(0);
    expect(state.userPage._gotos).toEqual(['https://example.com']);
  });
});

describe('agent-owned browser launch flags', () => {
  it('Linux: the agent browser exposes its page to AT-SPI (--force-renderer-accessibility)', () => {
    const args = agentBrowserArgs('/home/u/.clawdcursor/cdp-profile', 'linux');
    expect(args).toContain('--force-renderer-accessibility');
    expect(args).toContain(`--remote-debugging-port=${AGENT_CDP_PORT}`);
    expect(args).toContain('--user-data-dir=/home/u/.clawdcursor/cdp-profile');
    expect(args[args.length - 1]).toBe('about:blank');
  });

  it('macOS: the page is exposed from launch too — Chromium builds it only when asked, and the wake never fired (#234)', () => {
    expect(agentBrowserArgs('/Users/u/.clawdcursor/cdp-profile', 'darwin')).toContain('--force-renderer-accessibility');
  });

  it('Windows: not forced — Chromium turns UIA on when a UIA client asks', () => {
    expect(agentBrowserArgs('p', 'win32')).not.toContain('--force-renderer-accessibility');
  });
});

describe('getBrowserPid (#235)', () => {
  it("reports the browser process's pid from SystemInfo.getProcessInfo, once per connection", async () => {
    state.livePorts.add(AGENT_CDP_PORT);
    state.cdpCalls.length = 0;
    const d = new CDPDriver();
    expect(await d.getBrowserPid()).toBeNull();            // not connected yet
    await d.ensureConnected();
    expect(await d.getBrowserPid()).toBe(4321);             // the browser process, not a renderer
    expect(await d.getBrowserPid()).toBe(4321);
    expect(state.cdpCalls).toEqual(['SystemInfo.getProcessInfo']);
  });
});
