/**
 * Tranche 1B tools — thin wrappers over the PlatformAdapter primitives
 * added in Tranche 1A.
 *
 * Every tool here is OS-agnostic by construction: it calls through
 * `ctx.platform.*` and the adapter decides how to land the action on
 * the current OS (Windows PowerShell + UIA, macOS osascript + nut-js,
 * Linux wmctrl/xdotool/nut-js).
 *
 * Coordinate convention: all mouse tools here take IMAGE-SPACE coords
 * (matching desktop_screenshot), scaled through `getMouseScaleFactor()`.
 *
 * Every tool here is an input tool (safetyTier 1) unless it only reads; the ones that are destructive by
 * themselves (`open_file`, `open_uri`) say `destructive: true` (see ToolDefinition.destructive).
 */

import type { ToolDefinition } from './types';
import { MOD } from '../platform/keys';
import { screenJson, quoteScreenText } from '../core/untrusted-screen-content';
import { toMouse } from './types';
import { SPACE_PARAM } from './desktop';
import { openFilePath } from './open-file';

function needPlatform(tool: string): { text: string; isError: true } {
  return {
    text: `${tool}: platform adapter not initialized — is clawdcursor running in a supported OS?`,
    isError: true,
  };
}

export function getExtraTools(): ToolDefinition[] {
  return [
    // ── REPORT ─────────────────────────────────────────────────────
    {
      name: 'session_report',
      description:
        'Prepare a report of THIS session for the clawdcursor team when something went wrong: ' +
        'which tools ran, blind vs screenshot use, errors — no typed text, clipboard, screenshots, ' +
        'names or paths. Sends nothing: returns a prefilled GitHub issue link to give the USER, ' +
        'who reviews and submits it. Pass `note` with what went wrong.',
      parameters: {
        note: { type: 'string', description: 'What went wrong, in a sentence or two', required: false },
      },
      category: 'orchestration',
      safetyTier: 0,
      handler: async ({ note }) => {
        const { buildSessionReport, saveReportLocally, issueUrl, reportMarkdown } = await import('../surface/report');
        const report = buildSessionReport(undefined, typeof note === 'string' && note.trim() ? note.trim() : undefined);
        const saved = saveReportLocally(report);
        return {
          text:
            'Session report prepared — NOTHING has been sent.\n\n' +
            `${reportMarkdown(report)}\n\n` +
            'To send it, give the user this link: it opens a prefilled GitHub issue they review and submit.\n' +
            `${issueUrl(report)}\n\n(Full report saved locally: ${saved})`,
        };
      },
    },

    {
      name: 'telemetry_optout',
      description:
        'Turn off clawdcursor\'s anonymous error reports (error codes and its own file:line, never screen content). ' +
        'Only when the user asks. There is no opt-in here: the user runs `clawdcursor optin` themselves.',
      parameters: {},
      category: 'orchestration',
      safetyTier: 0,
      handler: async () => {
        const { setTelemetryEnabled, STATE_FILE } = await import('../core/observability/telemetry');
        return setTelemetryEnabled(false)
          ? { text: 'Anonymous error reports are off. The user can turn them back on with `clawdcursor optin`.' }
          : { text: `telemetry_optout: could not write ${STATE_FILE}; the user can run \`clawdcursor optout\` or set CLAWD_TELEMETRY=0.`, isError: true };
      },
    },

    // ── MOUSE ──────────────────────────────────────────────────────

    {
      name: 'mouse_middle_click',
      description: 'Middle-click (wheel-click) at image-space (x, y). Opens links in new tab in most browsers; pans in some apps.',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
        space: SPACE_PARAM,
      },
      category: 'mouse',
      safetyTier: 1,
      handler: async ({ x, y, space }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_middle_click');
        const p = toMouse(ctx, x, y, space);
        await ctx.platform.mouseClick(p.x, p.y, { button: 'middle' });
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
      safetyTier: 1,
      handler: async ({ x, y, space }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_triple_click');
        const { x: px, y: py } = toMouse(ctx, x, y, space);
        await ctx.platform.mouseClick(px, py, { button: 'left', count: 3 });
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
          // Only when the focused field is the one we clicked: if focus stayed in
          // some other input (click landed on page text), ctrl+A would select
          // that field — or the whole page — instead of the paragraph.
          const b = fe?.bounds;
          const hit = !b || !b.width || !b.height
            || (px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height);
          if (hit && /^(edit|textfield|searchfield|combobox)$/.test(role.replace(/^controltype\./, ''))) {
            await ctx.platform.keyPress(`${MOD}+a`);   // this OS's select-all (keys.ts)
            selectAll = ' + select-all (edit field)';
          }
        } catch { /* best-effort — the triple-click itself already happened */ }
        return { text: `Triple-clicked at (${x}, ${y})${selectAll}` };
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
      safetyTier: 1,
      handler: async ({ x, y, direction, amount, space }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_scroll_horizontal');
        const sp = toMouse(ctx, x, y, space);
        const ticks = amount ?? 3;
        await ctx.platform.mouseScroll(
          sp.x, sp.y,
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
        'Path is an array of {x,y} points. Useful for Paint-style drawing ' +
        'or gesture input. Press occurs at the first point and release at the last.',
      parameters: {
        // An array, like `drag`'s path: the compound publishes one type per name, and a JSON-string-only handler under
        // an array schema failed every well-formed call (live macOS). A JSON string is still accepted.
        path: {
          type: 'array', required: true,
          description: 'Array of {"x":n, "y":n} points in image-space, min 2 points',
          items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        },
        space: SPACE_PARAM,
      },
      category: 'mouse',
      safetyTier: 1,
      handler: async ({ path, space }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_drag_stepped');
        let points: Array<{ x: number; y: number }>;
        try { points = Array.isArray(path) ? path : JSON.parse(String(path)); }
        catch { return { text: 'mouse_drag_stepped: path must be an array of {x,y} points', isError: true }; }
        if (Array.isArray(points) && points.some(p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) {
          return { text: 'mouse_drag_stepped: every point needs numeric x and y', isError: true };
        }
        if (!Array.isArray(points) || points.length < 2) {
          return { text: 'mouse_drag_stepped: need at least 2 points', isError: true };
        }
        const scaled = points.map(p => toMouse(ctx, p.x, p.y, space));

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

    // ── SYSTEM INTEGRATION ────────────────────────────────────────

    {
      name: 'open_file',
      description:
        'Open a file or folder in the OS default application. ' +
        'Uses `open` (macOS), `xdg-open` (Linux), and explorer / ShellExecute (Windows). ' +
        'On some platforms "opening" a file executes it ' +
        '(.exe on Windows, .app on macOS, scripts with executable bit on Linux), ' +
        'and the registered handler can be privileged or destructive.',
      parameters: {
        path: { type: 'string', description: 'Absolute filesystem path', required: true },
      },
      category: 'orchestration',
      safetyTier: 1,
      destructive: true,
      handler: async ({ path: filePath }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('open_file');
        return openFilePath(ctx.platform, String(filePath));
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
      description: 'Open ANY registered URI (mailto:, tel:, sms:, webcal:, file:, slack:, vscode:, obsidian:, spotify:, zoommtg:, https:, custom-scheme:, ...) via the OS protocol-handler registry. The OS routes to whichever app the user has registered as the handler. Replaces dozens of app-specific shortcuts with one general primitive. Tier 2 (mutation): the OS will dispatch to whatever app is registered for the scheme — that handler may be privileged or destructive (file: opens files which on Windows can execute .exe; vscode: opens a workspace; zoommtg: joins a call). The dispatcher does no scheme allowlist — callers + the agent loop are responsible for not constructing dangerous URIs.',
      parameters: {
        uri: { type: 'string', description: 'A full URI like "mailto:bob@example.com?subject=hi&body=hello", "tel:+15551234", "slack://channel?team=T123&id=C456", "vscode://file/Users/me/code/x.ts", "https://example.com". Must be properly URL-encoded.', required: true },
      },
      category: 'orchestration',
      safetyTier: 1,
      destructive: true,
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
                return { text: `Opened ${scheme}: via the OS shell handler. New window: ${quoteScreenText(shell.title ?? '(untitled)')}. (URI: ${u.length > 120 ? u.slice(0, 120) + '…' : u})` };
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
          return { text: `Opened ${scheme}: in the registered handler. New window appeared: ${quoteScreenText(launchResult.hwndLabel ?? '(handle unknown)')}. (URI: ${u.length > 120 ? u.slice(0, 120) + '…' : u})` };
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
        '(Ctrl+Tab / Ctrl+Shift+Tab on every OS; mod+{1..9} to jump). Works in Chrome, Firefox, Edge, Safari. ' +
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
        // ctrl, NOT mod — on macOS mod+Tab is Cmd+Tab, the app switcher.
        // Browsers use Ctrl+Tab for tab cycling on every OS, Safari included.
        const combo = dir === 'next' ? 'ctrl+Tab' : 'ctrl+shift+Tab';
        await ctx.platform.keyPress(combo);
        return { text: `Cycled to ${dir} tab` };
      },
    },

    // ── DAEMON DIAGNOSTICS (v0.9 PR7.2) ────────────────────────────
    // These tools replace REST endpoints that the dashboard used to
    // call directly. They're intentionally minimal.

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
      safetyTier: 0,
      handler: async ({ limit }, ctx) => {
        const cap = typeof limit === 'number' ? Math.max(1, Math.min(500, Math.floor(limit))) : 200;
        if (!ctx.getLogBuffer) return { text: '[]' };
        const buf = ctx.getLogBuffer();
        const sliced = buf.length > cap ? buf.slice(buf.length - cap) : buf;
        return { text: screenJson(sliced) };
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
      safetyTier: 1,
      destructive: true,
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
