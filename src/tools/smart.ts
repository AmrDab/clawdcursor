/**
 * Smart tools — high-level name-based interaction for blind agents.
 *
 * These tools let MCP clients interact with the desktop WITHOUT needing
 * screenshots or coordinate math. They use a11y → CDP → OCR fallback chains.
 *
 * Key design: NO coordinate conversion needed by the caller.
 * The tools handle clicking internally — a11y invoke for the primary path,
 * direct coordinate click for fallbacks (a11y/OCR coords match nut-js coords).
 */

import type { ToolDefinition, ToolContext } from './types';
import { OcrEngine } from '../ocr-engine';

// Shared OCR engine singleton — avoids re-initialization per call
let sharedOcr: OcrEngine | null = null;
function getOcr(): OcrEngine {
  if (!sharedOcr) sharedOcr = new OcrEngine();
  return sharedOcr;
}

// ── Known apps with empty accessibility trees ──
// These apps expose no useful UIA nodes — skip a11y, go straight to CDP or OCR.
const EMPTY_A11Y_APPS = new Set([
  'windowsterminal', 'terminal', 'wt', 'alacritty', 'wezterm',
  'hyper', 'mintty', 'conhost',
]);

export function getSmartTools(): ToolDefinition[] {
  return [
    // ─── smart_read ──────────────────────────────────────────────────────
    {
      name: 'smart_read',
      description:
        'Read text from the screen with automatic fallback. Tries accessibility tree → CDP → OCR. ' +
        'Returns structured text without needing a screenshot. Use this as your primary perception tool.',
      parameters: {
        scope: {
          type: 'string',
          description: 'Read scope: "focused" for focused element, "window" for active window, "screen" for full screen',
          required: false,
          enum: ['focused', 'window', 'screen'],
        },
        target: {
          type: 'string',
          description: 'Element name to read from specifically',
          required: false,
        },
        processId: {
          type: 'number',
          description: 'Limit to specific process',
          required: false,
        },
      },
      category: 'perception',
      handler: async (params, ctx) => {
        await ctx.ensureInitialized();
        const scope = (params.scope as string) || 'window';
        const target = params.target as string | undefined;
        const processId = params.processId as number | undefined;

        // ── Focused element read ──
        if (scope === 'focused') {
          try {
            const el = await ctx.a11y.getFocusedElement();
            if (el) {
              return {
                text: `[via UI Automation focused element]\n${JSON.stringify(el, null, 2)}`,
              };
            }
          } catch { /* fall through */ }
        }

        // ── Target-specific read ──
        if (target) {
          try {
            const elements = await ctx.a11y.findElement({ name: target, processId });
            if (elements?.length) {
              const lines = elements.slice(0, 10).map((el: any) =>
                `[${el.controlType}] "${el.name}" id:${el.automationId} @${el.bounds.x},${el.bounds.y} ` +
                `${el.bounds.width}x${el.bounds.height}` +
                (el.value ? ` value="${el.value}"` : '') +
                (el.isEnabled === false ? ' DISABLED' : '')
              );
              return { text: `[via UI Automation search]\n${lines.join('\n')}` };
            }
          } catch { /* fall through */ }
        }

        // ── Window-level read (a11y tree) ──
        if (scope === 'window' || scope === 'focused') {
          try {
            const active = processId ?? (await ctx.a11y.getActiveWindow())?.processId;
            const activeWin = await ctx.a11y.getActiveWindow();
            const appName = activeWin?.processName?.toLowerCase() || '';

            // Skip a11y for known-empty apps
            if (!EMPTY_A11Y_APPS.has(appName)) {
              const context = await ctx.a11y.getScreenContext(active);
              if (context && context.length > 50) {
                return { text: `[via UI Automation active window]\n${context}` };
              }
            }
          } catch { /* fall through */ }
        }

        // ── CDP fallback (for browser content) ──
        try {
          if (await ctx.cdp.isConnected()) {
            const page = ctx.cdp.getPage();
            if (page) {
              const title = await page.title().catch(() => '');
              const text = await page.evaluate(() => document.body?.innerText?.substring(0, 5000) || '').catch(() => '');
              if (text) {
                return { text: `[via CDP — "${title}"]\n${text}` };
              }
            }
          }
        } catch { /* fall through */ }

        // ── OCR fallback ──
        try {
          const engine = getOcr();
          if (engine.isAvailable()) {
            const result = await engine.recognizeScreen();
            if (result.elements.length > 0) {
              // Group by line for readability
              const lines = new Map<number, typeof result.elements>();
              for (const el of result.elements) {
                const lineEls = lines.get(el.line) ?? [];
                lineEls.push(el);
                lines.set(el.line, lineEls);
              }
              const ocrLines: string[] = [];
              for (const [, lineEls] of [...lines.entries()].sort((a, b) => a[0] - b[0])) {
                ocrLines.push(lineEls.sort((a, b) => a.x - b.x).map(el => el.text).join(' '));
              }
              return {
                text: `[via OCR — ${result.elements.length} lines, ${result.durationMs}ms]\n${ocrLines.join('\n')}`,
              };
            }
          }
        } catch { /* fall through */ }

        return { text: '(could not read screen via any method)', isError: true };
      },
    },

    // ─── smart_click ─────────────────────────────────────────────────────
    {
      name: 'smart_click',
      description:
        'Click a UI element by name with automatic fallback. ' +
        'Tries accessibility → CDP → coordinate click. ' +
        'No screenshot or coordinate math needed — just provide the element text.',
      parameters: {
        target: {
          type: 'string',
          description: 'Element name/text to click (e.g., "Send", "Submit", "New Email")',
          required: true,
        },
        processId: {
          type: 'number',
          description: 'Limit search to a specific process',
          required: false,
        },
        timeout: {
          type: 'number',
          description: 'Max time in ms (default 5000)',
          required: false,
        },
      },
      category: 'orchestration',
      handler: async (params, ctx) => {
        await ctx.ensureInitialized();
        const target = params.target as string;
        const processId = params.processId as number | undefined;
        const attempted: string[] = [];

        // Detect active window and check traits
        const activeWin = await ctx.a11y.getActiveWindow().catch(() => null);
        const appName = activeWin?.processName?.toLowerCase() || '';
        const isBrowser = ['msedge', 'chrome', 'firefox', 'brave', 'arc', 'safari'].includes(appName);
        const emptyA11y = EMPTY_A11Y_APPS.has(appName);

        // ── Step 1: UIA invoke (native apps with a11y support) ──
        if (!emptyA11y) {
          try {
            const result = await ctx.a11y.invokeElement({
              name: target,
              processId: processId || activeWin?.processId,
              action: 'click',
            });

            if (result.success) {
              ctx.a11y.invalidateCache();
              return { text: `Clicked "${target}" via UI Automation (invoke_element)` };
            }

            // UIA found element but couldn't invoke — use coordinate fallback
            // a11y coordinates and nut-js mouseClick share the same coordinate system
            if (result.clickPoint) {
              await ctx.desktop.mouseClick(result.clickPoint.x, result.clickPoint.y);
              ctx.a11y.invalidateCache();
              return { text: `Clicked "${target}" via UI Automation (coordinate fallback at ${result.clickPoint.x},${result.clickPoint.y})` };
            }

            attempted.push(`UIA(invoke): element not found or not invocable`);
          } catch (err: any) {
            attempted.push(`UIA: ${err.message?.substring(0, 80)}`);
          }
        } else {
          attempted.push(`UIA(skipped): app "${appName}" has known traits: emptyAxTree`);
        }

        // ── Step 2: CDP click (for browser content) ──
        if (isBrowser || await ctx.cdp.isConnected().catch(() => false)) {
          try {
            const connected = await ctx.cdp.isConnected();
            if (connected) {
              const page = ctx.cdp.getPage();
              if (page) {
                // Try JS-based click by text
                const clicked = await page.evaluate((text: string) => {
                  const selectors = 'button, a, [role="button"], [role="link"], [role="menuitem"], input[type="submit"], input[type="button"], [onclick]';
                  const elements = document.querySelectorAll(selectors);
                  for (const el of elements) {
                    const htmlEl = el as HTMLElement;
                    const elText = htmlEl.textContent?.trim() || htmlEl.getAttribute('aria-label') || htmlEl.getAttribute('title') || '';
                    if (elText.toLowerCase().includes(text.toLowerCase())) {
                      htmlEl.click();
                      return true;
                    }
                  }
                  return false;
                }, target).catch(() => false);

                if (clicked) {
                  ctx.a11y.invalidateCache();
                  return { text: `Clicked "${target}" via CDP (JS click)` };
                }
                attempted.push('CDP: no text match found');
              }
            }
          } catch (err: any) {
            attempted.push(`CDP: ${err.message?.substring(0, 80)}`);
          }
        } else {
          attempted.push(`CDP(skipped): foreground app "${appName}" is not a browser`);
        }

        // ── Step 3: OCR text match + coordinate click ──
        try {
          const engine = getOcr();
          if (engine.isAvailable()) {
            const result = await engine.recognizeScreen();
            const targetLower = target.toLowerCase();

            // Find best matching OCR element
            let bestMatch: any = null;
            let bestScore = 0;

            for (const el of result.elements) {
              const elText = el.text.toLowerCase();
              if (elText === targetLower) {
                bestMatch = el;
                bestScore = 1;
                break; // exact match
              }
              if (elText.includes(targetLower) || targetLower.includes(elText)) {
                const score = Math.min(elText.length, targetLower.length) / Math.max(elText.length, targetLower.length);
                if (score > bestScore) {
                  bestMatch = el;
                  bestScore = score;
                }
              }
            }

            if (bestMatch && bestScore > 0.3) {
              // OCR coordinates from screenshot match nut-js mouse coordinate system
              // Click center of the matched element directly
              const centerX = bestMatch.x + Math.round(bestMatch.width / 2);
              const centerY = bestMatch.y + Math.round(bestMatch.height / 2);
              await ctx.desktop.mouseClick(centerX, centerY);
              ctx.a11y.invalidateCache();
              return { text: `Clicked "${target}" via OCR (matched "${bestMatch.text}" at ${centerX},${centerY})` };
            }
            attempted.push('ocr: no text match found');
          }
        } catch (err: any) {
          attempted.push(`ocr: ${err.message?.substring(0, 80)}`);
        }

        // All methods failed
        return {
          text: `smart_click failed: could not click "${target}" after all fallback methods.\nAttempted:\n${attempted.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}\nDiagnosis:\n  No specific failure pattern detected`,
          isError: true,
        };
      },
    },

    // ─── smart_type ──────────────────────────────────────────────────────
    {
      name: 'smart_type',
      description:
        'Type text into a UI element. If target is specified, finds and focuses the element first. ' +
        'Uses clipboard paste for reliability (no dropped characters).',
      parameters: {
        text: {
          type: 'string',
          description: 'The text to type',
          required: true,
        },
        target: {
          type: 'string',
          description: 'Element name to focus before typing (optional — types into currently focused element if omitted)',
          required: false,
        },
        processId: {
          type: 'number',
          description: 'Limit search to a specific process',
          required: false,
        },
      },
      category: 'keyboard',
      handler: async (params, ctx) => {
        await ctx.ensureInitialized();
        const text = params.text as string;
        const target = params.target as string | undefined;
        const processId = params.processId as number | undefined;

        // If target specified, find and focus it first
        if (target) {
          let focused = false;

          // Try UIA focus
          try {
            const activeWin = await ctx.a11y.getActiveWindow().catch(() => null);
            const appName = activeWin?.processName?.toLowerCase() || '';

            if (!EMPTY_A11Y_APPS.has(appName)) {
              const result = await ctx.a11y.invokeElement({
                name: target,
                processId: processId || activeWin?.processId,
                action: 'focus',
              });
              if (result.success) {
                focused = true;
              } else if (result.clickPoint) {
                // Focus failed but we have bounds — click to focus
                // a11y coords match nut-js mouse coords directly
                await ctx.desktop.mouseClick(result.clickPoint.x, result.clickPoint.y);
                await new Promise(r => setTimeout(r, 100));
                focused = true;
              }
            }
          } catch { /* fall through */ }

          // Try CDP focus (browser)
          if (!focused) {
            try {
              if (await ctx.cdp.isConnected()) {
                const page = ctx.cdp.getPage();
                if (page) {
                  const found = await page.evaluate((label: string) => {
                    // Try label-based search
                    const inputs = document.querySelectorAll('input, textarea, [contenteditable]');
                    for (const el of inputs) {
                      const htmlEl = el as HTMLElement;
                      const ariaLabel = htmlEl.getAttribute('aria-label') || '';
                      const placeholder = htmlEl.getAttribute('placeholder') || '';
                      const name = htmlEl.getAttribute('name') || '';
                      if ([ariaLabel, placeholder, name].some(a => a.toLowerCase().includes(label.toLowerCase()))) {
                        htmlEl.focus();
                        return true;
                      }
                    }
                    return false;
                  }, target).catch(() => false);
                  if (found) focused = true;
                }
              }
            } catch { /* fall through */ }
          }

          if (!focused) {
            return { text: `Could not find element "${target}" to focus before typing`, isError: true };
          }
        }

        // Type via clipboard paste
        await ctx.a11y.writeClipboard(text);
        await new Promise(r => setTimeout(r, 50));
        await ctx.desktop.keyPress('ctrl+v');
        await new Promise(r => setTimeout(r, 100));
        ctx.a11y.invalidateCache();

        const active = await ctx.a11y.getActiveWindow().catch(() => null);
        const activeInfo = active ? `[${active.processName}] "${active.title}"` : '(unknown)';
        return { text: `Typed ${text.length} chars${target ? ` into "${target}"` : ''} in ${activeInfo}` };
      },
    },

    // ─── invoke_element ──────────────────────────────────────────────────
    {
      name: 'invoke_element',
      description:
        'Invoke a UI Automation action on an element. More precise than smart_click — ' +
        'supports set-value, get-value, focus, expand, collapse in addition to click.',
      parameters: {
        name: {
          type: 'string',
          description: 'Element name to find',
          required: false,
        },
        automationId: {
          type: 'string',
          description: 'Element automation ID (more precise than name)',
          required: false,
        },
        controlType: {
          type: 'string',
          description: 'Filter by control type (e.g., "ControlType.Button")',
          required: false,
        },
        processId: {
          type: 'number',
          description: 'Target process ID',
          required: false,
        },
        action: {
          type: 'string',
          description: 'Action to perform',
          required: false,
          enum: ['click', 'set-value', 'get-value', 'focus', 'expand', 'collapse'],
        },
        value: {
          type: 'string',
          description: 'Value for set-value action',
          required: false,
        },
      },
      category: 'window',
      handler: async (params, ctx) => {
        await ctx.ensureInitialized();

        if (!params.name && !params.automationId) {
          return { text: 'Either "name" or "automationId" is required', isError: true };
        }

        try {
          const result = await ctx.a11y.invokeElement({
            name: params.name,
            automationId: params.automationId,
            controlType: params.controlType,
            processId: params.processId,
            action: params.action || 'click',
            value: params.value,
          });

          if (result.success) {
            ctx.a11y.invalidateCache();
            const valueInfo = result.value ? ` → value: "${result.value}"` : '';
            return { text: `Invoked "${params.name || params.automationId}" (${params.action || 'click'})${valueInfo}` };
          }

          // Coordinate fallback for click actions
          // a11y coords match nut-js mouse coords directly
          if (result.clickPoint && (params.action === 'click' || !params.action)) {
            await ctx.desktop.mouseClick(result.clickPoint.x, result.clickPoint.y);
            ctx.a11y.invalidateCache();
            return { text: `Invoked "${params.name || params.automationId}" via coordinate fallback (${result.clickPoint.x},${result.clickPoint.y})` };
          }

          return {
            text: `invoke_element failed: ${result.error || 'element not found or action not supported'}`,
            isError: true,
          };
        } catch (err: any) {
          return { text: `invoke_element error: ${err.message}`, isError: true };
        }
      },
    },
  ];
}
