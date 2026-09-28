/**
 * Accessibility & window management tools.
 *
 * Text-first strategy: always try read_screen before desktop_screenshot.
 * Provides structured perception of the desktop without vision models.
 */

import type { ToolDefinition, ToolContext } from './types';
import { a11yToMouse } from './types';
import type { UiElement, WindowInfo } from '../platform/types';
import { getBrowserProcessNames } from '../llm/browser-config';
import { windowTextIncludes } from './window-text';

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
 * Note: bounding rects come back in CSS pixels; the existing `formatElement`
 * helper already expects unscaled coords, so no conversion is needed.
 */
async function queryCdpDom(
  ctx: ToolContext,
  query: { name?: string; limit?: number },
): Promise<UiElement[] | null> {
  let activeWin: any;
  try {
    activeWin = ctx.platform
      ? await ctx.platform.getActiveWindow()
      : await ctx.a11y.getActiveWindow();
  } catch {
    return null;
  }
  const appName = activeWin?.processName?.toLowerCase() || '';
  if (!getBrowserProcessNames().includes(appName)) return null;

  let connected = false;
  try { connected = await ctx.cdp.isConnected(); } catch { /* not connected */ }
  if (!connected) return null;

  const page = ctx.cdp.getPage?.();
  if (!page) return null;

  // SCOPE CHECK: the CDP connection may be to a DIFFERENT browser than the
  // focused window (e.g. the agent's own dedicated instance, or a relay
  // Chrome). Answering a query about the focused Edge using another browser's
  // DOM is actively misleading — it made an agent try to click "Continue with
  // Google" buttons that existed only in a background Chrome (session
  // 2026-06-11). Only use the CDP DOM as a fallback for THIS window when the
  // connected page corresponds to the focused window's title.
  try {
    const cdpTitle = await ctx.cdp.getTitle?.();
    const winTitle = activeWin?.title ?? '';
    // A browser window title embeds the page title ("<page> - <profile> -
    // <Browser>"). If we have a non-trivial page title and the focused window
    // does NOT contain it, the CDP target is a different window — bail rather
    // than return cross-browser results.
    if (cdpTitle && cdpTitle.trim().length > 1 && !windowTextIncludes(winTitle, cdpTitle)) {
      return null;
    }
  } catch { /* can't verify correspondence — fall through (best-effort) */ }

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

function formatWindow(w: WindowInfo): string {
  return `${w.isMinimized ? '[MIN]' : '[OK]'} [${w.processName}] "${w.title}" pid:${w.processId}` +
    (!w.isMinimized ? ` at (${w.bounds.x},${w.bounds.y}) ${w.bounds.width}x${w.bounds.height}` : ' (minimized)');
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

function formatElement(el: UiElement): string {
  return `[${el.controlType}] "${elementLabel(el)}"` +
    (el.automationId ? ` id:${el.automationId}` : '') +
    ` @${el.bounds.x},${el.bounds.y} ${el.bounds.width}x${el.bounds.height}` +
    (el.disabled || el.enabled === false ? ' DISABLED' : '') +
    (el.focused ? ' FOCUSED' : '');
}

async function getActivePid(ctx: ToolContext, processId?: number): Promise<number | undefined> {
  if (typeof processId === 'number') return processId;
  if (ctx.platform) return (await ctx.platform.getActiveWindow())?.processId;
  return (await ctx.a11y.getActiveWindow())?.processId;
}

export function getA11yTools(): ToolDefinition[] {
  return [
    {
      name: 'read_screen',
      description: 'START HERE — cheapest perception. Read the accessibility tree of the screen: returns WINDOWS, FOCUSED WINDOW UI TREE (buttons, inputs, text elements with coordinates), and FOCUSED ELEMENT. If the focused window is a browser with CDP attached, also appends a BROWSER DOM section for canvas/SPA content. Fast, structured, no image bytes — always prefer this over OCR or screenshots. Only escalate to ocr_read_screen when this tree is empty or sparse.',
      parameters: {
        processId: { type: 'number', description: 'Focus on a specific process ID (optional — reads foreground window by default)', required: false },
      },
      category: 'perception',
      compactGroup: 'accessibility',
      safetyTier: 0,
      handler: async ({ processId }, ctx) => {
        await ctx.ensureInitialized();
        let baseText: string;
        if (ctx.platform) {
          const [windows, activeWindow, focused] = await Promise.all([
            ctx.platform.listWindows().catch(() => []),
            ctx.platform.getActiveWindow().catch(() => null),
            ctx.platform.getFocusedElement().catch(() => null),
          ]);
          const active = processId ?? activeWindow?.processId;
          const tree = await ctx.platform.getUiTree(active);
          baseText = [
            'WINDOWS',
            windows.length ? windows.map(formatWindow).join('\n') : '(no windows found)',
            '',
            'FOCUSED WINDOW UI TREE',
            tree.length ? tree.slice(0, 200).map(formatElement).join('\n') : '(no elements found)',
            '',
            'FOCUSED ELEMENT',
            focused ? formatElement(focused) : '(no focused element)',
          ].join('\n');
        } else {
          const active = await getActivePid(ctx, processId);
          baseText = await ctx.a11y.getScreenContext(active);
        }
        // For a browser window the UIA tree stops at chrome — append a CDP
        // DOM digest so an agent can see actual page content (canvas apps,
        // single-page apps that bypass MSAA, etc.) without escalating to a
        // screenshot. Viewport-relative coords are flagged in the section
        // header so callers don't accidentally treat them as screen-absolute.
        const cdpHits = await queryCdpDom(ctx, { limit: 80 });
        if (cdpHits) {
          const cdpLines = cdpHits.length
            ? cdpHits.map(formatElement).join('\n')
            : '(no interactive DOM elements)';
          return {
            text: `${baseText}\n\nBROWSER DOM (via CDP, viewport-relative coords)\n${cdpLines}`,
          };
        }
        return { text: baseText };
      },
    },

    {
      name: 'get_windows',
      description: 'List all visible windows with their title, process name, PID, and bounds.',
      parameters: {},
      category: 'window',
      compactGroup: 'window',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        if (ctx.platform) {
          const windows = await ctx.platform.listWindows();
          if (!windows?.length) return { text: '(no windows found)' };
          return { text: windows.map(formatWindow).join('\n') };
        }
        const windows = await ctx.a11y.getWindows(true);
        if (!windows?.length) return { text: '(no windows found)' };
        const lines = windows.map((w: any) => formatWindow(w));
        return { text: lines.join('\n') };
      },
    },

    {
      name: 'get_active_window',
      description: 'Get the currently focused/foreground window.',
      parameters: {},
      category: 'window',
      compactGroup: 'window',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        if (ctx.platform) {
          const win = await ctx.platform.getActiveWindow();
          if (!win) return { text: '(no active window)' };
          return { text: JSON.stringify(win) };
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
      compactGroup: 'accessibility',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        if (ctx.platform) {
          const el = await ctx.platform.getFocusedElement();
          if (!el) return { text: '(no focused element)' };
          return { text: JSON.stringify(el) };
        }
        const el = await ctx.a11y.getFocusedElement();
        if (!el) return { text: '(no focused element)' };
        return { text: JSON.stringify(el) };
      },
    },

    {
      name: 'focus_window',
      description: 'Bring a window to the foreground. Matches by process name, PID, or title substring. Verifies focus after attempt.',
      parameters: {
        processName: { type: 'string', description: 'Process name to focus (e.g. "notepad", "msedge")', required: false },
        processId: { type: 'number', description: 'Process ID to focus', required: false },
        title: { type: 'string', description: 'Window title substring to match', required: false },
      },
      category: 'window',
      compactGroup: 'window',
      safetyTier: 1,
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();

        // Fix: minimize phantom off-screen full-screen windows that steal focus.
        // Win11 maximized UWP apps report bounds (-14,-14) and block SetForegroundWindow.
        try {
          const allWins = await ctx.a11y.getWindows(true);
          const phantoms = (allWins ?? []).filter((w: any) =>
            w.bounds.x < 0 && w.bounds.y < 0 &&
            w.bounds.width > 3000 && w.bounds.height > 2000 &&
            !w.isMinimized &&
            w.processId !== processId &&
            !(processName && w.processName.toLowerCase() === processName.toLowerCase())
          );
          for (const p of phantoms) {
            await ctx.a11y.focusWindow(undefined, p.processId).catch(() => {});
            await ctx.desktop.keyPress('super+down');
            await new Promise(r => setTimeout(r, 200));
          }
        } catch { /* non-fatal */ }

        let targetBounds: any = null;
        let targetPid = processId;

        // Bug 3 fix: use getWindows(true) for visible-only, filter properly, prefer on-screen windows
        if (processName && !targetPid) {
          const windows = await ctx.a11y.getWindows(true);
          let matches = (windows ?? []).filter((w: any) =>
            w.processName.toLowerCase() === processName.toLowerCase() ||
            w.processName.toLowerCase().includes(processName.toLowerCase())
          );
          // AND-match with title if provided
          if (title) {
            matches = matches.filter((w: any) => w.title.toLowerCase().includes((title as string).toLowerCase()));
          }
          // Sort: prefer on-screen windows (x >= 0, y >= 0), then non-minimized
          matches.sort((a: any, b: any) => {
            const aOnScreen = (a.bounds.x >= 0 && a.bounds.y >= 0 && !a.isMinimized) ? 1 : 0;
            const bOnScreen = (b.bounds.x >= 0 && b.bounds.y >= 0 && !b.isMinimized) ? 1 : 0;
            return bOnScreen - aOnScreen;
          });
          const win = matches[0];
          if (win) { targetPid = win.processId; targetBounds = win.bounds; }
          else return { text: `No window found for process "${processName}"`, isError: true };
        }
        if (!targetBounds && targetPid) {
          const windows = await ctx.a11y.getWindows(true);
          // Title-as-disambiguator: when caller passed BOTH pid AND title, the
          // title takes precedence as the primary key. This matters on Win11
          // Notepad where multiple windows share one pid (tab model) — without
          // this, we'd silently focus whichever tab `find` returned first,
          // which is non-deterministic across launches.
          let win: any;
          if (title) {
            const t = (title as string).toLowerCase();
            const candidates = (windows ?? []).filter((w: any) =>
              w.processId === targetPid && w.title.toLowerCase().includes(t)
            );
            // Prefer on-screen, non-minimized windows when multiple match.
            candidates.sort((a: any, b: any) => {
              const aOn = (a.bounds.x >= 0 && a.bounds.y >= 0 && !a.isMinimized) ? 1 : 0;
              const bOn = (b.bounds.x >= 0 && b.bounds.y >= 0 && !b.isMinimized) ? 1 : 0;
              return bOn - aOn;
            });
            win = candidates[0];
            if (!win) {
              // Fall back to pid-only match if no title match — caller may
              // have passed a stale title.
              win = windows?.find((w: any) => w.processId === targetPid);
            }
          } else {
            win = windows?.find((w: any) => w.processId === targetPid);
          }
          if (win?.bounds) targetBounds = win.bounds;
        }

        const result = await ctx.a11y.focusWindow(title, targetPid);
        ctx.a11y.invalidateCache();
        if (!result.success) return { text: `Failed to focus: ${result.error}`, isError: true };

        // Bug 4 fix: re-read bounds after focus (restore may have updated them)
        if (targetPid) {
          const freshWindows = await ctx.a11y.getWindows(true);
          const freshWin = freshWindows?.find((w: any) => w.processId === targetPid);
          if (freshWin?.bounds) targetBounds = freshWin.bounds;
        }

        // If window is still off-screen, snap-maximize (platform-aware)
        if (targetBounds && (targetBounds.x < 0 || targetBounds.y < 0)) {
          const snapKey = process.platform === 'darwin' ? 'ctrl+cmd+f' : 'super+up';
          await ctx.desktop.keyPress(snapKey);
          await new Promise(r => setTimeout(r, 300));
          ctx.a11y.invalidateCache();
          // Re-read bounds after snap
          if (targetPid) {
            const snapWindows = await ctx.a11y.getWindows(true);
            const snapWin = snapWindows?.find((w: any) => w.processId === targetPid);
            if (snapWin?.bounds) targetBounds = snapWin.bounds;
          }
        }

        // Click window center to physically assert focus (only when window is on-screen)
        if (targetBounds && targetBounds.x >= 0 && targetBounds.y >= 0 && targetBounds.width > 0) {
          const centerX = a11yToMouse(targetBounds.x + Math.round(targetBounds.width / 2), ctx);
          const centerY = a11yToMouse(targetBounds.y + Math.round(targetBounds.height / 4), ctx);
          await ctx.desktop.mouseClick(centerX, centerY);
          await new Promise(r => setTimeout(r, 200));
        }

        await new Promise(r => setTimeout(r, 200));
        ctx.a11y.invalidateCache();
        const active = await ctx.a11y.getActiveWindow();
        const verified = active?.processId === targetPid ||
          (processName && active?.processName.toLowerCase().includes(processName.toLowerCase())) ||
          (title && active?.title.toLowerCase().includes(title.toLowerCase()));

        if (!verified && targetBounds && targetBounds.x >= 0 && targetBounds.y >= 0 && targetBounds.width > 0) {
          const centerX = a11yToMouse(targetBounds.x + Math.round(targetBounds.width / 2), ctx);
          const centerY = a11yToMouse(targetBounds.y + Math.round(targetBounds.height / 2), ctx);
          await ctx.desktop.mouseClick(centerX, centerY);
          await new Promise(r => setTimeout(r, 300));
          ctx.a11y.invalidateCache();
          const a2 = await ctx.a11y.getActiveWindow();
          const v2 = a2?.processId === targetPid ||
            (processName && a2?.processName.toLowerCase().includes(processName.toLowerCase())) ||
            (title && a2?.title.toLowerCase().includes(title.toLowerCase()));
          return {
            text: v2 ? `Focused (retry): "${a2?.title}" [${a2?.processName}] pid:${a2?.processId}`
                     : `Focus FAILED. Foreground: "${a2?.title}" [${a2?.processName}]`,
            isError: !v2,
          };
        }
        return { text: `Focused: "${active?.title}" [${active?.processName}] pid:${active?.processId}` };
      },
    },

    {
      name: 'find_element',
      description: 'Search for UI elements by name, control type, or automation ID within a process. Returns matching elements with bounds. For browser windows with CDP attached, falls back to a DOM query when UIA returns empty so canvas / SPA content is reachable too (results are flagged with a "via CDP DOM" header and use viewport-relative coords).',
      parameters: {
        name: { type: 'string', description: 'Element name to search for', required: false },
        controlType: { type: 'string', description: 'UI Automation control type. Either form works: "Button" or "ControlType.Button". An unrecognized type returns no results rather than silently searching unfiltered.', required: false },
        automationId: { type: 'string', description: 'Automation ID', required: false },
        processId: { type: 'number', description: 'Process ID to search within', required: false },
      },
      category: 'window',
      compactGroup: 'accessibility',
      safetyTier: 0,
      handler: async ({ name, controlType, automationId, processId }, ctx) => {
        await ctx.ensureInitialized();
        let uiaHits: UiElement[];
        if (ctx.platform) {
          const elements = await ctx.platform.findElements({ name, controlType, processId });
          uiaHits = automationId
            ? elements.filter((el: UiElement) => el.automationId === automationId)
            : elements;
        } else {
          const elements = await ctx.a11y.findElement({ name, controlType, automationId, processId });
          uiaHits = (elements || []).map((el: any) => ({ ...el, enabled: el.enabled ?? el.isEnabled }));
        }
        if (uiaHits.length) {
          const lines = uiaHits.slice(0, 20).map(formatElement);
          if (uiaHits.length > 20) lines.push(`... and ${uiaHits.length - 20} more`);
          return { text: lines.join('\n') };
        }
        // UIA returned nothing. For a browser window with CDP attached, ask
        // the renderer directly — Edge/Chrome UIA stops at chrome and never
        // surfaces canvas or in-page DOM elements. Without this fallback an
        // agent calling find_element on a web app sees "(no elements found)"
        // and either gives up or escalates straight to screenshots.
        const cdpHits = await queryCdpDom(ctx, { name, limit: 20 });
        if (cdpHits && cdpHits.length) {
          const lines = ['(no UIA matches — falling back to CDP DOM; coords are viewport-relative)'];
          lines.push(...cdpHits.map(formatElement));
          return { text: lines.join('\n') };
        }
        return { text: '(no elements found)' };
      },
    },

    {
      name: 'read_clipboard',
      description: 'Read the current text content of the OS clipboard.',
      parameters: {},
      category: 'clipboard',
      compactGroup: 'system',
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
        return { text: `<untrusted-screen-content>\n${raw}\n</untrusted-screen-content>` };
      },
    },

    {
      name: 'write_clipboard',
      description: 'Write text to the OS clipboard. Tier 2 (mutation): overwrites the user\'s clipboard, which can hijack subsequent copy/paste flows. Reversibility is via a fresh user-initiated copy, not by the agent.',
      parameters: {
        text: { type: 'string', description: 'Text to write to clipboard', required: true },
      },
      category: 'clipboard',
      compactGroup: 'system',
      safetyTier: 2,
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
      // Tier 1 (input), not 2 (confirm): minimizing is trivially reversible
      // (restore_window exists) — the confirm-tier was accidental and diverged
      // from TOOL_TIER('minimize_window')='input' and the compound window
      // {action:'minimize'} surface, which allowed it freely.
      safetyTier: 1,
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();

        // Find the target window
        const windows = await ctx.a11y.getWindows(true);
        let target = (windows ?? []).find((w: any) => {
          if (processId && w.processId === processId) return true;
          if (processName && w.processName.toLowerCase().includes(processName.toLowerCase())) return true;
          if (title && w.title.toLowerCase().includes(title.toLowerCase())) return true;
          return false;
        });

        if (!target) return { text: `No window found matching: ${processName || processId || title}` };

        // Focus first (required for minimize shortcut), then minimize
        await ctx.a11y.focusWindow(undefined, target.processId).catch(() => {});
        await new Promise(r => setTimeout(r, 200));
        // Cross-platform: Super+Down (Windows/Linux), Cmd+M (macOS)
        const minimizeKey = process.platform === 'darwin' ? 'cmd+m' : 'super+down';
        await ctx.desktop.keyPress(minimizeKey);

        return { text: `Minimized: "${target.title}" [${target.processName}] pid:${target.processId}` };
      },
    },
  ];
}
