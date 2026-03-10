/**
 * Browser CDP tools — interact with web page DOM via Chrome DevTools Protocol.
 *
 * Structured access to browser page elements without screenshots.
 * Requires: Edge/Chrome running with --remote-debugging-port
 */

import type { ToolDefinition } from './types';

const CDP_PORT = 9223;

export function getCdpTools(): ToolDefinition[] {
  return [
    {
      name: 'cdp_connect',
      description: `Connect to Edge/Chrome browser via Chrome DevTools Protocol (port ${CDP_PORT}). Must be called before other cdp_* tools. Use navigate_browser to launch Edge with CDP enabled.`,
      parameters: {},
      category: 'browser',
      handler: async (_params, ctx) => {
        try { await ctx.cdp.disconnect(); } catch { /* ignore */ }
        const ok = await ctx.cdp.connect();
        if (ok) {
          const url = await ctx.cdp.getUrl();
          const title = await ctx.cdp.getTitle();
          return { text: `Connected to: "${title}" at ${url}` };
        }
        return { text: `Failed to connect to CDP on port ${CDP_PORT}. Use navigate_browser to launch Edge with CDP.`, isError: true };
      },
    },

    {
      name: 'cdp_page_context',
      description: 'Get a structured list of interactive elements on the current browser page (inputs, buttons, links with selectors and positions).',
      parameters: {},
      category: 'browser',
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
      handler: async () => {
        try {
          const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
          const tabs: any[] = await resp.json();
          const pages = tabs.filter((t: any) => t.type === 'page' && !t.url.startsWith('edge://') && !t.url.startsWith('chrome://'));
          if (!pages.length) return { text: '(no tabs found)' };
          const lines = pages.map((t: any, i: number) => `${i + 1}. "${t.title}" — ${t.url}`);
          return { text: lines.join('\n') };
        } catch {
          return { text: `Cannot list tabs. Use navigate_browser first to launch Edge with CDP on port ${CDP_PORT}.`, isError: true };
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
  ];
}
