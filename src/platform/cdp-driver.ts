/**
 * CDPDriver — Chrome DevTools Protocol driver for browser DOM interaction.
 *
 * This solves the "Gmail compose problem" and similar web-app challenges:
 * Windows UI Automation sees browser content as a monolithic "Document" or
 * "Pane" element — it can't reach individual DOM elements like input fields,
 * buttons, or content-editable divs inside web pages.
 *
 * CDPDriver connects to Chrome/Edge via the DevTools Protocol and provides:
 *   - DOM element queries by CSS selector, XPath, ARIA role, text content
 *   - Click, type, focus, select on DOM elements
 *   - Form filling by label text (finds the input associated with a label)
 *   - Page state queries (URL, title, ready state)
 *   - Script evaluation for custom interactions
 *
 * Architecture:
 *   ┌─────────────────────────────┐
 *   │   UIDriver (native UI)      │  ← Windows UI Automation
 *   ├─────────────────────────────┤
 *   │   CDPDriver (browser DOM)   │  ← This module (CDP)
 *   ├─────────────────────────────┤
 *   │   Browser tools (CDP)       │  ← Pipeline browser MCP surface
 *   └─────────────────────────────┘
 *
 * Connection:
 *   Edge/Chrome must be launched with --remote-debugging-port=9223
 *   Or connect to an existing Playwright-managed browser's CDP endpoint.
 *
 * Usage:
 *   const cdp = new CDPDriver();
 *   await cdp.connect();  // connects to Edge/Chrome on port 9223
 *
 *   // Click a button by text
 *   await cdp.clickByText('Compose');
 *
 *   // Type into a Gmail field
 *   await cdp.typeInField('[aria-label="To"]', 'user@example.com');
 *
 *   // Fill a form by label
 *   await cdp.fillFormByLabels({ 'Subject': 'Hello', 'To': 'user@example.com' });
 *
 *   // Query elements
 *   const results = await cdp.querySelectorAll('button');
 */

import { chromium, type Browser, type Frame, type Locator, type Page } from 'playwright';
import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AGENT_CDP_PORT } from './browser-config';
import { fenceCdpOnly } from '../core/fence';
import { guardInputMethods } from './pointer-guard';

// ── Default CDP port — matches browser-config.ts and tool launch flags ──
const DEFAULT_CDP_PORT = 9223;
/** How long an attach-only connect waits for the user's browser to open its port: a host may start it seconds before (#378). */
const ATTACH_WAIT_MS = 10_000;

/** Wait until something answers on a CDP port, or `ms` pass: a browser takes seconds to open its port after it starts. */
async function waitForCdp(port: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const up = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      .then(() => true, () => false);
    if (up) return;
    await new Promise(r => setTimeout(r, 400));
  }
}

/** Why attaching to `port` failed, from what (if anything) answers there (#378). */
async function whyNoCdp(port: number, err: unknown): Promise<string> {
  let info: { webSocketDebuggerUrl?: string } | null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    info = res.ok ? await res.json().catch(() => null) : null;
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code;
    return code === 'ECONNREFUSED'
      ? `nothing is listening on port ${port} (ECONNREFUSED)`
      : `port ${port} did not answer (${code ?? (e instanceof Error ? e.message : String(e))})`;
  }
  if (!info?.webSocketDebuggerUrl) {
    return `port ${port} answers, but not as a Chromium DevTools endpoint (another program, or a browser that is not Chrome/Edge/Chromium)`;
  }
  const msg = (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200);
  return `the browser on port ${port} did not accept the attach: ${msg}`;
}

// ── Types ──

/** Information about a DOM element */
export interface DOMElementInfo {
  /** CSS selector that uniquely identifies this element */
  selector: string;
  /** Tag name (e.g. 'button', 'input', 'div') */
  tagName: string;
  /** Inner text content (truncated) */
  text: string;
  /** Element's id attribute */
  id: string;
  /** Element's class attribute */
  className: string;
  /** ARIA role */
  role: string;
  /** ARIA label */
  ariaLabel: string;
  /** Input type (for input elements) */
  type: string;
  /** Placeholder text */
  placeholder: string;
  /** Element's name attribute */
  name: string;
  /** Bounding rect in viewport coordinates */
  bounds: { x: number; y: number; width: number; height: number };
  /** Whether the element is visible */
  isVisible: boolean;
  /** Whether the element is enabled (not disabled) */
  isEnabled: boolean;
}

/** Result of a CDP interaction */
export interface CDPInteractionResult {
  success: boolean;
  method?: string;
  value?: string;
  error?: string;
  /** Number of elements matched (for queries) */
  matchCount?: number;
  /** Reads the element the act went to, as it shows now (#399): what the caller checks the act against. */
  read?: () => Promise<FieldShown | null>;
  /** URL of the iframe the element was found in; absent for the page itself (#398). */
  frame?: string;
}

/** What a form element shows: `value` its text (a <select>: the chosen option's label, `option` its value). */
export interface FieldShown { value?: string; option?: string; readable?: boolean; secure?: boolean }

/**
 * Read a form element in the page: an input's / textarea's value, a <select>'s chosen option(s), an editable element's text.
 * A password input is withheld. Null when it cannot be read (gone, not a form element). Never throws.
 */
function readerOf(locator: Locator): () => Promise<FieldShown | null> {
  return () => locator.evaluate((el: any) => {
    if (el.type === 'password') return { secure: true };
    if (el.tagName === 'SELECT') {
      const o: any[] = Array.from(el.selectedOptions);
      return { value: o.map(x => x.label).join(', '), option: o.map(x => x.value).join(', '), readable: true };
    }
    if (typeof el.value === 'string') return { value: el.value, readable: true };
    return el.isContentEditable ? { value: String(el.innerText ?? ''), readable: true } : null;
  }, undefined, { timeout: 1000 }).catch(() => null);
}

/**
 * CDPDriver — interact with web page DOM elements via Chrome DevTools Protocol.
 *
 * Uses Playwright's CDP connection under the hood, so it works with any
 * Chromium-based browser launched with --remote-debugging-port. You can
 * also share a Page object directly.
 */
/**
 * Launch flags for the agent's OWN dedicated browser (never the user's).
 * On Linux Chromium only builds its renderer accessibility tree for AT-SPI
 * when started with --force-renderer-accessibility; without it read_tree /
 * find / invoke saw no page content at all in the agent's browser. macOS is
 * the same in practice (#234): the page tree is built only once an AX client
 * asks, and read_tree / find saw only the window's toolbar and tab strip.
 * Windows is left on demand: Chromium turns its UIA tree on when a UIA client
 * asks for it, so every page doesn't pay for a tree nobody reads.
 */
