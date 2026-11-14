/**
 * Accessibility & window management tools.
 *
 * Text-first strategy: always try read_screen before desktop_screenshot.
 * Provides structured perception of the desktop without vision models.
 */

import type { ToolDefinition, ToolContext } from './types';
import type { UiElement } from '../platform/types';
import { isBrowserProcess } from '../platform/browser-config';
import { windowTextIncludes } from './window-text';
import { narrowedScopeNote } from './scope-note';
import { untrusted } from '../core/miss-text';
import { copyAllText, pageTextPart, PAGE_TEXT_CAP } from '../platform/copy-all-text';
import { SCREEN_COORDS_NOTE, SPARSE_NEXT_STEP, CUT_VALUE_NEXT_STEP, cdpBrowserPid, cdpStepFor, nameMissHint, shownValue, shownHelp } from './blind-hints';
import { wrapUntrustedScreenContent, screenJson } from '../core/untrusted-screen-content';
import { quoteScreenText } from '../core/result-codes';

/**
 * Query Chrome DevTools Protocol DOM for interactive elements when UIA returns
 * empty for a browser window. Edge's UIA tree stops at chrome — for canvas/web
 * content we have to ask the renderer directly.
 *
 * Returns `null` when ineligible (no active browser window / CDP not connected
 * / no page), an empty array when CDP responded but had no matches, or an
 * array of UiElement-shaped results synthesized from DOM nodes. The caller
 * decides how to surface "(no elements found)" vs the legitimate empty case.
 *
 * Note: bounding rects come back in CSS pixels; the existing `elementLine`
 * helper already expects unscaled coords, so no conversion is needed.
 */
async function queryCdpDom(
  ctx: ToolContext,
  query: { name?: string; limit?: number; processId?: number },
): Promise<UiElement[] | null> {
  let connected = false;
  try { connected = await ctx.cdp.isConnected(); } catch { /* not connected */ }
  if (!connected) return null;

  const page = ctx.cdp.getPage?.();
  if (!page) return null;

  // Scoped to a process (#235): answer from the CDP page when that process IS
  // the CDP browser — whatever window is in front — and never for another one.
  if (typeof query.processId === 'number') {
    const cdpPid = await cdpBrowserPid(ctx.cdp);
    if (cdpPid !== null && query.processId !== cdpPid) return null;
    if (cdpPid === null && !(await activeWindowIsCdpPage(ctx, query.processId))) return null;
  } else if (!(await activeWindowIsCdpPage(ctx))) {
    return null;
  }

  const limit = query.limit ?? 50;
  const needle = query.name?.toLowerCase() || null;
  try {
    const hits: Array<{ name: string; controlType: string; bounds: { x: number; y: number; width: number; height: number } }> =
      await page.evaluate(
        // The callback body is serialized by the SDK and executed in the
        // browser's V8 context via CDP `Runtime.evaluate` — `document` and
        // `HTMLElement` are live there. ESLint runs in the Node project
        // context and would mark them as no-undef without this block-scoped
        // override.
        /* eslint-disable no-undef */
        ({ needle, limit }: { needle: string | null; limit: number }) => {
          const selector =
            'a, button, input, textarea, select, [role], [aria-label], [contenteditable="true"], [tabindex]';
          const out: any[] = [];
          for (const el of document.querySelectorAll(selector)) {
            const h = el as HTMLElement;
            const name =
              (h.getAttribute('aria-label') ||
                h.getAttribute('alt') ||
                h.getAttribute('title') ||
                h.getAttribute('placeholder') ||
                (h as any).value ||
                h.textContent ||
                '').trim().slice(0, 120);
            if (needle && !name.toLowerCase().includes(needle)) continue;
            const r = h.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const role = h.getAttribute('role') || h.tagName.toLowerCase();
            out.push({
              name,
              controlType: `web.${role}`,
              bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
            });
            if (out.length >= limit) break;
          }
          return out;
        },
        /* eslint-enable no-undef */
        { needle, limit },
      );
    return hits.map(h => ({
      name: h.name || '',
      controlType: h.controlType,
      bounds: h.bounds,
      // The CSS-pixel rect is already in viewport coordinates relative to the
      // browser content area. We don't have absolute screen coords here — the
      // formatted output flags this with a [via CDP DOM] prefix so callers
      // know to translate before clicking. smart_click already handles this.
    } as UiElement));
  } catch {
    return null;
  }
}

