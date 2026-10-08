/**
 * OCR tools — expose OS-level OCR to MCP clients.
 *
 * Provides `ocr_read_screen` which returns structured text with bounding
 * box coordinates — cheaper than a screenshot + vision LLM call.
 */

import { OcrEngine } from '../platform/ocr-engine';
import type { ToolDefinition } from './types';

// Shared OcrEngine instance
let ocrEngine: OcrEngine | null = null;

function getOcrEngine(): OcrEngine {
  if (!ocrEngine) ocrEngine = new OcrEngine();
  return ocrEngine;
}

export function getOcrTools(): ToolDefinition[] {
  return [
    {
      name: 'ocr_read_screen',
      description:
        'Step 2 of cheap-first perception: use when the a11y tree (read_screen) is empty or too sparse to identify your target. OS-level OCR returns text elements with pixel coordinates — no image bytes, no vision model. Much cheaper than a screenshot. Coordinates are in real screen pixels.',
      parameters: {},
      category: 'perception',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        const engine = getOcrEngine();

        if (!engine.isAvailable()) {
          return {
            text: 'OCR is not available on this platform. Use desktop_screenshot + read_screen instead.',
            isError: true,
          };
        }

        const result = await engine.recognizeScreen();

        if (result.elements.length === 0) {
          return {
            text: JSON.stringify({
              elements: [],
              fullText: '',
              durationMs: result.durationMs,
              hint: 'No text detected. Screen may be blank or contain only images. Try desktop_screenshot for visual content.',
            }),
          };
        }

        return {
          text: JSON.stringify({
            elementCount: result.elements.length,
            elements: result.elements,
            fullText: result.fullText,
            durationMs: result.durationMs,
            coordinateSystem: 'real_screen_pixels',
            // Screen coordinates are exact on every monitor; dividing by a scale
            // factor ignores the origin of a non-primary monitor.
            toMouseClick: 'Click these coordinates as-is with space:"screen". Or better: smart_click("element text").',
            hint: 'Coordinates are in real screen pixels (any monitor). Prefer smart_click(target); otherwise pass the coordinates with space:"screen" — no conversion.',
          }, null, 2),
        };
      },
    },
  ];
}
