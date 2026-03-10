/**
 * Desktop tools — screenshot, mouse, keyboard, screen info.
 *
 * Coordinate system: All mouse tools accept IMAGE-SPACE coordinates
 * (matching the 1280px-wide screenshots from desktop_screenshot).
 * The server auto-scales to Windows LOGICAL coordinates via mouseScaleFactor.
 */

import type { ToolDefinition } from './types';

/** Dangerous key combos that are blocked */
const BLOCKED_KEYS = ['alt+f4', 'ctrl+alt+delete', 'ctrl+alt+del'];

export function getDesktopTools(): ToolDefinition[] {
  return [
    // ── PERCEPTION ──

    {
      name: 'desktop_screenshot',
      description: 'Take a screenshot of the entire screen, resized to 1280px wide. Returns the image and scale metadata. Use read_screen (accessibility tree) first — only screenshot when you need visual confirmation.',
      parameters: {},
      category: 'perception',
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
      },
      category: 'perception',
      handler: async ({ x, y, width, height }, ctx) => {
        await ctx.ensureInitialized();
        const sf = ctx.getScreenshotScaleFactor();
        const frame = await ctx.desktop.captureRegionForLLM(
          Math.round(x * sf), Math.round(y * sf),
          Math.round(width * sf), Math.round(height * sf),
        );
        const base64 = frame.buffer.toString('base64');
        return {
          text: `Region: (${x},${y}) ${width}x${height} image-space → zoomed to ${frame.llmWidth}x${frame.llmHeight}px.`,
          image: { data: base64, mimeType: 'image/jpeg' },
        };
      },
    },

    {
      name: 'get_screen_size',
      description: 'Get the screen dimensions and scale factor.',
      parameters: {},
      category: 'perception',
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
      },
      category: 'mouse',
      handler: async ({ x, y }, ctx) => {
        await ctx.ensureInitialized();
        const sf = ctx.getMouseScaleFactor();
        const rx = Math.round(x * sf), ry = Math.round(y * sf);
        await ctx.desktop.mouseClick(rx, ry);
        ctx.a11y.invalidateCache();
        return { text: `Clicked at (${x}, ${y}) → logical (${rx}, ${ry})` };
      },
    },

    {
      name: 'mouse_double_click',
      description: 'Double-click the left mouse button at the given image-space coordinates.',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
      },
      category: 'mouse',
      handler: async ({ x, y }, ctx) => {
        await ctx.ensureInitialized();
        const sf = ctx.getMouseScaleFactor();
        await ctx.desktop.mouseDoubleClick(Math.round(x * sf), Math.round(y * sf));
        ctx.a11y.invalidateCache();
        return { text: `Double-clicked at (${x}, ${y})` };
      },
    },

    {
      name: 'mouse_right_click',
      description: 'Right-click at the given image-space coordinates (opens context menu).',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
      },
      category: 'mouse',
      handler: async ({ x, y }, ctx) => {
        await ctx.ensureInitialized();
        const sf = ctx.getMouseScaleFactor();
        await ctx.desktop.mouseRightClick(Math.round(x * sf), Math.round(y * sf));
        ctx.a11y.invalidateCache();
        return { text: `Right-clicked at (${x}, ${y})` };
      },
    },

    {
      name: 'mouse_hover',
      description: 'Move the mouse to the given image-space coordinates without clicking. Useful for revealing tooltips or hover menus.',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
      },
      category: 'mouse',
      handler: async ({ x, y }, ctx) => {
        await ctx.ensureInitialized();
        const sf = ctx.getMouseScaleFactor();
        await ctx.desktop.mouseMove(Math.round(x * sf), Math.round(y * sf));
        return { text: `Mouse moved to (${x}, ${y})` };
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
      },
      category: 'mouse',
      handler: async ({ startX, startY, endX, endY }, ctx) => {
        await ctx.ensureInitialized();
        const sf = ctx.getMouseScaleFactor();
        await ctx.desktop.mouseDrag(
          Math.round(startX * sf), Math.round(startY * sf),
          Math.round(endX * sf), Math.round(endY * sf),
        );
        ctx.a11y.invalidateCache();
        return { text: `Dragged (${startX},${startY}) → (${endX},${endY})` };
      },
    },

    // ── KEYBOARD ──

    {
      name: 'type_text',
      description: 'Type text into the currently focused element via clipboard paste (reliable, no dropped chars).',
      parameters: {
        text: { type: 'string', description: 'The text to type', required: true },
      },
      category: 'keyboard',
      handler: async ({ text }, ctx) => {
        await ctx.ensureInitialized();
        const active = await ctx.a11y.getActiveWindow();
        const activeInfo = active ? `[${active.processName}] "${active.title}"` : '(unknown)';
        await ctx.a11y.writeClipboard(text);
        await new Promise(r => setTimeout(r, 50));
        await ctx.desktop.keyPress('ctrl+v');
        await new Promise(r => setTimeout(r, 100));
        ctx.a11y.invalidateCache();
        return { text: `Typed ${text.length} chars into ${activeInfo}` };
      },
    },

    {
      name: 'key_press',
      description: 'Press a keyboard key or key combination. Use "+" for combos (e.g. "ctrl+s", "shift+enter", "alt+tab"). Single keys: "Return", "Tab", "Escape", "Backspace", "Delete", "F1"-"F12", "Left/Right/Up/Down".',
      parameters: {
        key: { type: 'string', description: 'Key or combo to press (e.g. "Return", "ctrl+a", "F5", "Escape")', required: true },
      },
      category: 'keyboard',
      handler: async ({ key }, ctx) => {
        await ctx.ensureInitialized();
        const lower = (key as string).toLowerCase().replace(/\s+/g, '');
        if (BLOCKED_KEYS.some(b => lower === b)) {
          return { text: `BLOCKED: "${key}" is a dangerous key combo.`, isError: true };
        }
        const active = await ctx.a11y.getActiveWindow();
        const activeInfo = active ? `[${active.processName}] "${active.title}"` : '(unknown)';
        await ctx.desktop.keyPress(key);
        ctx.a11y.invalidateCache();
        return { text: `Key pressed: ${key} in ${activeInfo}` };
      },
    },
  ];
}