/** The blind hint for a thin read of `pid`: the browser tools when it is the CDP browser. */
async function nextStepFor(ctx: ToolContext, pid: number | undefined): Promise<string> {
  return (await cdpStepFor(ctx.cdp, pid)) || SPARSE_NEXT_STEP;
}

/**
 * Unscoped fallback: is the FOCUSED window a browser showing the CDP page?
 *
 * The CDP connection may be to a DIFFERENT browser than the focused window
 * (e.g. the agent's own dedicated instance, or a relay Chrome). Answering a
 * query about the focused Edge using another browser's DOM is actively
 * misleading — it made an agent try to click "Continue with Google" buttons
 * that existed only in a background Chrome (session 2026-06-11). So the CDP
 * DOM only stands in for THIS window when the connected page corresponds to
 * the focused window's title. With `pid`, the focused window must also be
 * that process.
 */
async function activeWindowIsCdpPage(ctx: ToolContext, pid?: number): Promise<boolean> {
  let activeWin: any;
  try {
    activeWin = ctx.platform
      ? await ctx.platform.getActiveWindow()
      : await ctx.a11y.getActiveWindow();
  } catch {
    return false;
  }
  if (!isBrowserProcess(activeWin?.processName)) return false;
  if (pid !== undefined && activeWin?.processId !== pid) return false;
  try {
    const cdpTitle = await ctx.cdp.getTitle?.();
    const winTitle = activeWin?.title ?? '';
    // A browser window title embeds the page title ("<page> - <profile> -
    // <Browser>"). If we have a non-trivial page title and the focused window
    // does NOT contain it, the CDP target is a different window.
    if (cdpTitle && cdpTitle.trim().length > 1 && !windowTextIncludes(winTitle, cdpTitle)) return false;
  } catch { /* can't verify correspondence — fall through (best-effort) */ }
  return true;
}

/**
 * Build a display label for an element. Falls back through
 * `name → description → value → ''` so that Xcode and other macOS apps
 * that put their visible text in `AXDescription` (instead of `AXTitle`)
 * still render as something more informative than `"missing value"` or
 * empty quotes. Issue #101 bug 5 — adapters populate `description` when
 * the underlying a11y API exposes it.
 */
function elementLabel(el: UiElement): string {
  if (el.name && el.name !== 'missing value') return el.name;
  if (el.description) return el.description;
  if (el.value) return el.value;
  return '';
}

/** `value`: the element's value as its line shows it (blind-hints.ts shownValue), where the caller lists values. */
function elementLine(el: UiElement, value: string): string {
  return `[${el.controlType}] "${elementLabel(el)}"` +
    (el.automationId ? ` id:${el.automationId}` : '') +
    // On no monitor (or scrolled out of view): no position, so nothing to click. read_tree says the same.
    (el.offscreen ? ' (offscreen)' : ` @${el.bounds.x},${el.bounds.y} ${el.bounds.width}x${el.bounds.height}`) +
    value +
    shownHelp({ name: elementLabel(el), help: el.help }) +
    (el.disabled || el.enabled === false ? ' DISABLED' : '') +
    (el.focused ? ' FOCUSED' : '');
}

/** find's lines: each element with its value, as read_tree shows it; `cut` is the hint to add when a value was cut. */
function foundLines(els: UiElement[]): { lines: string; cut: string } {
  let cut = false;
  const lines = els.map(el => elementLine(el, shownValue(el.value, () => { cut = true; }))).join('\n');
  return { lines, cut: cut ? `\n${CUT_VALUE_NEXT_STEP}` : '' };
}

