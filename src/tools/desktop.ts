/**
 * Desktop tools — screenshot, mouse, screen info.
 *
 * Coordinate system: All mouse tools accept IMAGE-SPACE coordinates
 * (matching the downscaled screenshots from desktop_screenshot).
 * toMouse (types.ts) maps them to the mouse's space; space:"screen" passes through.
 */

import { fenceImage } from '../core/fence';
import type { ToolDefinition, ToolContext } from './types';
import { toMouse, toImage, screenToPhysical } from './types';
import { setLastFrame, getLastFrame, mapImagePoint, mapImageLength, llmScale, LLM_TARGET_WIDTH, imageCost, pixelsPerPoint } from '../platform/coord-scale';
import { pickDisplay, displayNote } from '../platform/display-target';
import type { Display } from '../platform/types';
import { lastCaptureUnchecked } from '../platform/native-helper';

/** The fence's mask needs window bounds and the capture in one unit (pixelsPerPoint). */
function fenceBoundsScale(ctx: ToolContext): number {
  return pixelsPerPoint(Number((ctx.desktop as unknown as { dpiRatio?: number }).dpiRatio), process.platform);
}


/** The capture went ahead unchecked (#276): a missing grant would look like this image, so the agent is told. */
const uncheckedNote = (): string => lastCaptureUnchecked()
  ? '\n(Screen Recording could not be checked on this Mac — if this image shows only the desktop background, the app running clawdcursor needs Screen Recording.)'
  : '';

/** A screenshot is the last resort: a target with a visible label is reached by name, not by the coordinates this image gives. */
const LABEL_TAIL = ' If the target has a visible label, click it with smart_click {"target":"<label>"} instead of coordinates.';

/**
 * What to tell the agent after a zoomed view: clicks never take coordinates from the zoomed image — they stay in the space of the
 * full screenshot (or of the screen, for a screen-space region) — so the way back is arithmetic the reply spells out.
 */
function zoomNote(r: { x: number; y: number; width: number; height: number; space?: string; display?: number }, outW: number, outH: number): string {
  const conv = `x = ${r.x} + zx·${r.width}/${outW}, y = ${r.y} + zy·${r.height}/${outH}`;
  if (r.space === 'screen') {
    return ` Clicks stay in full-screen coordinates, not zoomed-image ones: a point (zx,zy) seen in this image is ${conv} — click it with space:"screen".`;
  }
  // An explicit display does not change which monitor image-space clicks land on: that is the latest screenshot's.
  return typeof r.display === 'number'
    ? ` Clicks stay in full-screenshot coordinates, not zoomed-image ones: a point (zx,zy) seen in this image is ${conv} in the image space of display #${r.display}'s screenshot. Clicks land on the monitor of the latest screenshot: take a screenshot with display:${r.display} first if it showed another one.`
    : ` Clicks stay in full-screenshot coordinates, not zoomed-image ones: a point (zx,zy) seen in this image is ${conv} in the screenshot's image space.`;
}

/** Why an explicit `display` cannot be shown (screenshot and zoom share the selector), or null. */
function displayRefusal(displays: Display[], explicit: number | undefined, target: Display | null): string | null {
  if (explicit === undefined) return null;
  if (!target) {
    return `No display #${explicit}. Displays: ${displays.map(d => `#${d.index} ${d.bounds.width}x${d.bounds.height} at (${d.bounds.x},${d.bounds.y})`).join(', ') || 'none found'}.`;
  }
  // macOS captures the main display only (for now) — say so rather than
  // label the main display's image as display N.
  if (process.platform === 'darwin' && !target.primary) {
    return `display:${explicit} is not supported on macOS yet — screenshots show the main display. Omit display.`;
  }
  return null;
}

/**
 * Coordinate space for pointer/region tools. Mirrors COORD_SPACE_SCHEMA on the
 * System B tools so the `computer` compound means the same thing on every
 * action that takes coordinates.
 */
