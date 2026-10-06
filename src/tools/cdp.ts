/**
 * Browser CDP tools — interact with web page DOM via Chrome DevTools Protocol.
 *
 * Structured access to browser page elements without screenshots.
 * Requires: Edge/Chrome running with --remote-debugging-port
 */

import type { ToolDefinition } from './types';
import { DEFAULT_CDP_PORT } from '../llm/browser-config';

export function getCdpTools(): ToolDefinition[] {
  return [
    {
      name: 'cdp_connect',
      description: `Connect to Edge/Chrome browser via Chrome DevTools Protocol (port ${DEFAULT_CDP_PORT}). Must be called before other cdp_* tools. Use navigate_browser to launch Edge with CDP enabled.`,
      parameters: {},
      category: 'browser',
      compactGroup: 'browser',
      safetyTier: 1,
      handler: async (_params, ctx) => {
        try { await ctx.cdp.disconnect(); } catch { /* ignore */ }
        const ok = await ctx.cdp.connect();
        if (ok) {
          const url = await ctx.cdp.getUrl();
          const title = await ctx.cdp.getTitle();
          // cdp_connect ATTACHES to whatever browser is already on the debug
          // port — which is typically the USER'S own session. Disclose it so
          // the agent knows navigation/tab actions affect the user's tabs, not
          // a private instance (gauntlet F2).
          if (!/^https?:/i.test(url)) {
            return { text: `Attached to the EXISTING browser on port ${DEFAULT_CDP_PORT}, but it has no regular web page open (current: "${title}" at ${url}). It may be a separate browser profile rather than the user's signed-in window, so sites can appear logged out. The first navigation opens the agent's OWN tab. Do not close existing tabs/windows.` };
          }
          return { text: `Attached to the EXISTING browser on port ${DEFAULT_CDP_PORT}: "${title}" at ${url}. ⚠ This is likely the user's own session — reads see their current page; the first navigation automatically opens the agent's OWN tab so their tabs are never navigated away. Do not close their tabs/windows.` };
        }
        return { text: `Failed to connect to CDP on port ${DEFAULT_CDP_PORT}. Use navigate_browser to launch Edge with CDP.`, isError: true };
      },
    },

    {
      name: 'cdp_page_context',
      description: 'Get a structured list of interactive elements on the current browser page (inputs, buttons, links with selectors and positions).',
      parameters: {},
      category: 'browser',
      compactGroup: 'browser',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        if (!(await ctx.cdp.isConnected())) return { text: 'Not connected to CDP. Call cdp_connect first.', isError: true };
        const context = await ctx.cdp.getPageContext();
        return { text: context };
      },
    },

    {
      name: 'cdp_read_text',
      description: 'Read text content from a DOM element. Useful for extracting information from web pages.',
      parameters: {
        selector: { type: 'string', description: 'CSS selector (default: "body" for full page text)', required: false },
        maxLength: { type: 'number', description: 'Max characters to return (default: 3000)', required: false },
      },
      category: 'browser',
      compactGroup: 'browser',
      safetyTier: 0,
      handler: async ({ selector, maxLength }, ctx) => {
        if (!(await ctx.cdp.isConnected())) return { text: 'Not connected to CDP. Call cdp_connect first.', isError: true };
        const text = await ctx.cdp.readText(selector ?? 'body', maxLength ?? 3000);
        return { text };
      },
    },

    {
      name: 'cdp_click',
      description: 'Click a DOM element by CSS selector or by visible text content.',
      parameters: {
        selector: { type: 'string', description: 'CSS selector to click (e.g. "#submit", "button.primary")', required: false },
        text: { type: 'string', description: 'Visible text of the element to click (alternative to selector)', required: false },
      },
      category: 'browser',
      compactGroup: 'browser',
      safetyTier: 1,
      handler: async ({ selector, text }, ctx) => {
        if (!(await ctx.cdp.isConnected())) return { text: 'Not connected to CDP. Call cdp_connect first.', isError: true };
        if (!selector && !text) return { text: 'Provide either selector or text parameter.', isError: true };
        const result = text ? await ctx.cdp.clickByText(text) : await ctx.cdp.click(selector!);
        return {
          text: result.success ? `Clicked: ${selector || `"${text}"`} (method: ${result.method})` : `Click failed: ${result.error}`,
          isError: !result.success,
        };
      },
    },

    {
      name: 'cdp_type',
      description: 'Type text into a DOM input field by CSS selector or by associated label text.',
      parameters: {
        selector: { type: 'string', description: 'CSS selector for the input field', required: false },
        label: { type: 'string', description: 'Label text associated with the input (alternative to selector)', required: false },
        text: { type: 'string', description: 'Text to type into the field', required: true },
      },
      category: 'browser',
      compactGroup: 'browser',
      safetyTier: 1,
      handler: async ({ selector, label, text }, ctx) => {
        if (!(await ctx.cdp.isConnected())) return { text: 'Not connected to CDP. Call cdp_connect first.', isError: true };
        if (!selector && !label) return { text: 'Provide either selector or label parameter.', isError: true };
        const result = label ? await ctx.cdp.typeByLabel(label, text) : await ctx.cdp.typeInField(selector!, text);
        return {
          text: result.success ? `Typed "${(text as string).substring(0, 60)}" into ${selector || `label="${label}"`}` : `Type failed: ${result.error}`,
          isError: !result.success,
        };
      },
    },

    {
      name: 'cdp_select_option',
      description: 'Select an option in a <select> dropdown by value or visible text.',
      parameters: {
        selector: { type: 'string', description: 'CSS selector for the <select> element', required: true },
        value: { type: 'string', description: 'Option value or visible text to select', required: true },
      },
      category: 'browser',
      compactGroup: 'browser',
      safetyTier: 1,
      handler: async ({ selector, value }, ctx) => {
        if (!(await ctx.cdp.isConnected())) return { text: 'Not connected to CDP. Call cdp_connect first.', isError: true };
        const result = await ctx.cdp.selectOption(selector, value);
        return { text: result.success ? `Selected "${value}" in ${selector}` : `Select failed: ${result.error}`, isError: !result.success };
      },
    },

    {
      name: 'cdp_evaluate',
      description: 'Execute JavaScript in the browser page context. Returns the result.',
      parameters: {
        javascript: { type: 'string', description: 'JavaScript code to evaluate in the page', required: true },
      },
      category: 'browser',
      compactGroup: 'browser',
      safetyTier: 3,
      handler: async ({ javascript }, ctx) => {
        if (!(await ctx.cdp.isConnected())) return { text: 'Not connected to CDP. Call cdp_connect first.', isError: true };
        try {
          const result = await ctx.cdp.evaluate(javascript);
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return { text: text ?? '(undefined)' };
        } catch (e: any) {
          return { text: `JS error: ${e.message}`, isError: true };
        }
      },
    },

    {
      name: 'cdp_wait_for_selector',
      description: 'Wait for a DOM element matching a CSS selector to appear and become visible.',
      parameters: {
        selector: { type: 'string', description: 'CSS selector to wait for', required: true },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 10000)', required: false },
      },
      category: 'browser',
      compactGroup: 'browser',
      safetyTier: 0,
      handler: async ({ selector, timeout }, ctx) => {
        if (!(await ctx.cdp.isConnected())) return { text: 'Not connected to CDP. Call cdp_connect first.', isError: true };
        const result = await ctx.cdp.waitForSelector(selector, timeout ?? 10000);
        return { text: result.success ? `Element "${selector}" found` : `Wait failed: ${result.error}`, isError: !result.success };
      },
    },

    {
      name: 'cdp_list_tabs',
      description: 'List all open browser tabs with their URLs and titles.',
      parameters: {},
      category: 'browser',
      compactGroup: 'browser',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        // Connected → the driver's own browser, whichever port/instance that is
        // (the agent instance lives on AGENT_CDP_PORT, not the user port below).
        if (await ctx.cdp.isConnected()) {
          const tabs: Array<{ url: string; title: string; active: boolean }> = await ctx.cdp.listTabs();
          const pages = tabs.filter(t => !t.url.startsWith('edge://') && !t.url.startsWith('chrome://'));
          if (!pages.length) return { text: '(no tabs found)' };
          return { text: pages.map((t, i) => `${i + 1}.${t.active ? ' *' : ''} "${t.title}" — ${t.url}`).join('\n') };
        }
        try {
          const resp = await fetch(`http://127.0.0.1:${DEFAULT_CDP_PORT}/json`);
          const tabs: any[] = await resp.json();
          const pages = tabs.filter((t: any) => t.type === 'page' && !t.url.startsWith('edge://') && !t.url.startsWith('chrome://'));
          if (!pages.length) return { text: '(no tabs found)' };
          const lines = pages.map((t: any, i: number) => `${i + 1}. "${t.title}" — ${t.url}`);
          return { text: lines.join('\n') };
        } catch {
          return { text: `Cannot list tabs: not connected and no browser on port ${DEFAULT_CDP_PORT}. Use navigate_browser (opens a URL in the agent's browser) or cdp_connect first.`, isError: true };
        }
      },
    },

    {
      name: 'cdp_switch_tab',
      description: 'Switch CDP connection to a different browser tab by URL or title substring.',
      parameters: {
        target: { type: 'string', description: 'URL or title substring to match', required: true },
      },
      category: 'browser',
      compactGroup: 'browser',
      safetyTier: 1,
      handler: async ({ target }, ctx) => {
        if (!(await ctx.cdp.isConnected())) return { text: 'Not connected to CDP. Call cdp_connect first.', isError: true };
        const ok = await ctx.cdp.switchTab(target);
        if (ok) {
          const url = await ctx.cdp.getUrl();
          const title = await ctx.cdp.getTitle();
          return { text: `Switched to: "${title}" at ${url}` };
        }
        return { text: `No tab matching "${target}" found.`, isError: true };
      },
    },

    {
      name: 'cdp_scroll',
      description: 'Scroll the browser page via DOM (window.scrollBy). Works regardless of mouse position — use for reliable page scrolling.',
      parameters: {
        direction: { type: 'string', description: 'Scroll direction', required: true, enum: ['up', 'down'] },
        amount: { type: 'number', description: 'Pixels to scroll (default: 500)', required: false },
      },
      category: 'browser',
      compactGroup: 'browser',
      safetyTier: 1,
      handler: async ({ direction, amount }, ctx) => {
        if (!(await ctx.cdp.isConnected())) return { text: 'Not connected to CDP. Call cdp_connect first.', isError: true };
        const pixels = (amount ?? 500) * (direction === 'down' ? 1 : -1);
        await ctx.cdp.evaluate(`window.scrollBy(0, ${pixels})`);
        return { text: `Scrolled ${direction} by ${Math.abs(pixels)} pixels` };
      },
    },
  ];
}
