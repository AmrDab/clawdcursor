/**
 * Accessibility & window management tools.
 *
 * Text-first strategy: always try read_screen before desktop_screenshot.
 * Provides structured perception of the desktop without vision models.
 */

import type { ToolDefinition, ToolContext } from './types';
import { a11yToMouse } from './types';

export function getA11yTools(): ToolDefinition[] {
  return [
    {
      name: 'read_screen',
      description: 'Read the accessibility tree of the screen. Returns structured text showing: WINDOWS (all open windows), FOCUSED WINDOW UI TREE (buttons, inputs, text elements with coordinates), and FOCUSED ELEMENT (keyboard focus). This is fast, small, and structured — prefer this over screenshots.',
      parameters: {
        processId: { type: 'number', description: 'Focus on a specific process ID (optional — reads foreground window by default)', required: false },
      },
      category: 'perception',
      handler: async ({ processId }, ctx) => {
        await ctx.ensureInitialized();
        const active = processId ?? (await ctx.a11y.getActiveWindow())?.processId;
        const context = await ctx.a11y.getScreenContext(active);
        return { text: context };
      },
    },

    {
      name: 'get_windows',
      description: 'List all visible windows with their title, process name, PID, and bounds.',
      parameters: {},
      category: 'window',
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        const windows = await ctx.a11y.getWindows(true);
        if (!windows?.length) return { text: '(no windows found)' };
        const lines = windows.map((w: any) =>
          `${w.isMinimized ? '[MIN]' : '[OK]'} [${w.processName}] "${w.title}" pid:${w.processId}` +
          (!w.isMinimized ? ` at (${w.bounds.x},${w.bounds.y}) ${w.bounds.width}x${w.bounds.height}` : ' (minimized)')
        );
        return { text: lines.join('\n') };
      },
    },

    {
      name: 'get_active_window',
      description: 'Get the currently focused/foreground window.',
      parameters: {},
      category: 'window',
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
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
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
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
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();
        let targetBounds: any = null;
        let targetPid = processId;

        if (processName && !targetPid) {
          const win = await ctx.a11y.findWindow(processName);
          if (win) { targetPid = win.processId; targetBounds = win.bounds; }
          else return { text: `No window found for process "${processName}"`, isError: true };
        }
        if (!targetBounds && targetPid) {
          const windows = await ctx.a11y.getWindows(true);
          const win = windows?.find((w: any) => w.processId === targetPid);
          if (win?.bounds) targetBounds = win.bounds;
        }

        const result = await ctx.a11y.focusWindow(title, targetPid);
        ctx.a11y.invalidateCache();
        if (!result.success) return { text: `Failed to focus: ${result.error}`, isError: true };

        // Click window center to physically assert focus
        if (targetBounds && targetBounds.x > -100 && targetBounds.width > 0) {
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

        if (!verified && targetBounds && targetBounds.x > -100 && targetBounds.width > 0) {
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
      description: 'Search for UI elements by name, control type, or automation ID within a process. Returns matching elements with bounds.',
      parameters: {
        name: { type: 'string', description: 'Element name to search for', required: false },
        controlType: { type: 'string', description: 'UI Automation control type (e.g. "ControlType.Button")', required: false },
        automationId: { type: 'string', description: 'Automation ID', required: false },
        processId: { type: 'number', description: 'Process ID to search within', required: false },
      },
      category: 'window',
      handler: async ({ name, controlType, automationId, processId }, ctx) => {
        await ctx.ensureInitialized();
        const elements = await ctx.a11y.findElement({ name, controlType, automationId, processId });
        if (!elements?.length) return { text: '(no elements found)' };
        const lines = elements.slice(0, 20).map((el: any) =>
          `[${el.controlType}] "${el.name}" id:${el.automationId} @${el.bounds.x},${el.bounds.y} ${el.bounds.width}x${el.bounds.height}` +
          (el.isEnabled === false ? ' DISABLED' : '')
        );
        if (elements.length > 20) lines.push(`... and ${elements.length - 20} more`);
        return { text: lines.join('\n') };
      },
    },

    {
      name: 'read_clipboard',
      description: 'Read the current text content of the OS clipboard.',
      parameters: {},
      category: 'clipboard',
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        const text = await ctx.a11y.readClipboard();
        return { text: text || '(clipboard empty or non-text)' };
      },
    },

    {
      name: 'write_clipboard',
      description: 'Write text to the OS clipboard.',
      parameters: {
        text: { type: 'string', description: 'Text to write to clipboard', required: true },
      },
      category: 'clipboard',
      handler: async ({ text }, ctx) => {
        await ctx.ensureInitialized();
        await ctx.a11y.writeClipboard(text);
        return { text: `Clipboard set (${text.length} chars)` };
      },
    },
  ];
}
