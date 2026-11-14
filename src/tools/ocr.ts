/**
 * OCR tools — expose OS-level OCR to MCP clients.
 *
 * Provides `ocr_read_screen` which returns structured text with bounding
 * box coordinates — cheaper than a screenshot + vision LLM call.
 */

import { ocrEngine } from '../platform/ocr-engine';
import { screenLockedMessage } from '../platform/mac-ax';
import { screenJson, wrapUntrustedScreenContent } from '../core/untrusted-screen-content';
import { getWorkingPoint } from '../platform/display-target';
import type { OcrElement } from '../platform/ocr-engine';
import type { ToolDefinition } from './types';
import { ocrPointToClickPoint } from './smart';


/**
 * Physical-pixel rectangle (what the OCR engine crops) for a window's bounds,
 * or null when the window has no usable area. `bounds` are screen coordinates:
 * physical pixels on Windows / Linux, logical points on macOS (physical = ×ratio).
 */
export function windowOcrRegion(
  bounds: { x: number; y: number; width: number; height: number } | undefined,
  dpiRatio: number,
  platform: NodeJS.Platform,
): { x: number; y: number; width: number; height: number } | null {
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null;
  const k = platform === 'darwin' ? (dpiRatio || 1) : 1;
  return { x: Math.round(bounds.x * k), y: Math.round(bounds.y * k), width: Math.round(bounds.width * k), height: Math.round(bounds.height * k) };
}

/**
 * The words of a read as rows of `@x,y "text"`: x,y is the centre of the text, in the space `toScreen` gives (screen
 * coordinates). Words of one OCR line that sit together are one row; a wide gap (the next tab, button or column) starts
 * another, so each control keeps a position of its own. The gap rule is smart_click's.
 */
export function ocrRows(elements: OcrElement[], toScreen: (x: number, y: number) => { x: number; y: number }): string[] {
  const byLine = new Map<number, OcrElement[]>();
  for (const el of elements) byLine.set(el.line, [...(byLine.get(el.line) ?? []), el]);
  const rows: string[] = [];
  for (const [, words] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...words].sort((a, b) => a.x - b.x);
    let run: OcrElement[] = [];
    const flush = () => {
      if (!run.length) return;
      const left = Math.min(...run.map(w => w.x)), top = Math.min(...run.map(w => w.y));
      const right = Math.max(...run.map(w => w.x + w.width)), bottom = Math.max(...run.map(w => w.y + w.height));
      const c = toScreen((left + right) / 2, (top + bottom) / 2);
      rows.push(`@${c.x},${c.y} ${JSON.stringify(run.map(w => w.text).join(' '))}`);
      run = [];
    };
    for (const w of sorted) {
      const prev = run[run.length - 1];
      if (prev && w.x - (prev.x + prev.width) > Math.max(prev.height * 1.5, 30)) flush();
      run.push(w);
    }
    flush();
  }
  return rows;
}