export function agentBrowserArgs(profileDir: string, platform: NodeJS.Platform = process.platform): string[] {
  return [
    `--remote-debugging-port=${AGENT_CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // A fresh --user-data-dir profile has no saved window bounds, so Chromium
    // opens at a small default size — the agent's browser came up as a tiny
    // window (session 2026-06-11). Start maximized so screenshots/coords have
    // the full viewport and the window is usable.
    '--start-maximized',
    ...(platform === 'linux' || platform === 'darwin' ? ['--force-renderer-accessibility'] : []),
    '--new-window',
    'about:blank',
  ];
}

/**
 * Seed the agent's OWN profile before launch (never the user's browser): Chrome
 * sign-in disallowed. On a fresh profile Chrome otherwise showed a focused
 * "Sign in to Chrome?" bubble — it could swallow the agent's keystrokes, and
 * "Continue as …" would sign the automation profile in to the user's Google
 * account (#236). Chrome recomputes `signin.allowed` from
 * `signin.allowed_on_next_startup` at every start, so both are written; with
 * sign-in disallowed Chrome turns off the web sign-in interception that shows
 * the bubble. Other prefs are kept; an unreadable file is left alone.
 */
export function seedAgentProfile(profileDir: string): void {
  const file = path.join(profileDir, 'Default', 'Preferences');
  let prefs: Record<string, any> = {};
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // A fresh profile has no file yet; anything else is not ours to repair.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return;
  }
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return;
  prefs.signin = { ...(prefs.signin ?? {}), allowed: false, allowed_on_next_startup: false };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(prefs));
  } catch { /* best-effort: the browser still launches */ }
}

export class CDPDriver {
  private browser: Browser | null = null;
  private activePage: Page | null = null;
  private connected = false;
  private cdpPort: number;
  private ownsBrowser = false; // true if we created the browser connection
  private cursorInjected = false;
  // Provenance of the current connection, for honest disclosure to the agent:
  //  'dedicated' — we spawned a private --user-data-dir instance the agent owns.
  //  'attached'  — we connected to a browser ALREADY on the debug port, which
  //                may be the user's own session (navigation affects THEIR tabs).
  //  'unknown'   — not yet connected.
  private connectionMode: 'dedicated' | 'attached' | 'unknown' = 'unknown';
  // In 'attached' mode (someone else's browser), the agent must never drive the
  // user's existing tabs. The first navigate() opens the agent's OWN tab and all
  // subsequent work happens there. Mechanical — not dependent on the model
  // honoring the disclosure text (root-cause fix 2026-06-11).
  private agentTab: Page | null = null;

  /** How the live connection was established (see connectionMode). */
  getConnectionMode(): 'dedicated' | 'attached' | 'unknown' { return this.connectionMode; }

  private connectError = '';
  /** Why the last connect / ensureConnected failed, in words an agent can act on (#378); '' once connected. */
  getConnectError(): string { return this.connectError; }

  private pidCache: { browser: Browser; pid: number | null } | null = null;

  /**
   * OS process id of the connected browser (the process that owns its
   * windows), from CDP's SystemInfo.getProcessInfo; null when not connected or
   * the browser doesn't say. Lets the accessibility tools recognise the window
   * this driver can read over CDP (#235). Cached per connection.
   */
  async getBrowserPid(): Promise<number | null> {
    const browser = this.browser;
    if (!browser || !this.connected) return null;
    if (this.pidCache?.browser === browser) return this.pidCache.pid;
    let pid: number | null = null;
    try {
      const session = await browser.newBrowserCDPSession();
      try {
        const info = await session.send('SystemInfo.getProcessInfo') as { processInfo?: Array<{ type: string; id: number }> };
        const proc = info.processInfo?.find(p => p.type === 'browser');
        pid = typeof proc?.id === 'number' && proc.id > 0 ? proc.id : null;
      } finally {
        await session.detach().catch(() => { /* already gone */ });
      }
    } catch { /* older browser / not Chromium: unknown */ }
    this.pidCache = { browser, pid };
    return pid;
  }

  /**
   * @param cdpPort CDP debugging port (default 9223)
   */
  constructor(cdpPort = DEFAULT_CDP_PORT) {
    this.cdpPort = cdpPort;
    // Page actions: refused once the user stops clawdcursor, and recorded as acts in the browser's process (pointer-guard.ts).
    guardInputMethods(this, () => this.getBrowserPid());
  }

  // ════════════════════════════════════════════════════════════════════
  // CONNECTION
  // ════════════════════════════════════════════════════════════════════

  /**
   * Connect to an existing Chrome/Edge instance via CDP.
   *
   * The browser must be launched with:
   *   msedge.exe --remote-debugging-port=9223
   *   chrome.exe --remote-debugging-port=9223
   *
   * @param port Override the port for this attempt (defaults to the
   *   constructor port). Ownership is encoded in the port: AGENT_CDP_PORT is
   *   only ever used by our own dedicated-profile launcher, so connecting
   *   there means 'dedicated'; any other port means we attached to a browser
   *   someone else put on the wire → 'attached'.
   * @returns true if connected successfully
   */
  async connect(port?: number): Promise<boolean> {
    const targetPort = port ?? this.cdpPort;
    // The test fence (core/fence.ts): only the agent's own port, never a browser the user put on the wire.
    const only = fenceCdpOnly(AGENT_CDP_PORT);
    if (only !== undefined && targetPort !== only) {
      this.connectError = `port ${targetPort} is closed to clawdcursor by the test fence (only the agent's own browser on port ${only} may be driven)`;
      return false;
    }
    try {
      this.browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${targetPort}`,
        { timeout: 15000 },
      );
      this.ownsBrowser = true;
      this.connectionMode = targetPort === AGENT_CDP_PORT ? 'dedicated' : 'attached';
      this.agentTab = null;   // fresh connection → no agent tab claimed yet

      // Get the most relevant tab — search ALL browser contexts (not just the first)
      // Priority: user-navigated pages > pinned/system widgets > browser internal pages
      const BLOCKED_URL_PATTERNS = [
        'edge://', 'chrome://', 'about:',
        // Known OEM/vendor widget pages that embed browsers as system components
        'vantage.csw.lenovo.com', 'lenovo.com/widget',
        'msn.com/spartan', 'bing.com/widget',
        'ntp.msn.com',
      ];
      const isUserPage = (url: string) =>
        url.startsWith('http') &&
        !BLOCKED_URL_PATTERNS.some(blocked => url.includes(blocked));

      const contexts = this.browser.contexts();
      const allPages: Page[] = contexts.flatMap(ctx => ctx.pages());
      const userPages = allPages.filter(p => isUserPage(p.url()));
      // Extension/devtools pages (e.g. a wallet's background UI) are never the
      // page the agent means — prefer anything else before falling back to them.
      const INTERNAL = ['edge://', 'chrome://', 'about:', 'chrome-extension://', 'extension://', 'devtools://'];
      const fallbackPage = allPages.find(p => !INTERNAL.some(s => p.url().startsWith(s)))
        ?? allPages.find(p => p.url().startsWith('about:'))
        ?? allPages[0] ?? null;

      // Among user pages, prefer the last one (most recently opened/navigated)
      this.activePage = userPages.length > 0
        ? userPages[userPages.length - 1]
        : fallbackPage;

      if (!this.activePage) {
        console.warn('   ⚠️ CDPDriver: connected but no pages found');
        this.connectError = `the browser on port ${targetPort} has no open page`;
        return false;
      }

      this.connected = true;
      this.connectError = '';
      const title = await this.activePage.title().catch(() => '(unknown)');
      console.log(`   🔌 CDPDriver: connected to "${title}" at ${this.activePage.url()}`);
      return true;
    } catch (err) {
      console.log(`   ❌ CDPDriver: failed to connect to CDP port ${targetPort}: ${err}`);
      this.connectError = await whyNoCdp(targetPort, err);
      return false;
    }
  }

  /**
   * Ensure a CDP connection exists WITHOUT disturbing the user's own browser.
   *
   * Ownership is encoded in the PORT (root-cause fix 2026-06-11 — a single
   * shared port meant the driver could not tell its own dedicated instance
   * from the user's browser, and a lingering agent instance the user had
   * adopted got its tabs hijacked):
   *
   *   1. Already connected → done.
   *   2. Attach on AGENT_CDP_PORT — only our own dedicated-profile launcher
   *      ever uses that port, so this is OUR instance → 'dedicated'.
   *   3. Attach on the user port (constructor port, default 9223) — a browser
   *      the USER put on the wire (their own flags, relaunch_with_cdp, the
   *      relay) → 'attached'; navigation gets new-tab discipline.
   *   4. If `launch` is allowed, spawn the SYSTEM browser on AGENT_CDP_PORT
   *      with a dedicated `--user-data-dir`. Chromium keys its single-instance
   *      lock on the profile directory, so this starts a SEPARATE process that
   *      never closes or reuses the user's windows. The blank tab is labeled
   *      "ClawdCursor — agent browser" so the window is recognizable and
   *      doesn't get silently adopted as a personal browser.
   *
   * Connecting stays quiet: nothing is raised here. navigate() is what brings
   * the browser window to the front (#277).
   *
   * @param opts.launch   Allow launching a dedicated instance (default false → attach-only).
   * @param opts.exePaths Candidate browser executables, in priority order.
   */
  async ensureConnected(opts: { launch?: boolean; exePaths?: string[] } = {}): Promise<boolean> {
    if (await this.isConnected()) return true;
    // 2. Our own dedicated instance from a previous run, if it's still alive.
    if (await this.connect(AGENT_CDP_PORT)) return true;       // → 'dedicated'
    // 3. A browser the user put on the debug port. Attach-only has nothing to fall back to, and the host may have
    //    started that browser seconds ago: give its port a bounded wait before giving up (#378).
    const fenced = fenceCdpOnly(AGENT_CDP_PORT) !== undefined;
    if (!opts.launch && !fenced) await waitForCdp(this.cdpPort, ATTACH_WAIT_MS);
    if (await this.connect(this.cdpPort)) return true;         // → 'attached'
    if (!opts.launch || fenced) return false;   // fenced: launch nothing

    const exe = (opts.exePaths ?? []).find(p => {
      try { return fs.existsSync(p); } catch { return false; }
    });
    if (!exe) {
      console.log('   ❌ CDPDriver: no browser executable found to launch with CDP');
      this.connectError = 'no browser on the debug port, and no Chrome or Edge executable was found to launch';
      return false;
    }

    // Dedicated profile dir → a separate Chromium instance that won't touch
    // the user's running browser.
    const profileDir = path.join(os.homedir(), '.clawdcursor', 'cdp-profile');
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* best-effort */ }
    seedAgentProfile(profileDir);

    try {
      const child = spawn(exe, agentBrowserArgs(profileDir), { stdio: 'ignore', detached: true });
      child.unref();
    } catch (err) {
      console.log(`   ❌ CDPDriver: failed to spawn browser with CDP: ${err}`);
      this.connectError = `could not start ${exe}: ${err}`;
      return false;
    }

    await waitForCdp(AGENT_CDP_PORT, 12_000);
    // We spawned a dedicated --user-data-dir instance — the agent owns it.
    const ok = await this.connect(AGENT_CDP_PORT);
    if (ok) await this.labelAgentBrowser();
    return ok;
  }

  /**
   * Stamp the dedicated instance's blank tab so the WINDOW is identifiable in
   * the taskbar / Alt-Tab as the agent's, not a second personal browser. The
   * 2026-06-11 incident started exactly this way: an unlabeled agent instance
   * lingered, the user adopted it for music, and a later attach drove their tab.
   */
  private async labelAgentBrowser(): Promise<void> {
    try {
      const pg = this.activePage;
      if (!pg || !pg.url().startsWith('about:')) return;
      await pg.evaluate(() => {
        document.title = 'ClawdCursor — agent browser';
        document.body.innerHTML =
          '<div style="font-family:system-ui;padding:40px;color:#444">' +
          '<h2 style="margin:0 0 8px">🐾 ClawdCursor — agent browser</h2>' +
          '<p>This window belongs to the clawdcursor agent (dedicated profile, port-isolated from your own browser).<br>' +
          'You can minimize it; closing it just makes the agent launch a fresh one next time.</p></div>';
      });
    } catch { /* cosmetic only — never fail the connection over it */ }
  }

  /**
   * Navigate the active page to a URL (waits for DOM content to load), then
   * raise the browser so the person at the screen sees what the agent drives.
   */
  async navigate(url: string): Promise<CDPInteractionResult> {
    // ATTACHED mode = someone else's browser (likely the user's session). The
    // agent must not commandeer whatever tab the user last touched — claim ONE
    // tab of our own on first navigation and stay in it. Mechanical, so it
    // holds even when the model ignores the disclosure text.
    if (this.connectionMode === 'attached' && this.browser) {
      try {
        if (!this.agentTab || this.agentTab.isClosed()) {
          const ctx = this.browser.contexts()[0];
          this.agentTab = await ctx.newPage();
          console.log('   🗂 CDPDriver: attached mode — opened a dedicated agent tab (user tabs untouched)');
        }
        this.activePage = this.agentTab;
      } catch { /* tab creation failed — fall back to the current page */ }
    }
    const pg = this.requirePage();
    try {
      await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.raiseWindow(pg);
      return { success: true, method: 'goto', value: pg.url() };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Bring the page's tab, then its OS window, to the front (#277): CDP works
   * whatever the z-order, so the browser otherwise stayed hidden behind other
   * apps. Page.bringToFront only selects the tab; the window is raised through
   * the platform adapter by the connected browser's pid, since the user's own
   * Chrome and the agent's can run side by side. Never throws: a failed raise
   * must not fail the navigation.
   */
  private async raiseWindow(pg: Page): Promise<void> {
    try {
      // A pause that came up while the page loaded has the user's keyboard (its reply box): never raise over it.
      const [{ pauseGate }, { foreignOverlayState }] = await Promise.all([import('../core/pause-gate'), import('../core/overlay-state')]);
      if (pauseGate.current() || foreignOverlayState().paused) return;
      await pg.bringToFront();
      const pid = await this.getBrowserPid();
      if (pid === null) return;
      const { getPlatform } = await import('./index');
      if (!(await (await getPlatform()).focusWindow({ processId: pid }))) {
        console.warn(`   ⚠️ CDPDriver: could not raise the browser window (pid ${pid})`);
      }
    } catch (err) {
      console.warn(`   ⚠️ CDPDriver: could not raise the browser window: ${err}`);
    }
  }

  /**
   * Attach to an existing Playwright Page object.
   * Use this when an outer caller already holds a CDP connection — avoid duplicate CDP connections.
   */
  attachToPage(page: Page): void {
    this.activePage = page;
    this.connected = true;
    this.ownsBrowser = false;
    // An externally supplied page is by definition not our dedicated instance.
    this.connectionMode = 'attached';
    console.log(`   🔌 CDPDriver: attached to existing page`);
  }

  /**
   * Switch to a tab whose URL contains the given substring.
   * Useful after navigation when the agent needs to find a specific page.
   */
  async switchToTabByUrl(urlSubstring: string): Promise<boolean> {
    if (!this.browser) return false;
    try {
      const contexts = this.browser.contexts();
      for (const ctx of contexts) {
        for (const page of ctx.pages()) {
          const pageUrl = page.url().toLowerCase();
          if (pageUrl.includes(urlSubstring.toLowerCase())) {
            this.activePage = page;
            this.cursorInjected = false; // Reset — new page doesn't have our overlay
            await page.bringToFront().catch(() => {});
            const title = await page.title().catch(() => '(unknown)');
            console.log(`   🔌 CDPDriver: switched to tab "${title}" at ${page.url()}`);
            return true;
          }
        }
      }
      return false;
    } catch (err) {
      console.debug(`[CDPDriver] switchToTabByUrl failed: ${err}`);
      return false;
    }
  }

  /** Check if we're connected and the page is still alive */
  async isConnected(): Promise<boolean> {
    if (!this.connected || !this.activePage) return false;
    try {
      await this.activePage.title(); // Health check
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }

  /** Tabs of the CONNECTED browser (whichever port/instance that is), active one flagged. */
  async listTabs(): Promise<Array<{ url: string; title: string; active: boolean }>> {
    if (!this.browser) return [];
    const tabs: Array<{ url: string; title: string; active: boolean }> = [];
    for (const context of this.browser.contexts()) {
      for (const page of context.pages()) {
        const title = await page.title().catch(() => '(unknown)');
        tabs.push({ url: page.url(), title, active: page === this.activePage });
      }
    }
    return tabs;
  }

  /**
   * Switch to a different tab by URL substring or title substring.
   */
  async switchTab(urlOrTitleSubstring: string): Promise<boolean> {
    if (!this.browser) return false;

    const lower = urlOrTitleSubstring.toLowerCase();

    for (const context of this.browser.contexts()) {
      for (const page of context.pages()) {
        try {
          const url = page.url().toLowerCase();
          const title = (await page.title()).toLowerCase();
          if (url.includes(lower) || title.includes(lower)) {
            this.activePage = page;
            this.cursorInjected = false; // Reset — new page doesn't have our overlay
            await page.bringToFront();
            console.log(`   🔌 CDPDriver: switched to tab "${await page.title()}"`);
            return true;
          }
        } catch (err) {
          console.debug(`[CDPDriver] Tab switch attempt failed: ${err}`);
          continue;
        }
      }
    }

    return false;
  }

  // ════════════════════════════════════════════════════════════════════
  // ELEMENT QUERIES
  // ════════════════════════════════════════════════════════════════════

  /**
   * Query elements by CSS selector.
   * Returns info about all matching elements.
   */
  async querySelectorAll(selector: string, maxResults = 20): Promise<DOMElementInfo[]> {
    const pg = this.requirePage();

    return pg.evaluate(
      (args: { sel: string; max: number }) => {
        const elements = document.querySelectorAll(args.sel);
        const infos: any[] = [];

        for (let i = 0; i < Math.min(elements.length, args.max); i++) {
          const el = elements[i] as HTMLElement;
          const rect = el.getBoundingClientRect();

          // Generate a unique CSS selector inside evaluate where we have DOM access
          let selector: string;
          if (el.id) {
            selector = `#${el.id}`;
          } else {
            const testId = el.getAttribute('data-testid');
            if (testId) {
              selector = `[data-testid="${testId}"]`;
            } else {
              // Calculate correct nth-of-type among siblings
              const parent = el.parentElement;
              if (parent) {
                let typeIndex = 0;
                for (const sibling of parent.children) {
                  if (sibling.tagName === el.tagName) {
                    typeIndex++;
                    if (sibling === el) break;
                  }
                }
                selector = `${el.tagName.toLowerCase()}:nth-of-type(${typeIndex})`;
              } else {
                selector = el.tagName.toLowerCase();
              }
            }
          }

          infos.push({
            selector,
            tagName: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().substring(0, 100),
            id: el.id || '',
            className: typeof el.className === 'string' ? el.className : '',
            role: el.getAttribute('role') || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            type: (el as HTMLInputElement).type || '',
            placeholder: (el as HTMLInputElement).placeholder || '',
            name: el.getAttribute('name') || '',
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            isVisible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden',
            isEnabled: !(el as HTMLInputElement).disabled,
          });
        }

        return infos;
      },
      { sel: selector, max: maxResults },
    );
  }

  /**
   * Find a single element by CSS selector.
   */
  async querySelector(selector: string): Promise<DOMElementInfo | null> {
    const results = await this.querySelectorAll(selector, 1);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find elements by their visible text content.
   * Useful for clicking buttons like "Compose", "Send", "Save Draft".
   *
   * @param text Text to search for (case-insensitive, partial match)
   * @param tagFilter Optional tag name filter (e.g., 'button', 'a', 'div')
   */
  async findByText(
    text: string,
    tagFilter?: string,
  ): Promise<DOMElementInfo[]> {
    const pg = this.requirePage();

    const results = await pg.evaluate(
      (args: { searchText: string; tag: string }) => {
        const lower = args.searchText.toLowerCase();
        const candidates = args.tag
          ? document.querySelectorAll(args.tag)
          : document.querySelectorAll('button, a, [role="button"], [role="link"], [role="menuitem"], input[type="submit"], input[type="button"]');

        const matches: any[] = [];

        for (const el of candidates) {
          const htmlEl = el as HTMLElement;
          const elText = (htmlEl.textContent || '').trim().toLowerCase();
          const ariaLabel = (htmlEl.getAttribute('aria-label') || '').toLowerCase();
          const title = (htmlEl.getAttribute('title') || '').toLowerCase();

          if (elText.includes(lower) || ariaLabel.includes(lower) || title.includes(lower)) {
            const rect = htmlEl.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              matches.push({
                tagName: htmlEl.tagName.toLowerCase(),
                text: (htmlEl.textContent || '').trim().substring(0, 100),
                id: htmlEl.id || '',
                className: typeof htmlEl.className === 'string' ? htmlEl.className : '',
                role: htmlEl.getAttribute('role') || '',
                ariaLabel: htmlEl.getAttribute('aria-label') || '',
                type: (htmlEl as HTMLInputElement).type || '',
                placeholder: (htmlEl as HTMLInputElement).placeholder || '',
                name: htmlEl.getAttribute('name') || '',
                bounds: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
                isVisible: true,
                isEnabled: !(htmlEl as HTMLInputElement).disabled,
                selector: htmlEl.id ? `#${htmlEl.id}` : '',
              });
            }
          }
        }

        return matches;
      },
      { searchText: text, tag: tagFilter || '' },
    );

    return results;
  }

  /**
   * Find form fields by their associated label text.
   * Handles both <label for="..."> and label wrapping the input.
   */
  async findFieldByLabel(labelText: string, frame: Frame = this.requirePage().mainFrame()): Promise<DOMElementInfo | null> {
    const result: DOMElementInfo | null = await frame.evaluate(
      (searchLabel: string) => {
        const lower = searchLabel.toLowerCase();

        // Strategy 1: <label for="inputId">Label Text</label>
        const labels = document.querySelectorAll('label');
        for (const label of labels) {
          if ((label.textContent || '').trim().toLowerCase().includes(lower)) {
            const forId = label.getAttribute('for');
            if (forId) {
              const input = document.getElementById(forId);
              if (input) {
                const rect = input.getBoundingClientRect();
                return {
                  selector: `#${input.id}`,
                  tagName: input.tagName.toLowerCase(),
                  text: '',
                  id: input.id || '',
                  className: typeof input.className === 'string' ? input.className : '',
                  role: input.getAttribute('role') || '',
                  ariaLabel: input.getAttribute('aria-label') || '',
                  type: (input as HTMLInputElement).type || '',
                  placeholder: (input as HTMLInputElement).placeholder || '',
                  name: input.getAttribute('name') || '',
                  bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                  isVisible: rect.width > 0 && rect.height > 0,
                  isEnabled: !(input as HTMLInputElement).disabled,
                };
              }
            }
            // Strategy 2: label wraps input
            const input = label.querySelector('input, textarea, select');
            if (input) {
              const htmlInput = input as HTMLElement;
              const rect = input.getBoundingClientRect();
              return {
                selector: htmlInput.id ? `#${htmlInput.id}` : '',
                tagName: input.tagName.toLowerCase(),
                text: '',
                id: htmlInput.id || '',
                className: typeof htmlInput.className === 'string' ? htmlInput.className : '',
                role: input.getAttribute('role') || '',
                ariaLabel: input.getAttribute('aria-label') || '',
                type: (input as HTMLInputElement).type || '',
                placeholder: (input as HTMLInputElement).placeholder || '',
                name: input.getAttribute('name') || '',
                bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                isVisible: rect.width > 0 && rect.height > 0,
                isEnabled: !(input as HTMLInputElement).disabled,
              };
            }
          }
        }

        // Strategy 3: aria-label match on input/textarea
        const inputs = document.querySelectorAll('input, textarea, select, [contenteditable="true"]');
        for (const input of inputs) {
          const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
          const placeholder = ((input as HTMLInputElement).placeholder || '').toLowerCase();
          const name = (input.getAttribute('name') || '').toLowerCase();

          if (ariaLabel.includes(lower) || placeholder.includes(lower) || name.includes(lower)) {
            const htmlInput = input as HTMLElement;
            const rect = input.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return {
                selector: htmlInput.id ? `#${htmlInput.id}` : '',
                tagName: input.tagName.toLowerCase(),
                text: '',
                id: htmlInput.id || '',
                className: typeof htmlInput.className === 'string' ? htmlInput.className : '',
                role: input.getAttribute('role') || '',
                ariaLabel: input.getAttribute('aria-label') || '',
                type: (input as HTMLInputElement).type || '',
                placeholder: (input as HTMLInputElement).placeholder || '',
                name: input.getAttribute('name') || '',
                bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                isVisible: true,
                isEnabled: !(input as HTMLInputElement).disabled,
              };
            }
          }
        }

        return null;
      },
      labelText,
    );

    return result;
  }

  // ════════════════════════════════════════════════════════════════════
  // ELEMENT INTERACTION
  // ════════════════════════════════════════════════════════════════════

  /**
   * Click an element by CSS selector.
   * Uses JS dispatchEvent (reliable on background CDP tabs with 0x0 viewport).
   * Falls back to Playwright click if JS dispatch doesn't work.
   */
  async click(selector: string): Promise<CDPInteractionResult> {
    const pg = this.requirePage();
    try {
      // Primary: JS-based click (works on background tabs)
      const clicked = await this.inFrames(f => f.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement;
        if (!el) return false;
        el.click();
        return true;
      }, selector));
      if (clicked) return { success: true, method: 'js.click', frame: this.frameUrl(clicked.frame) };
      // Fallback: Playwright click with force
      await this.moveCursorToSelector(selector);
      await pg.click(selector, { timeout: 5000, force: true });
      return { success: true, method: 'playwright.click' };
    } catch (err) {
      return {
        success: false,
        error: `Click failed on "${selector}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Click an element by its visible text content.
   *
   * This is the most natural way to interact with web UIs:
   *   await cdp.clickByText('Compose');
   *   await cdp.clickByText('Send');
   *   await cdp.clickByText('Discard');
   */
  async clickByText(text: string): Promise<CDPInteractionResult> {
    this.requirePage();
    try {
      // Each frame, main first: a JS click by text content (works on background tabs), then Playwright locators.
      const hit = await this.inFrames(f => this.clickByTextIn(f, text));
      if (hit) return { success: true, method: hit.hit, frame: this.frameUrl(hit.frame) };
      return { success: false, error: `no element found with text "${text}" in ${this.searched()}` };
    } catch (err) {
      return {
        success: false,
        error: `clickByText("${text}") failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** clickByText within one frame: the method that clicked, or null. */
  private async clickByTextIn(f: Frame, text: string): Promise<string | null> {
    const jsClicked = await f.evaluate((searchText: string) => {
      const lower = searchText.toLowerCase();
      // Deduplicate: elements matching multiple selectors should only appear once
      const seen = new Set<Element>();
      const candidates: HTMLElement[] = [];
      for (const sel of ['button, [role="button"]', 'a[href]', '[role="link"], [role="menuitem"], [role="tab"]']) {
        for (const el of document.querySelectorAll(sel)) {
          if (!seen.has(el)) {
            seen.add(el);
            candidates.push(el as HTMLElement);
          }
        }
      }
      for (const htmlEl of candidates) {
        const elText = (htmlEl.textContent || '').trim().toLowerCase();
        const ariaLabel = (htmlEl.getAttribute('aria-label') || '').toLowerCase();
        if (elText.includes(lower) || ariaLabel.includes(lower)) {
          // Visibility check — skip hidden elements
          const style = getComputedStyle(htmlEl);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          htmlEl.click();
          return true;
        }
      }
      return false;
    }, text);
    if (jsClicked) return 'js.clickByText';

    // Fallback: Playwright locators with force
    const locators = [
      f.getByRole('button', { name: text }),
      f.getByRole('link', { name: text }),
      f.getByRole('menuitem', { name: text }),
      f.getByText(text, { exact: false }),
    ];

    for (const locator of locators) {
      try {
        const count = await locator.count();
        if (count > 0) {
          await locator.first().click({ timeout: 3000, force: true });
          return 'playwright.getByText';
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Type text into a field identified by CSS selector.
   *
   * Clears the field first (select all + delete), then types.
   * For content-editable divs (like Gmail compose body), uses fill() which
   * works better than type() for non-input elements.
   */
  async typeInField(selector: string, text: string): Promise<CDPInteractionResult> {
    let f = this.requirePage().mainFrame();
    try { f = await this.frameWith(selector); } catch { /* a bad selector: the fill below reports it */ }
    return this.typeIn(f, selector, text);
  }

  /** typeInField within one frame. */
  private async typeIn(f: Frame, selector: string, text: string): Promise<CDPInteractionResult> {
    const pg = this.requirePage();
    const frame = this.frameUrl(f);
    try {
      await this.moveCursorToSelector(selector, f);
      // Try fill() first — works for inputs, textareas, and [contenteditable]
      await f.fill(selector, text, { timeout: 5000, force: true });
      return { success: true, method: 'playwright.fill', read: readerOf(f.locator(selector).first()), frame };
    } catch {
      // Fall back to click + clear + type for stubborn elements
      try {
        await f.click(selector, { timeout: 3000, force: true });
        await pg.keyboard.press('Control+a');
        await pg.keyboard.type(text, { delay: 20 });
        return { success: true, method: 'playwright.type', read: readerOf(f.locator(selector).first()), frame };
      } catch (err) {
        return {
          success: false,
          error: `Type failed on "${selector}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  /**
   * Type into a field found by its label or aria-label.
   *
   * This is the most user-friendly way to fill forms:
   *   await cdp.typeByLabel('To', 'user@example.com');
   *   await cdp.typeByLabel('Subject', 'Meeting notes');
   */
  async typeByLabel(label: string, text: string): Promise<CDPInteractionResult> {
    this.requirePage();
    try {
      // Per frame, main first: Playwright's getByLabel() (handles <label>, aria-label, aria-labelledby), then our custom label finder.
      const hit = await this.inFrames(async (f): Promise<Locator | string | null> => {
        const locator = f.getByLabel(label);
        if ((await locator.count()) > 0) return locator.first();
        return (await this.findFieldByLabel(label, f))?.selector || null;
      });
      if (!hit) return { success: false, error: `field not found with label "${label}" in ${this.searched()}` };
      if (typeof hit.hit === 'string') return this.typeIn(hit.frame, hit.hit, text);

      await hit.hit.fill(text, { timeout: 5000, force: true });
      return { success: true, method: 'playwright.getByLabel', read: readerOf(hit.hit), frame: this.frameUrl(hit.frame) };
    } catch (err) {
      return {
        success: false,
        error: `typeByLabel("${label}") failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Fill a form by mapping label text → value.
   *
   * Example (Gmail compose):
   *   await cdp.fillFormByLabels({
   *     'To': 'friend@gmail.com',
   *     'Subject': 'Hello!',
   *     'Message Body': 'How are you doing?'
   *   });
   */
  async fillFormByLabels(
    fields: Record<string, string>,
  ): Promise<{ success: boolean; results: Record<string, CDPInteractionResult> }> {
    const results: Record<string, CDPInteractionResult> = {};
    let allSuccess = true;

    for (const [label, value] of Object.entries(fields)) {
      const result = await this.typeByLabel(label, value);
      results[label] = result;
      if (!result.success) {
        allSuccess = false;
        console.log(`   ⚠️ CDPDriver: failed to fill "${label}": ${result.error}`);
      }
    }

    return { success: allSuccess, results };
  }

  /**
   * Focus an element by CSS selector.
   */
  async focus(selector: string): Promise<CDPInteractionResult> {
    const pg = this.requirePage();
    try {
      await this.moveCursorToSelector(selector);
      await pg.focus(selector, { timeout: 3000 });
      return { success: true, method: 'playwright.focus' };
    } catch (err) {
      return {
        success: false,
        error: `Focus failed on "${selector}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Select an option in a <select> dropdown.
   *
   * @param selector CSS selector for the <select> element
   * @param valueOrLabel Option value or visible text to select
   */
  async selectOption(
    selector: string,
    valueOrLabel: string,
  ): Promise<CDPInteractionResult> {
    this.requirePage();
    try {
      const f = await this.frameWith(selector);
      // Try by value first, then by label
      const selected = await f.selectOption(selector, valueOrLabel, { timeout: 3000 });
      if (selected.length === 0) {
        // Try by label
        await f.selectOption(selector, { label: valueOrLabel }, { timeout: 3000 });
      }
      return { success: true, method: 'playwright.selectOption', value: valueOrLabel, read: readerOf(f.locator(selector).first()), frame: this.frameUrl(f) };
    } catch (err) {
      return {
        success: false,
        error: `Select failed on "${selector}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Press a keyboard key (while the page has focus).
   */
  async pressKey(key: string): Promise<CDPInteractionResult> {
    const pg = this.requirePage();
    try {
      await pg.keyboard.press(key);
      return { success: true, method: 'playwright.keyboard.press' };
    } catch (err) {
      return {
        success: false,
        error: `Key press "${key}" failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // PAGE STATE
  // ════════════════════════════════════════════════════════════════════

  /** Get current page URL */
  async getUrl(): Promise<string | null> {
    if (!this.activePage) return null;
    try {
      return this.activePage.url();
    } catch {
      return null;
    }
  }

  /** Get current page title */
  async getTitle(): Promise<string | null> {
    if (!this.activePage) return null;
    try {
      return await this.activePage.title();
    } catch {
      return null;
    }
  }

  /**
   * Get a text summary of the visible, interactive elements on the page.
   * Useful for building context for an LLM without screenshots.
   */
  async getInteractiveElements(frame: Frame = this.requirePage().mainFrame()): Promise<DOMElementInfo[]> {
    return frame.evaluate(() => {
      const interactiveSelectors = [
        'a[href]',
        'button',
        'input',
        'textarea',
        'select',
        '[role="button"]',
        '[role="link"]',
        '[role="menuitem"]',
        '[role="tab"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="textbox"]',
        '[role="combobox"]',
        '[contenteditable="true"]',
        '[tabindex]:not([tabindex="-1"])',
      ];

      const sel = interactiveSelectors.join(', ');
      const elements = document.querySelectorAll(sel);
      const results: any[] = [];

      // When viewport is 0x0 (background tab via CDP), skip bounds filtering
      const hasViewport = window.innerWidth > 0 && window.innerHeight > 0;

      for (const el of elements) {
        const htmlEl = el as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();

        // Always skip zero-size elements (display:none, collapsed, etc.)
        if (rect.width <= 0 || rect.height <= 0) continue;
        // Only check viewport bounds when viewport is valid (not background tab)
        if (hasViewport) {
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
          if (rect.right < 0 || rect.left > window.innerWidth) continue;
        }
        const style = getComputedStyle(htmlEl);
        if (style.visibility === 'hidden' || style.display === 'none') continue;

        results.push({
          selector: htmlEl.id ? `#${htmlEl.id}` : '',
          tagName: htmlEl.tagName.toLowerCase(),
          text: (htmlEl.textContent || '').trim().substring(0, 60),
          id: htmlEl.id || '',
          className: typeof htmlEl.className === 'string' ? htmlEl.className.substring(0, 80) : '',
          role: htmlEl.getAttribute('role') || '',
          ariaLabel: htmlEl.getAttribute('aria-label') || '',
          type: (htmlEl as HTMLInputElement).type || '',
          placeholder: (htmlEl as HTMLInputElement).placeholder || '',
          name: htmlEl.getAttribute('name') || '',
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          isVisible: true,
          isEnabled: !(htmlEl as HTMLInputElement).disabled,
        });

        if (results.length >= 50) break; // Cap results
      }

      return results;
    });
  }

  /**
   * Get a text representation of the page's interactive elements.
   * Formatted for LLM consumption — compact, informative.
   */
  async getPageContext(): Promise<string> {
    try {
      const url = await this.getUrl();
      const title = await this.getTitle();
      const elements = await this.getInteractiveElements();

      let context = `PAGE: "${title}" at ${url}\n\n`;

      // Prioritize inputs/buttons/selects over links to keep context manageable
      const inputs = elements.filter(e => ['input', 'textarea', 'select'].includes(e.tagName));
      const buttons = elements.filter(e => e.tagName === 'button' || e.role === 'button');
      const links = elements.filter(e => e.tagName === 'a' && e.role !== 'button');
      const other = elements.filter(e => !inputs.includes(e) && !buttons.includes(e) && !links.includes(e));

      // Always show all inputs, buttons, and other elements; limit links to 40
      const shown = [...inputs, ...buttons, ...other, ...links.slice(0, 40)];
      const hiddenLinks = links.length > 40 ? links.length - 40 : 0;

      context += `INTERACTIVE ELEMENTS (${shown.length}${hiddenLinks > 0 ? `, +${hiddenLinks} more links` : ''}):\n`;

      const line = (el: DOMElementInfo, dx = 0, dy = 0) => {
        const label = el.ariaLabel || el.text || el.placeholder || el.name || el.id || '(unnamed)';
        const typeInfo = el.type ? ` type="${el.type}"` : '';
        const roleInfo = el.role ? ` role="${el.role}"` : '';
        return `  [${el.tagName}${typeInfo}${roleInfo}] "${label}"${el.id ? ` #${el.id}` : ''} @${el.bounds.x + dx},${el.bounds.y + dy}\n`;
      };
      for (const el of shown) context += line(el);

      // Iframes: their controls are not in the page's DOM; positions are offset by the iframe's own (#398).
      for (const f of this.frames().slice(1)) {
        const els = await this.getInteractiveElements(f).catch(() => [] as DOMElementInfo[]);
        if (!els.length) continue;
        const box = await f.frameElement().then(e => e.boundingBox()).catch(() => null);
        context += `\nIFRAME ${f.url()}${f.name() ? ` name="${f.name()}"` : ''} (${els.length}; click / type / read_text reach these):\n`;
        for (const el of els) context += line(el, Math.round(box?.x ?? 0), Math.round(box?.y ?? 0));
      }

      return context;
    } catch (err) {
      return `(CDPDriver page context unavailable: ${err})`;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // SCRIPT EVALUATION
  // ════════════════════════════════════════════════════════════════════

  /**
   * Read text content from a DOM element (safe, parameterized — no CSS injection risk).
   * @param selector CSS selector for the target element (default: 'body')
   * @param maxLength Maximum characters to return (default: 3000)
   */
  async readText(selector = 'body', maxLength = 3000): Promise<string> {
    const [main, ...children] = this.frames();
    // null: no such element in that frame. An iframe's text is not in its parent's innerText, so every frame is read (#398).
    const read = (f: Frame) => f.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const raw = (el as HTMLElement).innerText || el.textContent || '';
      return raw.replace(/\n{3,}/g, '\n\n').trim();
    }, selector);
    const own = await read(main);
    const parts = own ? [own] : [];
    for (const f of children) {
      const t = await read(f).catch(() => null);
      if (t) parts.push(`--- iframe ${f.url()} ---\n${t}`);
    }
    if (own === null && !parts.length) return `[element not found: ${selector}]`;
    return parts.join('\n\n').substring(0, maxLength);
  }

  /**
   * Read the current value of a form field (safe, parameterized — no CSS injection risk).
   * @param selector CSS selector for the input/textarea element
   */
  async readFieldValue(selector: string): Promise<string> {
    const pg = this.requirePage();
    return pg.evaluate(
      (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return '';
        return ((el as HTMLInputElement).value ?? el.textContent ?? '').substring(0, 60);
      },
      selector,
    );
  }

  /**
   * Evaluate arbitrary JavaScript in the page context.
   * Use this for custom interactions not covered by the standard methods.
   *
   * @param script JavaScript code to evaluate
   * @returns The return value of the script, serialized
   */
  async evaluate<T = any>(script: string): Promise<T> {
    const pg = this.requirePage();
    return pg.evaluate(script);
  }

  /**
   * Wait for a selector to appear on the page.
   */
  async waitForSelector(
    selector: string,
    timeoutMs = 10_000,
  ): Promise<CDPInteractionResult> {
    this.requirePage();
    try {
      // Polled across every frame: an iframe may also attach while we wait (#398).
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = await this.inFrames(f => f.locator(selector).first().isVisible());
        if (hit) return { success: true, frame: this.frameUrl(hit.frame) };
        if (Date.now() >= deadline) {
          return { success: false, error: `Timeout waiting for "${selector}": not visible in ${this.searched()} after ${timeoutMs}ms` };
        }
        await new Promise(r => setTimeout(r, 250));
      }
    } catch (err) {
      return {
        success: false,
        error: `Timeout waiting for "${selector}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Wait for navigation to complete (e.g., after clicking a link).
   */
  async waitForNavigation(timeoutMs = 15_000): Promise<CDPInteractionResult> {
    const pg = this.requirePage();
    try {
      await pg.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
      return { success: true, value: pg.url() };
    } catch (err) {
      return {
        success: false,
        error: `Navigation timeout: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ════════════════════════════════════════════════════════════════════

  /**
   * Disconnect from the browser.
   * Only closes the CDP connection if we own it — doesn't close the user's browser.
   */
  async disconnect(): Promise<void> {
    if (this.ownsBrowser && this.browser) {
      try {
        await this.browser.close();
      } catch { /* Browser may already be closed */ }
    }
    this.browser = null;
    this.activePage = null;
    this.connected = false;
    this.cursorInjected = false;
  }

  /** Get the underlying Playwright Page (for advanced usage) */
  getPage(): Page | null {
    return this.activePage;
  }

  // ════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ════════════════════════════════════════════════════════════════════

  /** Ensure a virtual cursor overlay exists in the page */
  private async ensureCursorOverlay(): Promise<void> {
    const pg = this.requirePage();
    if (this.cursorInjected) return;
    try {
      await pg.evaluate(() => {
        if (document.getElementById('__clawd_cursor')) return;
        const cursor = document.createElement('div');
        cursor.id = '__clawd_cursor';
        cursor.style.position = 'fixed';
        cursor.style.width = '12px';
        cursor.style.height = '12px';
        cursor.style.borderRadius = '50%';
        cursor.style.background = '#ff6b6b';
        cursor.style.boxShadow = '0 0 6px rgba(0,0,0,0.4)';
        cursor.style.zIndex = '2147483647';
        cursor.style.pointerEvents = 'none';
        cursor.style.transform = 'translate(-50%, -50%)';
        cursor.style.left = '10px';
        cursor.style.top = '10px';
        const label = document.createElement('div');
        label.id = '__clawd_cursor_label';
        label.textContent = 'Clawd';
        label.style.position = 'fixed';
        label.style.fontSize = '10px';
        label.style.fontFamily = 'sans-serif';
        label.style.color = '#ff6b6b';
        label.style.zIndex = '2147483647';
        label.style.pointerEvents = 'none';
        label.style.transform = 'translate(6px, -18px)';
        label.style.left = '10px';
        label.style.top = '10px';
        document.body.appendChild(cursor);
        document.body.appendChild(label);
      });
      this.cursorInjected = true;
    } catch (err) {
      console.debug(`[CDPDriver] Cursor overlay injection failed: ${err}`);
    }
  }

  private async moveVirtualCursor(x: number, y: number): Promise<void> {
    const pg = this.requirePage();
    try {
      await this.ensureCursorOverlay();
      await pg.evaluate(({ x, y }) => {
        const cursor = document.getElementById('__clawd_cursor');
        const label = document.getElementById('__clawd_cursor_label');
        if (cursor) {
          cursor.style.left = `${x}px`;
          cursor.style.top = `${y}px`;
        }
        if (label) {
          label.style.left = `${x}px`;
          label.style.top = `${y}px`;
        }
      }, { x, y });
    } catch (err) {
      console.debug(`[CDPDriver] moveVirtualCursor failed: ${err}`);
    }
  }

  private async moveCursorToSelector(selector: string, frame: Frame = this.requirePage().mainFrame()): Promise<void> {
    try {
      const box = await frame.locator(selector).first().boundingBox();
      if (box) {
        await this.moveVirtualCursor(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
      }
    } catch (err) {
      console.debug(`[CDPDriver] moveCursorToSelector failed: ${err}`);
    }
  }

  /**
   * The page's frames, main first, then every iframe: same-origin and cross-origin alike (Playwright attaches out-of-process
   * iframes over CDP). document.querySelector and page locators stop at an iframe's edge, so a by-name action that only
   * searched the page missed every control inside one (#398).
   */
  private frames(): Frame[] {
    const pg = this.requirePage();
    const main = pg.mainFrame();
    return [main, ...pg.frames().filter(f => f !== main)];
  }

  /**
   * The first frame, main first, where `find` finds something. The main frame is searched exactly as before and its errors
   * are the caller's; an iframe that detaches or navigates mid-search is skipped.
   */
  private async inFrames<T>(find: (f: Frame) => Promise<T | null | undefined | false>): Promise<{ hit: T; frame: Frame } | null> {
    const [main, ...children] = this.frames();
    const first = await find(main);
    if (first) return { hit: first, frame: main };
    for (const f of children) {
      const hit = await find(f).catch(() => null);
      if (hit) return { hit, frame: f };
    }
    return null;
  }

  /** The frame holding `selector` (the main frame when none does, so Playwright's own wait and error apply there). */
  private async frameWith(selector: string): Promise<Frame> {
    return (await this.inFrames(async f => (await f.locator(selector).count()) > 0))?.frame ?? this.requirePage().mainFrame();
  }

  /** For a result: the iframe's URL, or undefined for the page itself. */
  private frameUrl(f: Frame): string | undefined {
    return f === this.requirePage().mainFrame() ? undefined : (f.url() || f.name());
  }

  /** "the page" / "the page and its 2 iframes", for a miss. */
  private searched(): string {
    const n = this.frames().length - 1;
    return n ? `the page and its ${n} iframe${n === 1 ? '' : 's'}` : 'the page';
  }

  /**
   * Guard: ensure we have an active page and return it.
   * Throws if not connected.
   */
  private requirePage(): Page {
    if (!this.activePage || !this.connected) {
      throw new Error(
        'CDPDriver: not connected. Call connect() first or attach a Page with attachToPage().',
      );
    }
    return this.activePage;
  }
}
