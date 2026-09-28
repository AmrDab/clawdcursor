/**
 * Desktop tools — screenshot, mouse, keyboard, screen info.
 *
 * Coordinate system: All mouse tools accept IMAGE-SPACE coordinates
 * (matching the 1280px-wide screenshots from desktop_screenshot).
 * The server auto-scales to Windows LOGICAL coordinates via mouseScaleFactor.
 */

import * as os from 'os';
import type { ToolDefinition, ToolContext } from './types';
import { isBlockedKey } from './playbooks/keys-blocklist';

const IS_MAC = os.platform() === 'darwin';

/**
 * Coordinate space for pointer/region tools. Mirrors COORD_SPACE_SCHEMA on the
 * System B tools so the `computer` compound means the same thing on every
 * action that takes coordinates.
 *
 * This existed only on click/drag/scroll. The System A pointer tools below
 * published `space` through the compound's unioned schema but ignored it and
 * ALWAYS image-scaled, so a caller passing a11y-snapshot (physical) coords got
 * them scaled a second time and the pointer landed on a different control.
 */
export const SPACE_PARAM = {
  type: 'string' as const,
  enum: ['screen', 'image'],
  required: false,
  description: 'Coordinate space. Omit (default) → image-space coords from the latest screenshot (scaled to physical pixels). Pass "screen" → a11y-snapshot coords (already physical, not scaled).',
};


/**
 * Best-effort active-window label for a tool's result text.
 *
 * `getActiveWindow()` goes through the platform a11y bridge (the persistent
 * PowerShell/UIA process on Windows, AX on macOS, AT-SPI on Linux). That call
 * is only ever used here to ANNOTATE the result ("Key pressed: X in [app]") —
 * it is NOT load-bearing for the actual key/type action. So it must never be
 * able to block or hang the action: if the bridge is slow, recovering, or
 * wedged, we fall back to "(unknown)" after a short timeout and the keystroke
 * still goes through. OS-agnostic — applies to every platform's bridge.
 */
async function activeWindowLabel(ctx: ToolContext): Promise<string> {
  try {
    const active = await Promise.race([
      ctx.a11y.getActiveWindow(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 1500)),
    ]);
    return active ? `[${active.processName}] "${active.title}"` : '(unknown)';
  } catch {
    return '(unknown)';
  }
}

