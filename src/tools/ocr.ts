/**
 * OCR tools — expose OS-level OCR to MCP clients.
 *
 * Provides `ocr_read_screen` which returns structured text with bounding
 * box coordinates — cheaper than a screenshot + vision LLM call.
 */

import { OcrEngine } from '../platform/ocr-engine';
import type { ToolDefinition } from './types';
import { ocrPointToClickPoint } from './smart';

// Shared OcrEngine instance
let ocrEngine: OcrEngine | null = null;

function getOcrEngine(): OcrEngine {
  if (!ocrEngine) ocrEngine = new OcrEngine();
  return ocrEngine;
}

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

export function getOcrTools(): ToolDefinition[] {
  return [
    {
      name: 'ocr_read_screen',
      description:
        'Step 2 of cheap-first perception: use when the a11y tree (read_screen) is empty or too sparse to identify your target. OS-level OCR returns text elements with pixel coordinates — no image bytes, no vision model. Much cheaper than a screenshot. Coordinates are screen coordinates — click them with space:"screen". scope:"window" reads only the focused window — faster, and it does not read the text of other apps.',
      parameters: {
        scope: {
          type: 'string',
          description: '"screen" (default): the whole screen (the monitor being worked on). "window": only the focused window — focus your target first; falls back to the screen when no usable window is focused.',
          required: false,
          enum: ['screen', 'window'],
        },
      },
      category: 'perception',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async ({ scope }, ctx) => {
        await ctx.ensureInitialized();
        const engine = getOcrEngine();

        if (!engine.isAvailable()) {
          return {
            text: 'OCR is not available on this platform. Use desktop_screenshot + read_screen instead.',
            isError: true,
          };
        }

        // Screen coordinates on every OS (what space:"screen" clicks take). OCR
        // reads physical pixels; on macOS a click takes logical points (Retina 2x).
        const ratio = ctx.desktop.getDpiRatio?.() || 1;

        let read: 'screen' | 'window' = 'screen';
        let windowTitle: string | undefined;
        let result: Awaited<ReturnType<typeof engine.recognizeScreen>> | undefined;
        if (scope === 'window') {
          const win = ctx.platform ? await ctx.platform.getActiveWindow().catch(() => null) : null;
          const region = win && !win.isMinimized ? windowOcrRegion(win.bounds, ratio, process.platform) : null;
          if (region) {
            result = await engine.recognizeRegion(region.x, region.y, region.width, region.height);
            read = 'window';
            windowTitle = win!.title;
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

        const elements = result.elements.map(el => {
          const p = ocrPointToClickPoint(el.x, el.y, ratio, process.platform);
          const size = ocrPointToClickPoint(el.width, el.height, ratio, process.platform);
          return { ...el, x: p.x, y: p.y, width: size.x, height: size.y };
        });

        return {
          text: JSON.stringify({
            elementCount: elements.length,
            elements,
            fullText: result.fullText,
            durationMs: result.durationMs,
            coordinateSystem: 'screen',
            scope: read,
            ...(read === 'window' ? { window: windowTitle } : {}),
            // Screen coordinates are exact on every monitor; dividing by a scale
            // factor ignores the origin of a non-primary monitor.
            toMouseClick: 'Click these coordinates as-is with space:"screen". Or better: smart_click("element text").',
            hint: 'Coordinates are screen coordinates (any monitor, any OS). Prefer smart_click(target); otherwise pass the coordinates with space:"screen" — no conversion.',
          }, null, 2),
        };
      },
    },
  ];
}
