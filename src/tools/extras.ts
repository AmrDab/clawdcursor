/**
 * Tranche 1B tools — thin wrappers over the PlatformAdapter primitives
 * added in Tranche 1A.
 *
 * Every tool here is OS-agnostic by construction: it calls through
 * `ctx.platform.*` and the adapter decides how to land the action on
 * the current OS (Windows PowerShell + UIA, macOS osascript + nut-js,
 * Linux wmctrl/xdotool/nut-js). When a primitive isn't supported on the
 * current OS, the adapter returns a falsy value and the tool reports it
 * as `not_supported_on_platform` rather than throwing.
 *
 * Coordinate convention: all mouse tools here take IMAGE-SPACE coords
 * (matching desktop_screenshot), scaled through `getMouseScaleFactor()`
 * just like the existing `mouse_click`. Window / keyboard tools do not
 * carry coords.
 *
 * Safety tier: tools default to 'input' via `safety/layer.ts` TOOL_TIER;
 * `close_window` is tagged 'destructive' and will require confirm when
 * SafetyLayer surfaces block/confirm.
 */

import type { ToolDefinition } from './types';
import { SPACE_PARAM } from './desktop';
import { promises as fsp } from 'node:fs';
import { windowTextIncludes } from './window-text';

function notSupported(tool: string): { text: string; isError: true } {
  return {
    text: `${tool}: not supported on this platform in the current version`,
    isError: true,
  };
}

function needPlatform(tool: string): { text: string; isError: true } {
  return {
    text: `${tool}: platform adapter not initialized — is clawdcursor running in a supported OS?`,
    isError: true,
  };
}

