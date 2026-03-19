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
 *   │   UIDriver (native UI)     │  ← Windows UI Automation
 *   ├─────────────────────────────┤
 *   │   CDPDriver (browser DOM)  │  ← This module (CDP)
 *   ├─────────────────────────────┤
 *   │   BrowserLayer (Playwright) │  ← Navigation, page-level tasks
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

import { chromium, type Browser, type Page } from 'playwright';

// ── Default CDP port — matches browser-config.ts and tool launch flags ──
const DEFAULT_CDP_PORT = 9223;

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
}

/**
 * CDPDriver — interact with web page DOM elements via Chrome DevTools Protocol.
 *
 * Uses Playwright's CDP connection under the hood, so it works with the same
 * browser instance that BrowserLayer connects to. You can also share a Page
 * object directly.
 */
export class CDPDriver {
  private browser: Browser | null = null;
  private activePage: Page | null = null;
  private connected = false;
  private cdpPort: number;
  private ownsBrowser = false; // true if we created the browser connection
  private cursorInjected = false;

  /**
   * @param cdpPort CDP debugging port (default 9223)
   */
  constructor(cdpPort = DEFAULT_CDP_PORT) {
    this.cdpPort = cdpPort;
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
   * @returns true if connected successfully
   */
  async connect(): Promise<boolean> {
    try {
      this.browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${this.cdpPort}`,
        { timeout: 15000 },
      );
      this.ownsBrowser = true;

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
      const fallbackPage = allPages.find(p =>
        !p.url().startsWith('edge://') && !p.url().startsWith('chrome://') && !p.url().startsWith('about:')
      ) ?? allPages[0] ?? null;

      // Among user pages, prefer the last one (most recently opened/navigated)
      this.activePage = userPages.length > 0
        ? userPages[userPages.length - 1]
        : fallbackPage;

      if (!this.activePage) {
        console.warn('   ⚠️ CDPDriver: connected but no pages found');
        return false;
      }

      this.connected = true;
      const title = await this.activePage.title().catch(() => '(unknown)');
      console.log(`   🔌 CDPDriver: connected to "${title}" at ${this.activePage.url()}`);
      return true;
    } catch (err) {
      console.log(`   ❌ CDPDriver: failed to connect to CDP port ${this.cdpPort}: ${err}`);
      return false;
    }
  }

  /**
   * Attach to an existing Playwright Page object.
   * Use this when BrowserLayer already has a connection — avoid duplicate CDP connections.
   */
  attachToPage(page: Page): void {
    this.activePage = page;
    this.connected = true;
    this.ownsBrowser = false;
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
          let selector = '';
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
  async findFieldByLabel(labelText: string): Promise<DOMElementInfo | null> {
    const pg = this.requirePage();

    const result: DOMElementInfo | null = await pg.evaluate(
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
      const clicked = await pg.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement;
        if (!el) return false;
        el.click();
        return true;
      }, selector);
      if (clicked) return { success: true, method: 'js.click' };
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
    const pg = this.requirePage();

    try {
      // Primary: JS-based click by text content (works on background tabs)
      const jsClicked = await pg.evaluate((searchText: string) => {
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
      if (jsClicked) return { success: true, method: 'js.clickByText' };

      // Fallback: Playwright locators with force
      const locators = [
        pg.getByRole('button', { name: text }),
        pg.getByRole('link', { name: text }),
        pg.getByRole('menuitem', { name: text }),
        pg.getByText(text, { exact: false }),
      ];

      for (const locator of locators) {
        try {
          const count = await locator.count();
          if (count > 0) {
            await locator.first().click({ timeout: 3000, force: true });
            return { success: true, method: 'playwright.getByText' };
          }
        } catch {
          continue;
        }
      }

      return { success: false, error: `No clickable element found with text "${text}"` };
    } catch (err) {
      return {
        success: false,
        error: `clickByText("${text}") failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Type text into a field identified by CSS selector.
   *
   * Clears the field first (select all + delete), then types.
   * For content-editable divs (like Gmail compose body), uses fill() which
   * works better than type() for non-input elements.
   */
  async typeInField(selector: string, text: string): Promise<CDPInteractionResult> {
    const pg = this.requirePage();
    try {
      await this.moveCursorToSelector(selector);
      // Try fill() first — works for inputs, textareas, and [contenteditable]
      await pg.fill(selector, text, { timeout: 5000, force: true });
      return { success: true, method: 'playwright.fill' };
    } catch {
      // Fall back to click + clear + type for stubborn elements
      try {
        await pg.click(selector, { timeout: 3000, force: true });
        await pg.keyboard.press('Control+a');
        await pg.keyboard.type(text, { delay: 20 });
        return { success: true, method: 'playwright.type' };
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
    const pg = this.requirePage();
    try {
      // Playwright's getByLabel() handles <label>, aria-label, aria-labelledby
      const locator = pg.getByLabel(label);
      const count = await locator.count();

      if (count === 0) {
        // Fall back to our custom label finder
        const field = await this.findFieldByLabel(label);
        if (field && field.selector) {
          return this.typeInField(field.selector, text);
        }
        return { success: false, error: `No field found with label "${label}"` };
      }

      await locator.first().fill(text, { timeout: 5000, force: true });
      return { success: true, method: 'playwright.getByLabel' };
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
    const pg = this.requirePage();
    try {
      // Try by value first, then by label
      const selected = await pg.selectOption(selector, valueOrLabel, { timeout: 3000 });
      if (selected.length === 0) {
        // Try by label
        await pg.selectOption(selector, { label: valueOrLabel }, { timeout: 3000 });
      }
      return { success: true, method: 'playwright.selectOption', value: valueOrLabel };
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
  async getInteractiveElements(): Promise<DOMElementInfo[]> {
    const pg = this.requirePage();

    return pg.evaluate(() => {
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

      for (const el of shown) {
        const label = el.ariaLabel || el.text || el.placeholder || el.name || el.id || '(unnamed)';
        const typeInfo = el.type ? ` type="${el.type}"` : '';
        const roleInfo = el.role ? ` role="${el.role}"` : '';
        context += `  [${el.tagName}${typeInfo}${roleInfo}] "${label}"`;
        if (el.id) context += ` #${el.id}`;
        context += ` @${el.bounds.x},${el.bounds.y}\n`;
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
    const pg = this.requirePage();
    return pg.evaluate(
      (args: { sel: string; max: number }) => {
        const el = document.querySelector(args.sel);
        if (!el) return `[element not found: ${args.sel}]`;
        const raw = (el as HTMLElement).innerText || el.textContent || '';
        return raw.replace(/\n{3,}/g, '\n\n').trim().substring(0, args.max);
      },
      { sel: selector, max: maxLength },
    );
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
    const pg = this.requirePage();
    try {
      await pg.waitForSelector(selector, {
        timeout: timeoutMs,
        state: 'visible',
      });
      return { success: true };
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

  private async moveCursorToSelector(selector: string): Promise<void> {
    const pg = this.requirePage();
    try {
      const box = await pg.locator(selector).first().boundingBox();
      if (box) {
        await this.moveVirtualCursor(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
      }
    } catch (err) {
      console.debug(`[CDPDriver] moveCursorToSelector failed: ${err}`);
    }
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