export function getA11yTools(): ToolDefinition[] {
  return [
    {
      name: 'get_active_window',
      description: 'Get the currently focused/foreground window.',
      parameters: {},
      category: 'window',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        if (ctx.platform) {
          const win = await ctx.platform.getActiveWindow();
          if (!win) return { text: '(no active window)' };
          return { text: screenJson(win) };
        }
        const win = await ctx.a11y.getActiveWindow();
        if (!win) return { text: '(no active window)' };
        return {
          text: JSON.stringify({
            title: win.title, processName: win.processName,
            processId: win.processId, bounds: win.bounds,
          }),
        };
      },
    },

    {
      name: 'get_focused_element',
      description: 'Get the currently focused UI element (keyboard focus). Returns name, control type, value, bounds, and process ID.',
      parameters: {},
      category: 'window',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        if (ctx.platform) {
          const el = await ctx.platform.getFocusedElement();
          if (!el && ctx.platform.lastFindError === 'partial') {
            return { text: `${ctx.platform.lastFindNote ?? 'Search cut.'} - this is not "nothing is focused".`, isError: true };
          }
          if (!el) return { text: '(no focused element)' };
          return { text: screenJson(el) };
        }
        const el = await ctx.a11y.getFocusedElement();
        if (!el) return { text: '(no focused element)' };
        return { text: screenJson(el) };
      },
    },

    {
      name: 'find_element',
      description: 'Search for UI elements by name, control type, or automation ID within a process. Returns matching elements with bounds. For browser windows with CDP attached (the focused one, or `processId` of the CDP browser), falls back to a DOM query when UIA returns empty so canvas / SPA content is reachable too (results are flagged with a "via CDP DOM" header and use viewport-relative coords).',
      parameters: {
        name: { type: 'string', description: 'Element name to search for', required: false },
        controlType: { type: 'string', description: 'UI Automation control type. Either form works: "Button" or "ControlType.Button". An unrecognized type returns no results rather than silently searching unfiltered.', required: false },
        automationId: { type: 'string', description: 'Automation ID', required: false },
        processId: { type: 'number', description: 'Process ID to search within', required: false },
        offset: { type: 'number', description: 'Skip this many matches: page past "... and N more" (default 0)', required: false },
      },
      category: 'window',
      safetyTier: 0,
      handler: async ({ name, controlType, automationId, processId, offset }, ctx) => {
        await ctx.ensureInitialized();
        let uiaHits: UiElement[];
        if (ctx.platform) {
          const elements = await ctx.platform.findElements({ name, controlType, automationId, processId });
          uiaHits = automationId
            ? elements.filter((el: UiElement) => el.automationId === automationId)
            : elements;
        } else {
          const elements = await ctx.a11y.findElement({ name, controlType, automationId, processId });
          uiaHits = (elements || []).map((el: any) => ({ ...el, enabled: el.enabled ?? el.isEnabled }));
        }
        if (uiaHits.length) {
          // Element names are what the screen said: data, never instructions — and never rewritten by the compact surface (#248).
          const skip = typeof offset === 'number' && offset > 0 ? Math.floor(offset) : 0;
          if (skip >= uiaHits.length) return { text: `offset ${skip} is past the end: ${uiaHits.length} elements match.`, isError: true };
          const page = uiaHits.slice(skip, skip + 20);
          const rest = uiaHits.length - skip - page.length;
          const more = rest > 0 ? `\n... and ${rest} more — find again with offset:${skip + page.length}` : '';
          // A search the platform cut returned only part of the list.
          const cut = ctx.platform?.lastFindError === 'partial' ? `\n(${ctx.platform.lastFindNote ?? 'The search was cut; the list is incomplete.'})` : '';
          const found = foundLines(page);
          return { text: `${SCREEN_COORDS_NOTE}\n${wrapUntrustedScreenContent(found.lines)}${more}${cut}${found.cut}` };
        }
        // A timeout is not "nothing there" — say so, or the agent concludes
        // a11y is useless and switches to screenshots for the rest of the session.
        if (ctx.platform?.lastFindError === 'partial') {
          return {
            text: `${ctx.platform.lastFindNote ?? 'Not found in the readable part of the window.'} — it may be in the part that did not answer; this is not "nothing found". ` +
              'Read what did answer with read_tree (text that is only a value shows there even when find by name misses it), ' +
              'or smart_click {"target":"<label>"} / ocr_read_screen for text you can see.',
            isError: true,
          };
        }
        if (ctx.platform?.lastFindError === 'timeout') {
          return {
            text: 'accessibility search TIMED OUT on a very large window (this is not "nothing found"). ' +
              'Narrow it with processId and/or controlType. Or: copy_all_text for the exact page text · ' +
              'smart_click {"target":"<label>"} to press a labelled control (OCR fallback) · ocr_read_screen to read it.',
            isError: true,
          };
        }
        // UIA returned nothing. For a browser window with CDP attached, ask
        // the renderer directly — Edge/Chrome UIA stops at chrome and never
        // surfaces canvas or in-page DOM elements. Without this fallback an
        // agent calling find_element on a web app sees "(no elements found)"
        // and either gives up or escalates straight to screenshots.
        const cdpHits = await queryCdpDom(ctx, { name, limit: 20, processId });
        if (cdpHits && cdpHits.length) {
          const lines = ['(no UIA matches — falling back to CDP DOM; coords are viewport-relative)'];
          const found = foundLines(cdpHits);
          return { text: `${lines[0]}\n${wrapUntrustedScreenContent(found.lines)}${found.cut}` };
        }
        // A bridge that failed is not "nothing found" — said only after the browser DOM fallback also found nothing.
        if (ctx.platform?.lastFindError === 'error') {
          return {
            text: 'accessibility search FAILED (the accessibility bridge did not answer — this is not "nothing found"). ' +
              'Read it another way: copy_all_text for the exact page text · smart_click {"target":"<label>"} (OCR fallback) · ocr_read_screen.',
            isError: true,
          };
        }
        // Say which window(s) were searched — an unscoped query follows the
        // live foreground window, which may not be the app the agent meant.
        const scopes = ctx.platform?.lastFindScope ?? [];
        const searched = scopes
          .filter(s => s.processId !== undefined)
          .map(s => `pid ${s.processId}${s.processName ? ` [${s.processName}]` : ''}${s.title ? ` "${s.title}"` : ''}`);
        // Titles and process names are screen text: inside an untrusted block, so they cannot steer the result code.
        const where = searched.length ? `\nsearched:\n${untrusted(searched.join(', '))}${await narrowedScopeNote(ctx.platform, scopes)}` : '';
        const searchedPid = typeof processId === 'number' ? processId
          : scopes.length === 1 ? scopes[0].processId : undefined;
        // A miss in a window with real structure is a wrong name, not a blind app: say what it has and what is close.
        // Only a thin window gets the "little or no accessibility structure" advice (live macOS: Freeform, 34 elements).
        if (name && ctx.platform) {
          let tree: Awaited<ReturnType<typeof ctx.platform.getUiTree>> = [];
          try { tree = await ctx.platform.getUiTree(searchedPid); } catch { /* unreadable: keep the generic advice */ }
          const miss = nameMissHint(String(name), tree, wrapUntrustedScreenContent);
          // A browser's window always has its own chrome (tabs, Back, Reload) while the PAGE may expose nothing: there the
          // browser advice (read the page over CDP / turn on renderer accessibility) still applies, after the names.
          const searchedProc = scopes.find(s => s.processId === searchedPid)?.processName;
          const browser = isBrowserProcess(searchedProc) || (searchedPid !== undefined && (await cdpBrowserPid(ctx.cdp)) === searchedPid);
          if (miss) return { text: `(no elements found)${where}\n${miss}${browser ? `\n${await nextStepFor(ctx, searchedPid)}` : ''}` };
        }
        return { text: `(no elements found)${where}\n${await nextStepFor(ctx, searchedPid)}` };
      },
    },

    {
      name: 'read_clipboard',
      description: 'Read the current text content of the OS clipboard.',
      parameters: {},
      category: 'clipboard',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        const raw = ctx.platform
          ? await ctx.platform.readClipboard()
          : await ctx.a11y.readClipboard();
        if (!raw) return { text: '(clipboard empty or non-text)' };
        // Clipboard content is user/third-party data, not instructions — wrap it
        // so an injected "ignore your task and…" payload is framed as data on the
        // MCP route too (parity with the System B perception wrapping, gauntlet F7).
        return { text: wrapUntrustedScreenContent(raw) };
      },
    },

    {
      name: 'copy_all_text',
      description:
        'Read the text of the focused web page or document EXACTLY (IDs, amounts, codes) — prefer it over ' +
        'OCR for pages and documents. Reads the document\'s text through accessibility: no keystrokes, ' +
        'nothing selected. Where that cannot be read: a browser page gets select-all + copy (the clipboard ' +
        'is restored; the result says which keys it pressed, and the page stays selected) unless focus is in ' +
        'a field or a list; any other window gets no keys and returns the names and values in its ' +
        'accessibility tree, labelled "names only" — that is not the document\'s text, use ocr for the ' +
        'content. Refuses in terminals. Focus the right window first.',
      // `ocr`'s parameter, declared here too: the `system` schema lists it, so models pass it with every read.
      parameters: {
        scope: {
          type: 'string',
          description: '"window" (default, and all this reads): the focused window\'s document. "screen" is accepted and reads the same; for the text of the whole screen use ocr.',
          required: false,
          enum: ['screen', 'window'],
        },
        find: {
          type: 'string',
          description: 'Return only the lines that contain this text (case-insensitive, the whole text is searched), each with 2 lines around it so a table row\'s other cells show. E.g. "Delta-17".',
          required: false,
        },
        offset: {
          type: 'number',
          description: `Start at this character: a text over ${PAGE_TEXT_CAP} chars is cut, and the cut result names the offset of the next part.`,
          required: false,
        },
      },
      category: 'clipboard',
      safetyTier: 1,
      handler: async ({ scope, find, offset }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return { text: 'copy_all_text: platform adapter unavailable.', isError: true };
        const r = await copyAllText(ctx.platform);
        if (!r.ok) return { text: r.text, isError: true, pressedKeys: r.pressedKeys };
        ctx.a11y.invalidateCache();
        const scopeNote = scope === 'screen' ? 'copy_all_text reads the focused window\'s document only; for the text of the whole screen use ocr.' : '';
        const note = [r.note, scopeNote].filter(Boolean).join('\n');
        // One result's worth, so every host shows it inline (#384). Page text is third-party data, not instructions.
        const part = pageTextPart(r.text, r.window ?? 'the focused window', { find, offset });
        const body = part.body ? `\n${wrapUntrustedScreenContent(part.body)}` : '';
        return { text: `${part.head}${body}${part.tail}${note ? `\n${note}` : ''}`, pressedKeys: r.pressedKeys, ...(part.isError ? { isError: true } : {}) };
      },
    },

    {
      name: 'write_clipboard',
      description: 'Write text to the OS clipboard. Overwrites what the user had copied: read it first with read_clipboard if it may matter.',
      parameters: {
        text: { type: 'string', description: 'Text to write to clipboard', required: true },
      },
      category: 'clipboard',
      safetyTier: 1,
      destructive: true,
      handler: async ({ text }, ctx) => {
        await ctx.ensureInitialized();
        if (ctx.platform) {
          await ctx.platform.writeClipboard(text);
          return { text: `Clipboard set (${text.length} chars)` };
        }
        await ctx.a11y.writeClipboard(text);
        return { text: `Clipboard set (${text.length} chars)` };
      },
    },

    {
      name: 'minimize_window',
      description: 'Minimize a window. Matches by process name, PID, or title. Cross-platform: Windows (ShowWindow), macOS (miniaturize), Linux (wmctrl/xdotool).',
      parameters: {
        processName: { type: 'string', description: 'Process name to minimize (e.g. "Calculator", "Discord")', required: false },
        processId: { type: 'number', description: 'Process ID to minimize', required: false },
        title: { type: 'string', description: 'Window title substring to match', required: false },
      },
      category: 'window',
      safetyTier: 1,
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();

        // Find the target window
        const windows = await ctx.a11y.getWindows(true);
        let target = (windows ?? []).find((w: any) => {
          if (processId && w.processId === processId) return true;
          if (processName && w.processName.toLowerCase().includes(processName.toLowerCase())) return true;
          if (title && windowTextIncludes(w.title, title)) return true;
          return false;
        });

        if (!target) return { text: `No window found matching: ${processName || processId || title}` };

        // Focus first (required for minimize shortcut), then minimize
        await ctx.a11y.focusWindow(undefined, target.processId).catch(() => {});
        await new Promise(r => setTimeout(r, 200));
        // Cross-platform: Super+Down (Windows/Linux), Cmd+M (macOS)
        const minimizeKey = process.platform === 'darwin' ? 'cmd+m' : 'super+down';
        await ctx.desktop.keyPress(minimizeKey);

        return { text: `Minimized: ${quoteScreenText(String(target.title ?? ''))} [${quoteScreenText(String(target.processName ?? ''))}] pid:${target.processId}` };
      },
    },
  ];
}