export const SPACE_PARAM = {
  type: 'string' as const,
  enum: ['screen', 'image'],
  required: false,
  description: 'Coordinate space. Omit (default) → image-space coords from the latest screenshot (the tool scales them to the screen). Pass "screen" → the positions an accessibility tree / find reports (@x,y), passed as reported, unscaled: physical pixels on Windows and Linux, POINTS on macOS (a Retina screenshot\'s "real" size is twice the point size).',
};


const MAX_EDGE_PARAM = {
  type: 'number' as const, required: false,
  description: `Longest edge of the returned image in px (64–${LLM_TARGET_WIDTH}, default ${LLM_TARGET_WIDTH}). Smaller costs fewer image tokens; small text may become unreadable.`,
};
/** The `max_edge` a caller asked for, clamped to what a capture can use; the default size otherwise. */
const maxEdgeOf = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(LLM_TARGET_WIDTH, Math.max(64, Math.round(v))) : LLM_TARGET_WIDTH;

export function getDesktopTools(): ToolDefinition[] {
  return [
    // ── PERCEPTION ──

    {
      name: 'desktop_screenshot',
      description: 'LAST RESORT — take a screenshot only when the accessibility tree and OCR are both insufficient (custom canvas, icon-only UI, pixel-level verification). Prefer read_screen first, then ocr_read_screen; escalate to screenshot only when those fail. Returns the image downscaled to fit 1280px on its long edge, or max_edge (the reply states its size, cost and scale; clicks use its coordinates).',
      parameters: {
        display: { type: 'number', description: 'Monitor to capture (index from window list_displays). Default: the monitor clawdcursor last worked on, else the primary.', required: false },
        max_edge: MAX_EDGE_PARAM,
      },
      category: 'perception',
      safetyTier: 0,
      handler: async ({ display, max_edge }, ctx) => {
        await ctx.ensureInitialized();
        const edge = maxEdgeOf(max_edge);
        const explicit = typeof display === 'number' ? display : undefined;
        const displays = ctx.platform ? await ctx.platform.listDisplays().catch(() => []) : [];
        const target = pickDisplay(displays, explicit);
        const refusal = displayRefusal(displays, explicit, target);
        if (refusal) return { text: refusal, isError: true };
        // Any monitor other than the primary. Windows captures it through the
        // bridge (nut-js only grabs the primary); Linux X11 crops it from the
        // root window when asked for explicitly. Coordinates read off this
        // image map back onto THAT monitor via the recorded frame.
        const otherMonitor = target && !target.primary && ctx.platform
          && (process.platform === 'win32' || (process.platform === 'linux' && explicit !== undefined));
        if (otherMonitor) {
          const shot = await ctx.platform!.screenshot({ maxWidth: edge, displayIndex: target!.index });
          const o = shot.origin ?? { x: target!.bounds.x, y: target!.bounds.y };
          setLastFrame({ originX: o.x, originY: o.y, scale: shot.scaleFactor, display: target!.index });
          return {
            text: `Screenshot: ${imageCost(shot.width, shot.height)} of display #${target!.index} (real: ${target!.bounds.width}x${target!.bounds.height} at (${target!.bounds.x},${target!.bounds.y}), scale: ${shot.scaleFactor.toFixed(2)}x). Mouse tools accept these image-space coordinates.${displayNote(displays, target!)}${LABEL_TAIL}`,
            // Under the test fence only the fenced window is shown: the rest is blacked out (core/fence.ts).
            image: await fenceImage(shot.buffer, 'image/png', { originX: o.x, originY: o.y, scale: shot.scaleFactor, boundsScale: fenceBoundsScale(ctx) }),
          };
        }
        const frame = await ctx.desktop.captureForLLM(edge);
        setLastFrame(null);
        const image = await fenceImage(frame.buffer, 'image/jpeg', { originX: 0, originY: 0, scale: frame.scaleFactor, boundsScale: fenceBoundsScale(ctx) });
        const note = target && (process.platform === 'win32' || explicit !== undefined) ? displayNote(displays, target) : '';
        return {
          text: `Screenshot: ${imageCost(frame.llmWidth, frame.llmHeight)} (real: ${frame.width}x${frame.height}, scale: ${frame.scaleFactor.toFixed(2)}x). Mouse tools accept these image-space coordinates.${note}${uncheckedNote()}${LABEL_TAIL}`,
          image,
        };
      },
    },

    {
      name: 'desktop_screenshot_region',
      description: 'Take a zoomed screenshot of a specific screen region for detailed inspection, or to check only what changed (pass max_edge to pay less). Coordinates are in image-space (from desktop_screenshot).',
      parameters: {
        x: { type: 'number', description: 'Left edge X in image-space coordinates', required: true },
        y: { type: 'number', description: 'Top edge Y in image-space coordinates', required: true },
        width: { type: 'number', description: 'Width in image-space pixels', required: true },
        height: { type: 'number', description: 'Height in image-space pixels', required: true },
        space: SPACE_PARAM,
        display: { type: 'number', description: 'Monitor whose screenshot the image-space region was read off (index from window list_displays). Default: the monitor of the latest screenshot.', required: false },
        max_edge: MAX_EDGE_PARAM,
      },
      category: 'perception',
      safetyTier: 0,
      handler: async ({ x, y, width, height, space, display, max_edge }, ctx) => {
        await ctx.ensureInitialized();
        // Region in physical screen px: through the last frame (any monitor)
        // for image coords; by screenToPhysical for screen coords (points on
        // macOS). An explicit display stands in for the last frame: the frame
        // a screenshot of it records.
        let mapping = getLastFrame();
        if (typeof display === 'number') {
          const displays = ctx.platform ? await ctx.platform.listDisplays().catch(() => []) : [];
          const target = pickDisplay(displays, display);
          const refusal = displayRefusal(displays, display, target);
          if (refusal) return { text: refusal, isError: true };
          const b = target!.bounds;
          // The latest screenshot of that monitor knows its own scale (max_edge); only another monitor's is rebuilt at the default size.
          if (mapping?.display !== target!.index) {
            mapping = target!.primary ? null : { originX: b.x, originY: b.y, scale: llmScale(b.width, b.height), display: target!.index };
          }
        }
        const multi = !!mapping;
        const sf = space === 'screen' ? screenToPhysical(ctx) : ctx.getScreenshotScaleFactor();
        const p0 = space === 'screen' || !multi ? { x: Math.round(x * sf), y: Math.round(y * sf) } : mapImagePoint(x, y, sf, mapping);
        const w = space === 'screen' || !multi ? Math.round(width * sf) : mapImageLength(width, sf, mapping);
        const h = space === 'screen' || !multi ? Math.round(height * sf) : mapImageLength(height, sf, mapping);
        if (process.platform === 'win32' && ctx.platform) {
          // Windows: the bridge captures any rectangle on any monitor; if it is
          // down, fall back to the primary-display capture below.
          const shot = await ctx.platform.screenshot({ maxWidth: maxEdgeOf(max_edge), region: { x: p0.x, y: p0.y, width: w, height: h } }).catch(() => null);
          if (shot) {
            return {
              text: `Region: (${x},${y}) ${width}x${height} ${space === 'screen' ? 'screen-space' : 'image-space'} → zoomed to ${imageCost(shot.width, shot.height)}.${zoomNote({ x, y, width, height, space, display }, shot.width, shot.height)}`,
              // The captured rectangle is (p0, w x h) on screen: the same capture path as a full screenshot (core/fence.ts).
              image: await fenceImage(shot.buffer, 'image/png', { originX: p0.x, originY: p0.y, screenWidth: w, boundsScale: fenceBoundsScale(ctx) }),
            };
          }
        }
        const frame = await ctx.desktop.captureRegionForLLM(p0.x, p0.y, w, h, maxEdgeOf(max_edge));
        const image = await fenceImage(frame.buffer, 'image/jpeg', { originX: p0.x, originY: p0.y, screenWidth: w, boundsScale: fenceBoundsScale(ctx) });
        return {
          text: `Region: (${x},${y}) ${width}x${height} ${space === 'screen' ? 'screen-space' : 'image-space'} → zoomed to ${imageCost(frame.llmWidth, frame.llmHeight)}.${zoomNote({ x, y, width, height, space, display }, frame.llmWidth, frame.llmHeight)}${uncheckedNote()}`,
          image,
        };
      },
    },

    {
      name: 'get_screen_size',
      description: 'Get the screen dimensions and scale factor.',
      parameters: {},
      category: 'perception',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        const size = ctx.desktop.getScreenSize();
        const msf = ctx.getMouseScaleFactor();
        const ssf = ctx.getScreenshotScaleFactor();
        return {
          text: JSON.stringify({
            physicalWidth: size.width,
            physicalHeight: size.height,
            screenshotScaleFactor: ssf,
            mouseScaleFactor: msf,
            imageWidth: Math.round(size.width / ssf),
            imageHeight: Math.round(size.height / ssf),
          }),
        };
      },
    },

    // ── MOUSE ──

    {
      name: 'mouse_double_click',
      description: 'Double-click the left mouse button at the given image-space coordinates.',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
        space: SPACE_PARAM,
      },
      category: 'mouse',
      safetyTier: 1,
      handler: async ({ x, y, space }, ctx) => {
        await ctx.ensureInitialized();
        const p = toMouse(ctx, x, y, space);
        await ctx.desktop.mouseDoubleClick(p.x, p.y);
        ctx.a11y.invalidateCache();
        ctx.uiMaps?.invalidate();
        return { text: `Double-clicked at (${x}, ${y})` };
      },
    },

    {
      name: 'mouse_right_click',
      description: 'Right-click at the given image-space coordinates (opens context menu).',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
        space: SPACE_PARAM,
      },
      category: 'mouse',
      safetyTier: 1,
      handler: async ({ x, y, space }, ctx) => {
        await ctx.ensureInitialized();
        const p = toMouse(ctx, x, y, space);
        await ctx.desktop.mouseRightClick(p.x, p.y);
        ctx.a11y.invalidateCache();
        ctx.uiMaps?.invalidate();
        return { text: `Right-clicked at (${x}, ${y})` };
      },
    },

    {
      name: 'mouse_hover',
      description: 'Move the mouse to the given image-space coordinates without clicking. Useful for revealing tooltips or hover menus.',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
        space: SPACE_PARAM,
      },
      category: 'mouse',
      safetyTier: 1,
      handler: async ({ x, y, space }, ctx) => {
        await ctx.ensureInitialized();
        const p = toMouse(ctx, x, y, space);
        await ctx.desktop.mouseMove(p.x, p.y);
        return { text: `Mouse moved to (${x}, ${y})` };
      },
    },

    {
      name: 'cursor_position',
      description: 'Read the current mouse cursor position in image-space coordinates (the same space the mouse_* tools accept — a cursor_position read round-trips with mouse_hover). Computer-use parity: pointer-state read, no side effects.',
      parameters: {},
      category: 'mouse',
      safetyTier: 0,
      handler: async (_args, ctx) => {
        await ctx.ensureInitialized();
        // getCursorPosition returns the space callers pass to the desktop mouse
        // fns; dividing by the SAME factor the click tools multiply by makes the
        // read the exact inverse of the write on every OS (msf ≠ screenshot
        // factor on Retina — using the wrong one halves coords on macOS).
        const pos = await ctx.desktop.getCursorPosition();
        const img = toImage(ctx, pos.x, pos.y);
        return { text: `Cursor at (${img.x}, ${img.y}) in image-space.` };
      },
    },
  ];
}