export function getDesktopTools(): ToolDefinition[] {
  return [
    // ── PERCEPTION ──

    {
      name: 'desktop_screenshot',
      description: 'LAST RESORT — take a screenshot only when the accessibility tree and OCR are both insufficient (custom canvas, icon-only UI, pixel-level verification). Prefer read_screen first, then ocr_read_screen; escalate to screenshot only when those fail. Returns the image resized to 1280px wide.',
      parameters: {},
      category: 'perception',
      compactGroup: 'computer',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        const frame = await ctx.desktop.captureForLLM();
        const base64 = frame.buffer.toString('base64');
        return {
          text: `Screenshot: ${frame.llmWidth}x${frame.llmHeight}px (real: ${frame.width}x${frame.height}, scale: ${frame.scaleFactor.toFixed(2)}x). Mouse tools accept these image-space coordinates.`,
          image: { data: base64, mimeType: 'image/jpeg' },
        };
      },
    },

    {
      name: 'desktop_screenshot_region',
      description: 'Take a zoomed screenshot of a specific screen region for detailed inspection. Coordinates are in image-space (from desktop_screenshot).',
      parameters: {
        x: { type: 'number', description: 'Left edge X in image-space coordinates', required: true },
        y: { type: 'number', description: 'Top edge Y in image-space coordinates', required: true },
        width: { type: 'number', description: 'Width in image-space pixels', required: true },
        height: { type: 'number', description: 'Height in image-space pixels', required: true },
        space: SPACE_PARAM,
      },
      category: 'perception',
      compactGroup: 'computer',
      safetyTier: 0,
      handler: async ({ x, y, width, height, space }, ctx) => {
        await ctx.ensureInitialized();
        const sf = space === 'screen' ? 1 : ctx.getScreenshotScaleFactor();
        const frame = await ctx.desktop.captureRegionForLLM(
          Math.round(x * sf), Math.round(y * sf),
          Math.round(width * sf), Math.round(height * sf),
        );
        const base64 = frame.buffer.toString('base64');
        return {
          text: `Region: (${x},${y}) ${width}x${height} ${space === 'screen' ? 'screen-space' : 'image-space'} → zoomed to ${frame.llmWidth}x${frame.llmHeight}px.`,
          image: { data: base64, mimeType: 'image/jpeg' },
        };
      },
    },

    {
      name: 'get_screen_size',
      description: 'Get the screen dimensions and scale factor.',
      parameters: {},
      category: 'perception',
      compactGroup: 'window',
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
      name: 'mouse_click',
      description: 'Click the left mouse button at the given image-space coordinates.',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
        space: SPACE_PARAM,
      },
      category: 'mouse',
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ x, y, space }, ctx) => {
        await ctx.ensureInitialized();
        const sf = space === 'screen' ? 1 : ctx.getMouseScaleFactor();
        const rx = Math.round(x * sf), ry = Math.round(y * sf);
        await ctx.desktop.mouseClick(rx, ry);
        ctx.a11y.invalidateCache();
        ctx.uiMaps?.invalidate();
        return { text: `Clicked at (${x}, ${y}) → logical (${rx}, ${ry})` };
      },
    },

    {
      name: 'mouse_double_click',
      description: 'Double-click the left mouse button at the given image-space coordinates.',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
        space: SPACE_PARAM,
      },
      category: 'mouse',
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ x, y, space }, ctx) => {
        await ctx.ensureInitialized();
        const sf = space === 'screen' ? 1 : ctx.getMouseScaleFactor();
        await ctx.desktop.mouseDoubleClick(Math.round(x * sf), Math.round(y * sf));
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
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ x, y, space }, ctx) => {
        await ctx.ensureInitialized();
        const sf = space === 'screen' ? 1 : ctx.getMouseScaleFactor();
        await ctx.desktop.mouseRightClick(Math.round(x * sf), Math.round(y * sf));
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
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ x, y, space }, ctx) => {
        await ctx.ensureInitialized();
        const sf = space === 'screen' ? 1 : ctx.getMouseScaleFactor();
        await ctx.desktop.mouseMove(Math.round(x * sf), Math.round(y * sf));
        return { text: `Mouse moved to (${x}, ${y})` };
      },
    },

    {
      name: 'cursor_position',
      description: 'Read the current mouse cursor position in image-space coordinates (the same space the mouse_* tools accept — a cursor_position read round-trips with mouse_hover). Computer-use parity: pointer-state read, no side effects.',
      parameters: {},
      category: 'mouse',
      compactGroup: 'computer',
      safetyTier: 0,
      handler: async (_args, ctx) => {
        await ctx.ensureInitialized();
        // getCursorPosition returns the space callers pass to the desktop mouse
        // fns; dividing by the SAME factor the click tools multiply by makes the
        // read the exact inverse of the write on every OS (msf ≠ screenshot
        // factor on Retina — using the wrong one halves coords on macOS).
        const pos = await ctx.desktop.getCursorPosition();
        const sf = ctx.getMouseScaleFactor() || 1;
        const img = { x: Math.round(pos.x / sf), y: Math.round(pos.y / sf) };
        return { text: `Cursor at (${img.x}, ${img.y}) in image-space.` };
      },
    },

    {
      name: 'mouse_scroll',
      description: 'Scroll the mouse wheel at the given image-space coordinates.',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
        direction: { type: 'string', description: 'Scroll direction', required: true, enum: ['up', 'down'] },
        amount: { type: 'number', description: 'Scroll amount in wheel ticks (default: 3)', required: false, default: 3 },
      },
      category: 'mouse',
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ x, y, direction, amount }, ctx) => {
        await ctx.ensureInitialized();
        const sf = ctx.getMouseScaleFactor();
        const ticks = amount ?? 3;
        const delta = direction === 'down' ? ticks : -ticks;
        await ctx.desktop.mouseScroll(Math.round(x * sf), Math.round(y * sf), delta);
        return { text: `Scrolled ${direction} ${ticks} ticks at (${x}, ${y})` };
      },
    },

    {
      name: 'mouse_drag',
      description: 'Drag from one image-space coordinate to another (click-hold-move-release). Useful for selecting text, moving objects, or resizing.',
      parameters: {
        startX: { type: 'number', description: 'Start X in image-space', required: true },
        startY: { type: 'number', description: 'Start Y in image-space', required: true },
        endX: { type: 'number', description: 'End X in image-space', required: true },
        endY: { type: 'number', description: 'End Y in image-space', required: true },
        x1: { type: 'number', description: 'Alias for startX', required: false },
        y1: { type: 'number', description: 'Alias for startY', required: false },
        x2: { type: 'number', description: 'Alias for endX', required: false },
        y2: { type: 'number', description: 'Alias for endY', required: false },
      },
      category: 'mouse',
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ startX, startY, endX, endY, x1, y1, x2, y2 }, ctx) => {
        await ctx.ensureInitialized();
        const sx = startX ?? x1;
        const sy = startY ?? y1;
        const ex = endX ?? x2;
        const ey = endY ?? y2;
        const sf = ctx.getMouseScaleFactor();
        await ctx.desktop.mouseDrag(
          Math.round(sx * sf), Math.round(sy * sf),
          Math.round(ex * sf), Math.round(ey * sf),
        );
        ctx.a11y.invalidateCache();
        ctx.uiMaps?.invalidate();
        return { text: `Dragged (${sx},${sy}) → (${ex},${ey})` };
      },
    },

    // ── KEYBOARD ──

    {
      name: 'type_text',
      description: 'Type text into the currently focused element. Internally uses clipboard paste for reliability (no dropped chars). The user clipboard is saved before and restored after, so calling type_text never clobbers any text the caller had previously placed on the clipboard.',
      parameters: {
        text: { type: 'string', description: 'The text to type', required: true },
      },
      category: 'keyboard',
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ text }, ctx) => {
        await ctx.ensureInitialized();
        const activeInfo = await activeWindowLabel(ctx);

        // Preserve the user's clipboard contents around the paste-as-type
        // operation. Without this, callers who do
        //   write_clipboard("important sentence")
        //   type_text("\nheader\n")
        //   key_press("ctrl+v")
        // get the header text re-pasted instead of the sentence — type_text
        // silently overwrote the clipboard. Save/restore makes type_text
        // transparent to the clipboard.
        let saved: string | null = null;
        try { saved = await ctx.a11y.readClipboard(); } catch { /* clipboard unreadable — leave saved=null, restore becomes a no-op below */ }

        await ctx.a11y.writeClipboard(text);
        await new Promise(r => setTimeout(r, 50));
        // Paste combo is platform-specific
        await ctx.desktop.keyPress(IS_MAC ? 'super+v' : 'ctrl+v');
        await new Promise(r => setTimeout(r, 100));

        // Restore clipboard. Best-effort — if the read failed (no clipboard
        // available) or the restore throws, we don't surface the error;
        // type_text's contract is about typing, not clipboard ops.
        if (saved !== null) {
          try { await ctx.a11y.writeClipboard(saved); } catch { /* best-effort */ }
        }

        ctx.a11y.invalidateCache();
        ctx.uiMaps?.invalidate();
        return { text: `Typed ${text.length} chars into ${activeInfo}` };
      },
    },

    {
      name: 'key_press',
      description: 'Press a keyboard key or key combination. Use "+" for a chord (e.g. "ctrl+s", "shift+enter", "alt+tab"). Separate multiple presses with SPACES to send them in sequence (e.g. "Down Down End", "ctrl+a Delete"). Single keys: "Return", "Tab", "Escape", "Backspace", "Delete", "F1"-"F12", "Left/Right/Up/Down".',
      parameters: {
        key: { type: 'string', description: 'Key/combo to press (e.g. "Return", "ctrl+a", "F5"). Space-separate combos for a sequence ("Down Down End").', required: true },
      },
      category: 'keyboard',
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ key }, ctx) => {
        await ctx.ensureInitialized();
        // Defense-in-depth: a missing/mistyped arg used to reach `.toLowerCase()`
        // on `undefined` and throw an opaque crash. Fail with an actionable
        // message instead (the `computer` compound names this field `combo`,
        // with `key` accepted as an alias).
        if (typeof key !== 'string' || key.trim() === '') {
          return { text: 'key_press: "key" is required — the key or combo to press, e.g. "Return" or "ctrl+a". (On the `computer` compound the field is `combo`; `key` is also accepted.)', isError: true };
        }
        // "+" joins a chord; whitespace separates combos pressed in sequence.
        const combos = key.trim().split(/\s+/);
        // Hard-block backstop. This carried its own 3-entry copy that omitted
        // win+l and every other machine-locking combo (GHSA-35pc-g74h-p476);
        // it now defers to the single blocklist so the two cannot drift.
        // HARD tier only — confirm-tier combos keep their allowConfirm path.
        for (const combo of combos) {
          if (isBlockedKey(combo)) {
            return { text: `BLOCKED: "${combo}" is a dangerous key combo.`, isError: true };
          }
        }
        const activeInfo = await activeWindowLabel(ctx);
        for (const combo of combos) {
          await ctx.desktop.keyPress(combo);
        }
        ctx.a11y.invalidateCache();
        ctx.uiMaps?.invalidate();
        return { text: `Key pressed: ${key} in ${activeInfo}` };
      },
    },
  ];
}