export function getOcrTools(): ToolDefinition[] {
  return [
    {
      name: 'ocr_read_screen',
      description:
        'Step 2 of cheap-first perception: use when the a11y tree (read_screen) is empty or too sparse to identify your target. OS-level OCR returns text elements with pixel coordinates — no image bytes, no vision model. Much cheaper than a screenshot. Coordinates are screen coordinates — click them with space:"screen". scope:"window" reads only the focused window — faster, and it does not read the text of other apps; it answers in text rows, `@x,y "text"` with x,y the centre of the text, after a first line that says which window was read. scope:"screen" answers in JSON, one element per word; there, `confidence`, when the OS engine gives one, is that engine\'s own doubt signal: low means it likely misread; 1 does not mean the text is right.',
      parameters: {
        scope: {
          type: 'string',
          description: '"screen" (default): the whole screen (the monitor being worked on). "window": only the focused window — focus your target first; falls back to the screen when no usable window is focused.',
          required: false,
          enum: ['screen', 'window'],
        },
      },
      category: 'perception',
      safetyTier: 0,
      handler: async ({ scope }, ctx) => {
        await ctx.ensureInitialized();
        const engine = ocrEngine();

        if (!engine.isAvailable()) {
          return {
            text: 'OCR is not available on this platform. Use desktop_screenshot + read_screen instead.',
            isError: true,
          };
        }

        const lockedMsg = await screenLockedMessage();
        if (lockedMsg) return { text: lockedMsg, isError: true };

        // Screen coordinates on every OS (what space:"screen" clicks take). OCR
        // reads physical pixels; on macOS a click takes logical points (Retina 2x).
        const ratio = ctx.desktop.getDpiRatio?.() || 1;

        let read: 'screen' | 'window' = 'screen';
        let windowTitle: string | undefined;
        let windowBounds: { x: number; y: number; width: number; height: number } | undefined;
        let result: Awaited<ReturnType<typeof engine.recognizeScreen>> | undefined;
        if (scope === 'window') {
          const win = ctx.platform ? await ctx.platform.getActiveWindow().catch(() => null) : null;
          const region = win && !win.isMinimized ? windowOcrRegion(win.bounds, ratio, process.platform) : null;
          if (region) {
            result = await engine.recognizeRegion(region.x, region.y, region.width, region.height);
            read = 'window';
            windowTitle = win!.title;
            windowBounds = win!.bounds;
          }
        }
        if (!result) result = await engine.recognizeScreen();

        if (result.elements.length === 0) {
          return {
            text: JSON.stringify({
              elements: [],
              fullText: '',
              durationMs: result.durationMs,
              scope: read,
              hint: read === 'window'
                ? 'No text detected in the focused window. Try scope:"screen", or desktop_screenshot for visual content.'
                : 'No text detected. Screen may be blank or contain only images. Try desktop_screenshot for visual content.',
            }),
          };
        }

        // A window read: rows of text, and FIRST which window it was and where. The reply used to name the window after
        // every element, so a read of another window than the one the agent meant passed for the right one.
        if (read === 'window' && windowBounds) {
          const b = windowBounds;
          const rows = ocrRows(result.elements, (x, y) => ocrPointToClickPoint(x, y, ratio, process.platform));
          const at = getWorkingPoint();
          const elsewhere = at && !(at.x >= b.x && at.x < b.x + b.width && at.y >= b.y && at.y < b.y + b.height)
            ? ` You last worked at (${at.x},${at.y}), outside this window: if you meant another window, focus it first and read again.`
            : '';
          return {
            text: `OCR of the focused window at (${b.x},${b.y}) ${b.width}x${b.height}: ${result.elements.length} words, ${result.durationMs} ms. ` +
              `Each row is @x,y "text": x,y is the centre of the text in screen coordinates, click it as-is with space:"screen", or smart_click {"target":"<label>"}.${elsewhere}\n` +
              wrapUntrustedScreenContent([`window: ${(windowTitle ?? '').replace(/\s+/g, ' ')}`, ...rows].join('\n')),
          };
        }

        const elements = result.elements.map(el => {
          const p = ocrPointToClickPoint(el.x, el.y, ratio, process.platform);
          const size = ocrPointToClickPoint(el.width, el.height, ratio, process.platform);
          return { ...el, x: p.x, y: p.y, width: size.x, height: size.y };
        });

        return {
          text: screenJson({
            scope: read,
            ...(scope === 'window' ? { note: 'scope:"window" was asked, but no focused window could be read (none in front, or it is minimized): this is the whole screen.' } : {}),
            elementCount: elements.length,
            elements,
            fullText: result.fullText,
            durationMs: result.durationMs,
            coordinateSystem: 'screen',
            // Screen coordinates are exact on every monitor; dividing by a scale
            // factor ignores the origin of a non-primary monitor.
            toMouseClick: 'Click these coordinates as-is with space:"screen". Or better: smart_click {"target":"element text"}.',
            hint: 'Coordinates are screen coordinates (any monitor, any OS). Prefer smart_click {"target":"<label>"}; otherwise pass the coordinates with space:"screen" — no conversion.',
          }, 2),
        };
      },
    },
  ];
}