export function getExtraTools(): ToolDefinition[] {
  return [
    // ── MOUSE ──────────────────────────────────────────────────────

    {
      name: 'mouse_move_relative',
      description:
        'Move the cursor by a relative offset (dx, dy) in image-space pixels. ' +
        'Useful for drawing on a canvas or adjusting a selection. On Wayland ' +
        'where cursor-query APIs are blocked, uses the last known position.',
      parameters: {
        dx: { type: 'number', description: 'X offset in image-space pixels', required: true },
        dy: { type: 'number', description: 'Y offset in image-space pixels', required: true },
      },
      category: 'mouse',
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ dx, dy }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_move_relative');
        const sf = ctx.getMouseScaleFactor();
        await ctx.platform.mouseMoveRelative(Math.round(dx * sf), Math.round(dy * sf));
        return { text: `Cursor moved by (${dx}, ${dy}) image-space` };
      },
    },

    {
      name: 'mouse_middle_click',
      description: 'Middle-click (wheel-click) at image-space (x, y). Opens links in new tab in most browsers; pans in some apps.',
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
        if (!ctx.platform) return needPlatform('mouse_middle_click');
        const sf = space === 'screen' ? 1 : ctx.getMouseScaleFactor();
        await ctx.platform.mouseClick(Math.round(x * sf), Math.round(y * sf), { button: 'middle' });
        return { text: `Middle-clicked at (${x}, ${y})` };
      },
    },

    {
      name: 'mouse_triple_click',
      description: 'Triple-click the left mouse button at image-space (x, y) — selects a paragraph in most text editors. In single-line edit fields (dialog filename boxes etc.) a select-all follows automatically when the triple-click left nothing selected, so subsequent typing reliably REPLACES the existing text.',
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
        if (!ctx.platform) return needPlatform('mouse_triple_click');
        const sf = space === 'screen' ? 1 : ctx.getMouseScaleFactor();
        await ctx.platform.mouseClick(Math.round(x * sf), Math.round(y * sf), { button: 'left', count: 3 });
        // #121: Win11 dialog edit fields (Save As filename box) register the
        // triple-click but don't select-all — subsequent typing APPENDS at the
        // caret instead of replacing ("Untitledclawdcursor-…"). Callers triple-
        // click an edit field for exactly one reason: select everything. When
        // the click landed in an editable control, guarantee that intent with
        // an explicit select-all chord. Paragraph-selection in multi-line
        // editors is unaffected (select-all only fires for edit/text inputs).
        let selectAll = '';
        try {
          const fe = await ctx.platform.getFocusedElement();
          const role = (fe?.controlType ?? '').toLowerCase();
          if (/^(edit|textfield|searchfield|combobox)$/.test(role.replace(/^controltype\./, ''))) {
            const combo = ctx.platform.platform === 'darwin' ? 'cmd+a' : 'ctrl+a';
            await ctx.platform.keyPress(combo);
            selectAll = ' + select-all (edit field)';
          }
        } catch { /* best-effort — the triple-click itself already happened */ }
        return { text: `Triple-clicked at (${x}, ${y})${selectAll}` };
      },
    },

    {
      name: 'mouse_down',
      description:
        'Press a mouse button without releasing. Pair with mouse_up. ' +
        'Useful for hold-and-drag gestures, modifier-click selections, or chord input.',
      parameters: {
        button: {
          type: 'string', required: false, enum: ['left', 'right', 'middle'],
          description: 'Which button (default: left)',
        },
      },
      category: 'mouse',
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ button }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_down');
        const btn = (button as 'left' | 'right' | 'middle') ?? 'left';
        await ctx.platform.mouseDown(btn);
        return { text: `Mouse ${btn} button pressed (release with mouse_up)` };
      },
    },

    {
      name: 'mouse_up',
      description: 'Release a mouse button previously pressed with mouse_down. No-op if nothing is held.',
      parameters: {
        button: {
          type: 'string', required: false, enum: ['left', 'right', 'middle'],
          description: 'Which button (default: left)',
        },
      },
      category: 'mouse',
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ button }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_up');
        const btn = (button as 'left' | 'right' | 'middle') ?? 'left';
        await ctx.platform.mouseUp(btn);
        return { text: `Mouse ${btn} button released` };
      },
    },

    {
      name: 'mouse_scroll_horizontal',
      description:
        'Scroll horizontally at image-space (x, y). On Windows uses Shift+wheel synthesis; ' +
        'on Linux uses xdotool wheel buttons when available; on macOS uses Shift+wheel.',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
        direction: { type: 'string', description: 'Scroll direction', required: true, enum: ['left', 'right'] },
        amount: { type: 'number', description: 'Wheel ticks (default: 3)', required: false, default: 3 },
        space: SPACE_PARAM,
      },
      category: 'mouse',
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ x, y, direction, amount, space }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_scroll_horizontal');
        const sf = space === 'screen' ? 1 : ctx.getMouseScaleFactor();
        const ticks = amount ?? 3;
        await ctx.platform.mouseScroll(
          Math.round(x * sf), Math.round(y * sf),
          direction as 'left' | 'right',
          ticks,
        );
        return { text: `Scrolled ${direction} ${ticks} ticks at (${x}, ${y})` };
      },
    },

    {
      name: 'mouse_drag_stepped',
      description:
        'Drag the mouse along a multi-point path in image-space. ' +
        'Path is a JSON string of {x,y} points. Useful for Paint-style drawing ' +
        'or gesture input. Press occurs at the first point and release at the last.',
      parameters: {
        path: {
          type: 'string', required: true,
          description: 'JSON array of {"x":n, "y":n} points in image-space, min 2 points',
        },
        space: SPACE_PARAM,
      },
      category: 'mouse',
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ path, space }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_drag_stepped');
        let points: Array<{ x: number; y: number }>;
        try { points = JSON.parse(String(path)); }
        catch { return { text: 'mouse_drag_stepped: path must be a JSON array of {x,y}', isError: true }; }
        if (!Array.isArray(points) || points.length < 2) {
          return { text: 'mouse_drag_stepped: need at least 2 points', isError: true };
        }
        const sf = space === 'screen' ? 1 : ctx.getMouseScaleFactor();
        const scaled = points.map(p => ({ x: Math.round(p.x * sf), y: Math.round(p.y * sf) }));

        await ctx.platform.mouseMove(scaled[0].x, scaled[0].y);
        await ctx.platform.mouseDown('left');
        try {
          for (let i = 1; i < scaled.length; i++) {
            await ctx.platform.mouseMove(scaled[i].x, scaled[i].y);
            // Small delay between segments so apps register the drag motion.
            await new Promise(r => setTimeout(r, 16));
          }
        } finally {
          await ctx.platform.mouseUp('left');
        }
        return { text: `Stepped-drag through ${points.length} points` };
      },
    },

    // ── KEYBOARD ───────────────────────────────────────────────────

    {
      name: 'key_down',
      description:
        'Press a key (or modifier) without releasing. Pair with key_up. ' +
        'Enables hold-modifier-while-click or chord-hold workflows. ' +
        'Accepts the same tokens as key_press ("shift", "Return", "F5", etc.).',
      parameters: {
        key: { type: 'string', description: 'Key token (e.g. "shift", "ctrl", "a", "Return")', required: true },
      },
      category: 'keyboard',
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ key }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('key_down');
        await ctx.platform.keyDown(String(key));
        return { text: `Key down: ${key} (release with key_up)` };
      },
    },

    {
      name: 'key_up',
      description: 'Release a key previously pressed with key_down. No-op if not currently down.',
      parameters: {
        key: { type: 'string', description: 'Key token', required: true },
      },
      category: 'keyboard',
      compactGroup: 'computer',
      safetyTier: 1,
      handler: async ({ key }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('key_up');
        await ctx.platform.keyUp(String(key));
        return { text: `Key up: ${key}` };
      },
    },

    // ── WINDOWS ────────────────────────────────────────────────────

    {
      name: 'maximize_window',
      description:
        'Maximize the foreground window (or a specific window matched by processName/title). ' +
        'Polite request — the OS window manager may snap to the full working area.',
      parameters: {
        processName: { type: 'string', description: 'Optional process name match', required: false },
        processId:   { type: 'number', description: 'Optional process id match', required: false },
        title:       { type: 'string', description: 'Optional title-substring match', required: false },
      },
      category: 'window',
      compactGroup: 'window',
      safetyTier: 1,
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('maximize_window');
        const query = processName || processId !== undefined || title
          ? { processName, processId, title }
          : undefined;
        const ok = await ctx.platform.setWindowState('maximize', query);
        return { text: ok ? 'Window maximized.' : 'maximize request failed or ignored by WM.', isError: !ok };
      },
    },

    {
      name: 'minimize_window_to_taskbar',
      description:
        'Minimize a window (hide to taskbar/Dock). Counterpart to the existing `minimize_window` in a11y.ts ' +
        'but routed through the OS-agnostic PlatformAdapter and accepts explicit target queries.',
      parameters: {
        processName: { type: 'string', description: 'Optional process name match', required: false },
        processId:   { type: 'number', description: 'Optional process id match', required: false },
        title:       { type: 'string', description: 'Optional title-substring match', required: false },
      },
      category: 'window',
      compactGroup: 'window',
      // Tier 1 (input): minimizing is reversible (restore_window). Was tier 2
      // (confirm) by accident — see minimize_window in a11y.ts.
      safetyTier: 1,
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('minimize_window_to_taskbar');
        const query = processName || processId !== undefined || title
          ? { processName, processId, title }
          : undefined;
        const ok = await ctx.platform.setWindowState('minimize', query);
        return { text: ok ? 'Window minimized.' : 'minimize request failed.', isError: !ok };
      },
    },

    {
      name: 'restore_window',
      description:
        'Restore a minimized or maximized window back to its previous bounds. ' +
        'Use this to bring a hidden window back without toggling into fullscreen.',
      parameters: {
        processName: { type: 'string', description: 'Optional process name match', required: false },
        processId:   { type: 'number', description: 'Optional process id match', required: false },
        title:       { type: 'string', description: 'Optional title-substring match', required: false },
      },
      category: 'window',
      compactGroup: 'window',
      safetyTier: 1,
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('restore_window');
        const query = processName || processId !== undefined || title
          ? { processName, processId, title }
          : undefined;
        const ok = await ctx.platform.setWindowState('normal', query);
        return { text: ok ? 'Window restored.' : 'restore request failed.', isError: !ok };
      },
    },

    {
      name: 'close_window',
      description:
        'Polite close request — the app receives WM_CLOSE / AXCloseAction / _NET_CLOSE_WINDOW ' +
        'and may prompt ("Save changes?") or refuse. Returns when the request was posted, ' +
        'NOT when the window actually closed. NOTE: this closes the WHOLE window — on a ' +
        'tabbed app (modern Notepad, browsers, editors) that can discard MULTIPLE tabs/' +
        'documents at once, including unsaved ones. To close just one tab, prefer the ' +
        'in-app shortcut (Ctrl/Cmd+W) via the keyboard instead. Confirm-tier by default.',
      parameters: {
        processName: { type: 'string', description: 'Optional process name match', required: false },
        processId:   { type: 'number', description: 'Optional process id match', required: false },
        title:       { type: 'string', description: 'Optional title-substring match', required: false },
      },
      category: 'window',
      compactGroup: 'window',
      safetyTier: 2,
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('close_window');
        const query = processName || processId !== undefined || title
          ? { processName, processId, title }
          : undefined;
        const ok = await ctx.platform.setWindowState('close', query);
        return { text: ok ? 'Close request posted (app may prompt or refuse).' : 'close request failed.', isError: !ok };
      },
    },

    {
      name: 'resize_window',
      description:
        'Set a window\'s logical-pixel bounds. Pass only the dimensions you want to change; ' +
        'omitted fields preserve the current value. Coordinates are logical pixels — top-left origin.',
      parameters: {
        x:      { type: 'number', description: 'New X (top-left origin, logical px)', required: false },
        y:      { type: 'number', description: 'New Y (top-left origin, logical px)', required: false },
        width:  { type: 'number', description: 'New width in logical px', required: false },
        height: { type: 'number', description: 'New height in logical px', required: false },
        processName: { type: 'string', description: 'Optional process name match', required: false },
        processId:   { type: 'number', description: 'Optional process id match', required: false },
        title:       { type: 'string', description: 'Optional title-substring match', required: false },
      },
      category: 'window',
      compactGroup: 'window',
      safetyTier: 1,
      handler: async ({ x, y, width, height, processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('resize_window');
        const query = processName || processId !== undefined || title
          ? { processName, processId, title }
          : undefined;
        const ok = await ctx.platform.setWindowBounds({ x, y, width, height }, query);
        return {
          text: ok
            ? `Window bounds set: x=${x ?? '-'}, y=${y ?? '-'}, w=${width ?? '-'}, h=${height ?? '-'}`
            : 'resize request failed (WM may have refused).',
          isError: !ok,
        };
      },
    },

    {
      name: 'list_displays',
      description:
        'Enumerate all connected displays with logical bounds, physical size, DPI ratio, and primary flag. ' +
        'Use this before desktop_screenshot with displayIndex to target a specific monitor.',
      parameters: {},
      category: 'window',
      compactGroup: 'window',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('list_displays');
        const displays = await ctx.platform.listDisplays();
        return { text: JSON.stringify(displays, null, 2) };
      },
    },

    // ── ACCESSIBILITY ──────────────────────────────────────────────

    {
      name: 'focus_element',
      description:
        'Put keyboard focus on a UI element by accessibility name. Does NOT raise the window — ' +
        'use focus_window first if you also need the window in the foreground. ' +
        'Returns not_supported_on_platform on Linux (AT-SPI bridge pending).',
      parameters: {
        name:        { type: 'string', description: 'Accessibility name of the element', required: true },
        controlType: { type: 'string', description: 'Optional role filter (Button, Edit, etc.)', required: false },
        processId:   { type: 'number', description: 'Optional process id to scope the search', required: false },
      },
      category: 'perception',
      compactGroup: 'accessibility',
      safetyTier: 1,
      handler: async ({ name, controlType, processId }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('focus_element');
        if (ctx.platform.platform === 'linux') return notSupported('focus_element');
        const result = await ctx.platform.invokeElement({
          name: String(name), controlType, processId, action: 'focus',
        });
        return {
          text: result.success ? `Focused "${name}" via accessibility.` : `Focus failed for "${name}".`,
          isError: !result.success,
        };
      },
    },

    {
      name: 'wait_for_element',
      description:
        'Poll the accessibility tree until an element appears or timeout elapses. ' +
        'Useful after an action that triggers a dialog or side panel. ' +
        'Returns not_supported_on_platform on Linux (AT-SPI bridge pending).',
      parameters: {
        name:        { type: 'string', description: 'Accessibility name to match', required: false },
        controlType: { type: 'string', description: 'Role filter (e.g. "Button")', required: false },
        processId:   { type: 'number', description: 'Scope the search to a process', required: false },
        timeoutMs:   { type: 'number', description: 'Max wait in milliseconds (default 5000)', required: false, default: 5000 },
        intervalMs:  { type: 'number', description: 'Poll interval in ms (default 250)', required: false, default: 250 },
      },
      category: 'perception',
      compactGroup: 'accessibility',
      safetyTier: 0,
      handler: async ({ name, controlType, processId, timeoutMs, intervalMs }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('wait_for_element');
        if (ctx.platform.platform === 'linux') return notSupported('wait_for_element');
        const deadline = typeof timeoutMs === 'number' ? timeoutMs : 5000;
        const element = await ctx.platform.waitForElement(
          { name, controlType, processId, intervalMs: intervalMs ?? 250 },
          deadline,
        );
        if (!element) {
          return { text: `wait_for_element: timed out after ${deadline}ms`, isError: true };
        }
        return { text: JSON.stringify(element) };
      },
    },

    // ── SYSTEM INTEGRATION ────────────────────────────────────────

    {
      name: 'open_file',
      description:
        'Open a file or folder in the OS default application. ' +
        'Uses `open` (macOS), `xdg-open` (Linux), and explorer / ShellExecute (Windows). ' +
        'Tier 2 (mutation): on some platforms "opening" a file may execute it ' +
        '(.exe on Windows, .app on macOS, scripts with executable bit on Linux), ' +
        'and the registered handler can be privileged or destructive.',
      parameters: {
        path: { type: 'string', description: 'Absolute filesystem path', required: true },
      },
      category: 'orchestration',
      compactGroup: 'window',
      safetyTier: 2,
      handler: async ({ path: filePath }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('open_file');
        // Route through launchApp with a file-URL or raw path. The Windows
        // adapter handles shell: paths and Start-Process; macOS uses `open`;
        // Linux uses xdg-open fallback.
        const p = String(filePath);
        // Leaf segment — for a directory this is the Explorer window title.
        const leaf = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
        let isDir = false;
        try { isDir = (await fsp.stat(p)).isDirectory(); } catch { /* unknown/missing — treat as file */ }
        try {
          if (ctx.platform.platform === 'darwin') {
            await ctx.platform.launchApp('open', { url: p });
            return { text: `Opened: ${p}` };
          }
          if (ctx.platform.platform === 'linux') {
            await ctx.platform.launchApp('xdg-open', { url: p });
            return { text: `Opened: ${p}` };
          }
          // Windows: open the path in Explorer. For a DIRECTORY, VERIFY the
          // right folder window actually surfaced — launchApp must not fall
          // back to a Start-Menu search (which types "explorer" and opens
          // File Explorer at Home), and a pre-existing window is not proof.
          // Previously open_file returned "Opened" unconditionally even when
          // it landed on Home (live bug 2026-06-12).
          const res = await ctx.platform.launchApp('explorer.exe', { url: p, noStartMenuFallback: true });
          if (isDir) {
            const title = res?.title ?? '';
            if (!leaf || !windowTextIncludes(title, leaf)) {
              return {
                text: `open_file: launched Explorer but could NOT confirm the folder "${leaf}" opened (window: "${title || 'none'}"). The path may not exist, or Explorer focused a different window. Verify with list_windows.`,
                isError: true,
              };
            }
            return { text: `Opened folder "${leaf}" (window: "${title}")` };
          }
          return { text: `Opened: ${p}${res?.title ? ` (window: "${res.title}")` : ''}` };
        } catch (err) {
          return {
            text: `open_file failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },

    {
      name: 'open_url',
      description:
        'Open a URL in the OS default browser. Non-browser-agnostic counterpart to navigate_browser. ' +
        'Tier 1 (input): triggers network egress and may launch the registered HTTP handler ' +
        '(which can be any app, not strictly a browser). Downgraded from tier 2 in 0.9.4 ' +
        '(issue #101 bug 3) because an agent host can always reach the same primitive via ' +
        'Bash (`open <url>` on macOS, `xdg-open` on Linux, `start <url>` on Windows) — the ' +
        'tier-2 gate added friction without preventing the action. URL must start with http(s)://.',
      parameters: {
        url: { type: 'string', description: 'https:// or http:// URL', required: true },
      },
      category: 'orchestration',
      compactGroup: 'window',
      safetyTier: 1,
      handler: async ({ url }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('open_url');
        const u = String(url);
        if (!/^https?:\/\//i.test(u)) {
          return { text: 'open_url: url must start with http:// or https://', isError: true };
        }
        try {
          if (ctx.platform.platform === 'darwin') {
            await ctx.platform.launchApp('open', { url: u });
          } else if (ctx.platform.platform === 'linux') {
            await ctx.platform.launchApp('xdg-open', { url: u });
          } else {
            // Windows: launch the REGISTERED https handler directly rather than
            // `explorer.exe <url>` — the latter opens no explorer window, so
            // launchApp's window-find misses and falls back to a Start-menu
            // search (presses Win and types). The resolved browser exe has a
            // findable window and foregrounds cleanly. See agent-loop open_url.
            const { resolveSchemeHandlerExecutable } = await import('../platform/uri-handler');
            const exe = await resolveSchemeHandlerExecutable('https').catch(() => null);
            await ctx.platform.launchApp(exe ?? 'explorer.exe', { url: u });
          }
          return { text: `Opened URL: ${u}` };
        } catch (err) {
          return {
            text: `open_url failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },

    {
      // open_uri — the general OS protocol-handler escape route.
      //
      // Every OS ships a protocol-handler registry. Windows uses
      // HKCR\\<scheme>\\shell\\open\\command. macOS uses LaunchServices.
      // Linux uses xdg-mime + .desktop files. The user's installed apps
      // register themselves as handlers (or the user picks one):
      //   mailto:    → default mail client
      //   tel:       → default phone app (Skype, FaceTime, dialer)
      //   sms:       → default messaging app
      //   webcal:    → default calendar
      //   slack:     → Slack
      //   vscode:    → VS Code
      //   obsidian:  → Obsidian
      //   spotify:   → Spotify
      //   zoommtg:   → Zoom
      //   discord:   → Discord
      //   file:      → OS file-association dispatcher
      //   http(s):   → default browser
      //
      // This is THE app-agnostic escape route. ONE tool, every app that
      // registers a protocol handler. The agent does not need to know
      // which app is configured — the OS routes for us. Zero vision,
      // zero a11y, zero app-specific code.
      //
      // The agent constructs the URI from semantic args. For mailto:
      // that's to/cc/subject/body. For tel: it's just a number. For
      // slack: it's a workspace and channel. The agent picks the
      // scheme; we encode and dispatch.
      name: 'open_uri',
      description: 'Open ANY registered URI (mailto:, tel:, sms:, webcal:, file:, slack:, vscode:, obsidian:, spotify:, zoommtg:, https:, custom-scheme:, ...) via the OS protocol-handler registry. The OS routes to whichever app the user has registered as the handler. Replaces dozens of app-specific shortcuts with one general primitive. For mailto:, use the convenience helper compose_uri_mailto, or pass a full pre-built URI. Tier 2 (mutation): the OS will dispatch to whatever app is registered for the scheme — that handler may be privileged or destructive (file: opens files which on Windows can execute .exe; vscode: opens a workspace; zoommtg: joins a call). The dispatcher does no scheme allowlist — callers + the agent loop are responsible for not constructing dangerous URIs.',
      parameters: {
        uri: { type: 'string', description: 'A full URI like "mailto:bob@example.com?subject=hi&body=hello", "tel:+15551234", "slack://channel?team=T123&id=C456", "vscode://file/Users/me/code/x.ts", "https://example.com". Must be properly URL-encoded.', required: true },
      },
      category: 'orchestration',
      compactGroup: 'window',
      safetyTier: 2,
      handler: async ({ uri }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('open_uri');
        const u = String(uri ?? '').trim();
        if (!u) return { text: 'open_uri: uri is required', isError: true };
        // Surface what the URI scheme is so the operator can audit the
        // dispatch ("open_uri: mailto: → default handler").
        const schemeMatch = u.match(/^([a-z][a-z0-9+.-]*):/i);
        if (!schemeMatch) {
          return { text: 'open_uri: argument must be a URI with a scheme (e.g. mailto:, tel:, https:, slack:)', isError: true };
        }
        const scheme = schemeMatch[1].toLowerCase();
        try {
          if (ctx.platform.platform === 'darwin') {
            await ctx.platform.launchApp('open', { url: u });
            return { text: `Dispatched ${scheme}: URI to the OS default handler. (URI: ${u.length > 120 ? u.slice(0, 120) + '…' : u})` };
          }
          if (ctx.platform.platform === 'linux') {
            await ctx.platform.launchApp('xdg-open', { url: u });
            return { text: `Dispatched ${scheme}: URI to the OS default handler. (URI: ${u.length > 120 ? u.slice(0, 120) + '…' : u})` };
          }
          // Windows: shell-routed dispatch (explorer.exe mailto:, rundll32
          // url.dll, cmd /c start) silently fails for New Outlook and other
          // UWP-packaged handlers — the call returns without opening a new
          // window. The reliable path is to resolve the registered handler
          // executable and invoke IT directly, then verify a new visible
          // top-level window actually appeared.
          const { resolveSchemeHandlerExecutable, launchHandlerAndVerify, isRegisteredUriScheme, shellDispatchUriAndVerify } = await import('../platform/uri-handler');
          const exe = await resolveSchemeHandlerExecutable(scheme);
          if (!exe) {
            // No resolvable handler EXE — but some registered schemes route
            // through a DelegateExecute COM handler with no shell\open\command
            // (ms-settings:, ms-windows-store:, …). Only ShellExecute opens
            // those, so fall back to a verified shell dispatch before failing.
            if (await isRegisteredUriScheme(scheme)) {
              const shell = await shellDispatchUriAndVerify(u, () => ctx.platform!.listWindows(), { waitMs: 5000 });
              if (shell.windowOpened) {
                return { text: `Opened ${scheme}: via the OS shell handler. New window: "${shell.title ?? '(untitled)'}". (URI: ${u.length > 120 ? u.slice(0, 120) + '…' : u})` };
              }
              return {
                text: `open_uri: dispatched ${scheme}: via the OS shell but no new window appeared within 5s${shell.error ? ` (${shell.error})` : ''}. The handler may have routed into an existing window — verify with list_windows.`,
                isError: true,
              };
            }
            return {
              text: `open_uri: no registered Windows handler found for "${scheme}:". URI was not dispatched.`,
              isError: true,
            };
          }
          const launchResult = await launchHandlerAndVerify(exe, u, { waitMs: 5000 });
          if (!launchResult.success) {
            return {
              text: `open_uri: failed to launch handler "${exe}" for ${scheme}: — ${launchResult.error ?? 'unknown error'}`,
              isError: true,
            };
          }
          if (!launchResult.windowOpened) {
            return {
              text: `open_uri: handler "${exe}" was launched with ${scheme}: but no new window appeared within 5s. The handler probably routed the URI into an existing instance silently. Drive the app's UI directly instead.`,
              isError: true,
            };
          }
          return { text: `Opened ${scheme}: in the registered handler. New window appeared: "${launchResult.hwndLabel ?? '(handle unknown)'}". (URI: ${u.length > 120 ? u.slice(0, 120) + '…' : u})` };
        } catch (err) {
          return {
            text: `open_uri failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },

    {
      // build_uri — helper for the common case where the agent has
      // semantic fields (recipient, subject, body) and wants the right
      // URI without doing the encoding itself. Pure: returns the URI as
      // text, no I/O. Generalizes the old compose_email by parameterizing
      // the scheme.
      name: 'build_uri',
      description: 'Build a properly-encoded URI from a scheme + semantic fields. Returns the URI as text; pair with open_uri to dispatch it. Examples: scheme="mailto" + to/subject/body → RFC 6068 mailto URI. scheme="tel" + path="+15551234" → tel:+15551234. scheme="slack" + team/channel → slack URI.',
      parameters: {
        scheme: { type: 'string', description: 'URI scheme without the colon: mailto, tel, sms, webcal, slack, vscode, obsidian, spotify, https, etc.', required: true },
        path:   { type: 'string', description: 'Scheme-specific path (for mailto: the recipient address; for tel:/sms: the number; for https: the host+path). URL-encoded for you.', required: false },
        query:  { type: 'string', description: 'JSON object of query parameters, e.g. {"subject":"hi","body":"hello"}. Each value will be URL-encoded.', required: false },
      },
      category: 'orchestration',
      compactGroup: 'window',
      safetyTier: 0,
      handler: async ({ scheme, path, query }) => {
        const s = String(scheme ?? '').trim().toLowerCase();
        if (!s || !/^[a-z][a-z0-9+.-]*$/.test(s)) {
          return { text: 'build_uri: scheme must be lowercase letters/digits/+/./- starting with a letter', isError: true };
        }
        // Encode aggressively so cross-shell dispatch is safe; standard
        // encodeURIComponent leaves `'` and `"` literal which would trip
        // shell-meta guards.
        const safe = (v: string): string =>
          encodeURIComponent(v).replace(/'/g, '%27').replace(/"/g, '%22');
        // Path: preserve @ and , for mailto-style multi-recipient; preserve
        // + for tel: numbers. Other punctuation gets encoded.
        const encodedPath = path
          ? safe(String(path))
              .replace(/%40/g, '@')
              .replace(/%2C/g, ',')
              .replace(/%2B/g, '+')
              .replace(/%2F/g, '/')
          : '';
        let queryStr = '';
        if (query) {
          let obj: Record<string, unknown>;
          try {
            obj = typeof query === 'string' ? JSON.parse(query) : (query as Record<string, unknown>);
          } catch {
            return { text: 'build_uri: query must be valid JSON object', isError: true };
          }
          const parts: string[] = [];
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined || v === null) continue;
            parts.push(`${safe(k)}=${safe(String(v))}`);
          }
          if (parts.length) queryStr = '?' + parts.join('&');
        }
        const uri = `${s}:${encodedPath}${queryStr}`;
        return { text: uri };
      },
    },

    {
      name: 'get_system_time',
      description: 'Return the current system time as ISO 8601 UTC + local components. Zero I/O.',
      parameters: {},
      category: 'perception',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async () => {
        const now = new Date();
        return {
          text: JSON.stringify({
            iso: now.toISOString(),
            localString: now.toString(),
            epochMs: now.getTime(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        };
      },
    },

    {
      name: 'switch_tab_os',
      description:
        'Cycle or jump to a browser tab using the OS-agnostic keyboard shortcut ' +
        '(mod+Tab / mod+Shift+Tab / mod+{1..9}). Works in Chrome, Firefox, Edge, Safari. ' +
        'For in-browser DOM-level control use cdp_switch_tab.',
      parameters: {
        index: {
          type: 'number', required: false,
          description: 'Jump to tab N (1-based, 1-9). If omitted, direction must be provided.',
          minimum: 1, maximum: 9,
        },
        direction: {
          type: 'string', required: false, enum: ['next', 'previous'],
          description: 'Cycle "next" or "previous". Ignored when `index` is given.',
        },
      },
      category: 'window',
      compactGroup: 'window',
      safetyTier: 1,
      handler: async ({ index, direction }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('switch_tab_os');
        if (typeof index === 'number') {
          const n = Math.max(1, Math.min(9, Math.floor(index)));
          await ctx.platform.keyPress(`mod+${n}`);
          return { text: `Switched to tab ${n}` };
        }
        const dir = direction === 'previous' ? 'previous' : 'next';
        const combo = dir === 'next' ? 'mod+Tab' : 'mod+shift+Tab';
        await ctx.platform.keyPress(combo);
        return { text: `Cycled to ${dir} tab` };
      },
    },

    // ── META ──────────────────────────────────────────────────────

    {
      name: 'undo_last',
      description: 'Emit the OS-specific Undo shortcut (Ctrl+Z on Win/Linux, Cmd+Z on macOS) into the focused window.',
      parameters: {},
      category: 'keyboard',
      compactGroup: 'system',
      safetyTier: 1,
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('undo_last');
        await ctx.platform.keyPress('mod+z');
        return { text: 'Sent undo keystroke.' };
      },
    },

    // ── DAEMON DIAGNOSTICS (v0.9 PR7.2) ────────────────────────────
    // These three tools replace REST endpoints that the dashboard used to
    // call directly. They're intentionally minimal — clients that want
    // richer log views should consume task_logs_current instead.

    {
      name: 'logs_recent',
      description:
        'Return the last 200 captured console log entries from the daemon ' +
        '(level + timestamp + message). Empty array when no log buffer is ' +
        'attached (e.g. stdio MCP without a running daemon).',
      parameters: {
        limit: {
          type: 'number',
          description: 'Cap the number of entries returned (default 200)',
          required: false,
          minimum: 1,
          maximum: 500,
        },
      },
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async ({ limit }, ctx) => {
        const cap = typeof limit === 'number' ? Math.max(1, Math.min(500, Math.floor(limit))) : 200;
        if (!ctx.getLogBuffer) return { text: '[]' };
        const buf = ctx.getLogBuffer();
        const sliced = buf.length > cap ? buf.slice(buf.length - cap) : buf;
        return { text: JSON.stringify(sliced) };
      },
    },

    {
      name: 'submit_report',
      description:
        'Submit a redacted task-log report to clawdcursor\'s telemetry endpoint. ' +
        'Opt-in only — never runs unless explicitly invoked. Returns the ' +
        'server-issued report ID and a preview of the redacted payload, or ' +
        'an error reason when submission fails.',
      parameters: {
        userNote: {
          type: 'string',
          description: 'Optional free-text note describing what went wrong',
          required: false,
        },
        logIndex: {
          type: 'number',
          description: 'Index into the recent task logs (0 = most recent). Defaults to 0.',
          required: false,
          minimum: 0,
        },
      },
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 2,
      handler: async ({ userNote, logIndex }) => {
        try {
          const { apiSubmitReport } = await import('../surface/report');
          const result = await apiSubmitReport({
            userNote: typeof userNote === 'string' ? userNote : undefined,
            logIndex: typeof logIndex === 'number' ? logIndex : undefined,
          });
          if (result.success) {
            return {
              text: JSON.stringify({
                success: true,
                reportId: result.reportId,
                preview: result.preview,
              }),
            };
          }
          return {
            text: JSON.stringify({
              success: false,
              error: result.error,
              reportId: result.reportId,
              preview: result.preview,
            }),
            isError: true,
          };
        } catch (err) {
          return {
            text: `submit_report: ${(err as Error).message}`,
            isError: true,
          };
        }
      },
    },

  ];
}
