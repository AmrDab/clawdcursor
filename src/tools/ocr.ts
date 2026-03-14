/**
 * OCR tools — expose OS-level OCR to MCP clients.
 *
 * Provides `ocr_read_screen` which returns structured text with bounding
 * box coordinates — cheaper than a screenshot + vision LLM call.
 */

import { OcrEngine } from '../ocr-engine';
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
        'Read all text on screen using OS-level OCR. Returns text elements with pixel coordinates (bounding boxes). Much cheaper than a screenshot — use this to find text, buttons, labels, and their positions. Coordinates are in real screen pixels.',
      parameters: {},
      category: 'perception',
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

        // Compute scale factor for MCP clients that need to convert OCR→mouse coordinates
        const ssf = ctx.getScreenshotScaleFactor();
        const msf = ctx.getMouseScaleFactor();
        const dpiRatio = ssf / msf;

        return {
          text: JSON.stringify({
            elementCount: result.elements.length,
            elements: result.elements,
            fullText: result.fullText,
            durationMs: result.durationMs,
            coordinateSystem: 'real_screen_pixels',
            toMouseClick: `Divide coordinates by ${dpiRatio.toFixed(4)} to convert to mouse_click image-space. Or better: use smart_click("element text") which handles conversion automatically.`,
            hint: 'Coordinates are in real screen pixels. Prefer smart_click(target) over manual coordinate math. If you must use mouse_click, divide OCR coordinates by the dpiRatio above.',
          }, null, 2),
        };
      },
    },
  ];
}
