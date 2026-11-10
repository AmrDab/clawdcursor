/**
 * v0.8.2 — Electron / WebView2 / WKWebView detection + CDP bridging hints.
 *
 * Modern "native" apps on Windows and macOS are frequently Electron or
 * WebView2 wrappers around Chromium. Their accessibility trees often
 * contain only the window chrome — the entire document body is inside
 * the web view and is NOT reachable via UIA or AX directly.
 *
 * Examples on Windows (WebView2 / Electron):
 *   - New Outlook (olk)
 *   - Microsoft Teams
 *   - Discord
 *   - Slack
 *   - VS Code
 *   - GitHub Desktop
 *   - Notion
 *
 * The clean fix is to bridge to their embedded Chromium via CDP. That
 * requires the app to be launched with a remote-debugging port. We
 * cannot attach to an already-running app that wasn't launched that
 * way, but we CAN:
 *
 *   1. Detect which running processes are Electron/WebView2 shells by
 *      process-name heuristics + module snooping (on Windows).
 *   2. Scan the common Electron remote-debug port range for already-
 *      enabled /json endpoints.
 *   3. Tell the agent HOW to relaunch the app with debugging enabled
 *      so a bridge can attach.
 *
 * This file ships two tools:
 *   - `detect_webview_apps`  — enumerate candidates + their CDP status
 *   - `attach_webview_cdp`   — discover the debugger URL and connect
 *                              the existing cdp_driver to it
 *
 * Linux TODO: the same heuristics apply (look for
 * /proc/{pid}/cmdline containing `--type=renderer` or `.asar`), but
 * AT-SPI already gives us a richer tree on Linux Electron apps than
 * UIA does on Windows. Follow-up.
 */

import type { ToolDefinition, ToolResult, ToolContext } from './types';
import { psOpts, powershellExe } from '../platform/ps-spawn';

/**
 * Known Electron / WebView2 app fingerprints. Match is case-insensitive
 * on either processName OR window title substring. The display name is
 * what the hint shows the user. If the process actually supports a known
 * relaunch-with-debug flag, we include it; otherwise we tell the agent
 * the generic relaunch recipe.
 */
interface WebViewFingerprint {
  processNames: string[];   // case-insensitive prefix match
  titleSubstrings: string[]; // case-insensitive substring match
  displayName: string;
  /** Known CLI flag to enable CDP, if the app exposes one. */
  debugFlag?: string;
  /** If app uses WebView2 specifically (different bridge path). */
  kind: 'electron' | 'webview2' | 'chromium-shell';
}

const KNOWN_APPS: WebViewFingerprint[] = [
  // Windows New Outlook — WebView2
  { processNames: ['olk'], titleSubstrings: ['- outlook'], displayName: 'New Outlook', kind: 'webview2' },
  // Teams (v2 is WebView2, v1 was Electron)
  { processNames: ['ms-teams', 'teams'], titleSubstrings: ['microsoft teams'], displayName: 'Microsoft Teams', kind: 'webview2' },
  // Discord — Electron
  { processNames: ['discord'], titleSubstrings: ['discord'], displayName: 'Discord', kind: 'electron', debugFlag: '--remote-debugging-port=9222' },
  // Slack — Electron
  { processNames: ['slack'], titleSubstrings: ['slack'], displayName: 'Slack', kind: 'electron', debugFlag: '--remote-debugging-port=9222' },
  // VS Code — Electron
  { processNames: ['code', 'code - insiders'], titleSubstrings: ['visual studio code'], displayName: 'VS Code', kind: 'electron', debugFlag: '--inspect=9222' },
  // GitHub Desktop — Electron
  { processNames: ['github desktop', 'githubdesktop'], titleSubstrings: ['github desktop'], displayName: 'GitHub Desktop', kind: 'electron' },
  // Notion — Electron
  { processNames: ['notion'], titleSubstrings: ['notion'], displayName: 'Notion', kind: 'electron' },
  // Obsidian — Electron
  { processNames: ['obsidian'], titleSubstrings: ['obsidian'], displayName: 'Obsidian', kind: 'electron' },
  // Spotify — Chromium shell
  { processNames: ['spotify'], titleSubstrings: ['spotify'], displayName: 'Spotify', kind: 'chromium-shell' },
];

interface WebViewCandidate {
  processName: string;
  processId: number;
  title: string;
  displayName: string;
  kind: 'electron' | 'webview2' | 'chromium-shell';
  /** CDP already discoverable on http://127.0.0.1:<port>/json? */
  cdpPort: number | null;
  /** What the agent should do next. */
  hint: string;
}

/**
 * Match a window to a known WebView app fingerprint. Returns null when
 * the window is a plain native app.
 */
function matchFingerprint(processName: string, title: string): WebViewFingerprint | null {
  const pn = processName.toLowerCase();
  const t = (title || '').toLowerCase();
  for (const fp of KNOWN_APPS) {
    const pnMatch = fp.processNames.some(n => pn.startsWith(n.toLowerCase()));
    const titleMatch = fp.titleSubstrings.some(s => t.includes(s));
    if (pnMatch || titleMatch) return fp;
  }
  return null;
}

/** Probe a single TCP port for a running /json Chrome DevTools endpoint. */
async function probeCdpPort(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Scan the common Electron remote-debug port range. */
async function findLiveCdpPort(): Promise<number | null> {
  // Electron defaults to 9222; developers sometimes pick 9223/9229. Chrome
  // and Edge when launched with --remote-debugging-port also use 9222.
  const candidates = [9222, 9223, 9229, 8315];
  for (const p of candidates) {
    if (await probeCdpPort(p)) return p;
  }
  return null;
}

function buildHint(fp: WebViewFingerprint, cdpPort: number | null, title: string): string {
  if (cdpPort !== null) {
    return (
      `${fp.displayName} detected and CDP is already live on port ${cdpPort}. ` +
      `Call \`browser({"action":"connect","port":${cdpPort}})\` (or \`cdp_connect\` in granular mode) to attach, then ` +
      `\`browser({"action":"page_context"})\` to enumerate its DOM elements — far richer than the UIA tree.`
    );
  }
  const flag = fp.debugFlag ?? '--remote-debugging-port=9222';
  return (
    `${fp.displayName} ("${title}") is a ${fp.kind} app whose accessibility tree is largely empty — ` +
    `its UI is inside an embedded Chromium. To get a reliable DOM-level bridge, ask the user to relaunch it ` +
    `with \`${flag}\` (e.g. \`${fp.processNames[0]} ${flag}\`). Then call ` +
    `\`browser({"action":"connect"})\` (or \`cdp_connect\` in granular mode) to attach. ` +
    `Until then, fall back to \`system({"action":"ocr"})\` + coord clicks, OR \`accessibility({"action":"invoke","name":"..."})\` against whatever names DO show up.`
  );
}

export function getElectronBridgeTools(): ToolDefinition[] {
  return [
    {
      name: 'detect_webview_apps',
      description:
        'Enumerate running Electron / WebView2 / Chromium-shell apps (e.g. New Outlook, Teams, Discord, Slack, VS Code) whose ' +
        'accessibility trees are typically sparse because the UI is rendered inside a web view. Returns each candidate with a ' +
        'CDP-discovery hint — if a remote-debugging port is already live, you can attach to it via `cdp_connect`; ' +
        'otherwise the hint shows the relaunch command the user should run to enable CDP. Use this WHEN `read_screen` returns an ' +
        'unexpectedly empty tree on a "native" app.',
      parameters: {},
      category: 'perception',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async (_params, ctx: ToolContext): Promise<ToolResult> => {
        await ctx.ensureInitialized();
        if (!ctx.platform) {
          return { text: 'detect_webview_apps: platform adapter not initialized', isError: true };
        }
        const windows = await ctx.platform.listWindows();
        const candidates: WebViewCandidate[] = [];

        // Port scan is cheap; do it once and reuse.
        const cdpPort = await findLiveCdpPort();

        const seenPids = new Set<number>();
        for (const w of windows) {
          const fp = matchFingerprint(w.processName, w.title);
          if (!fp) continue;
          // Apps can expose multiple top-level windows for the same process
          // (e.g. Outlook's main window + a hidden notification host). One
          // candidate per pid is what callers actually want.
          if (seenPids.has(w.processId)) continue;
          seenPids.add(w.processId);
          candidates.push({
            processName: w.processName,
            processId: w.processId,
            title: w.title,
            displayName: fp.displayName,
            kind: fp.kind,
            cdpPort,
            hint: buildHint(fp, cdpPort, w.title),
          });
        }

        if (candidates.length === 0) {
          return {
            text: 'No known Electron / WebView2 apps detected in the current window list. ' +
                  `${cdpPort !== null ? `A CDP endpoint IS live on port ${cdpPort} — call cdp_connect to attach.` :'No CDP endpoint is currently live on the standard ports (9222/9223/9229/8315).'}`,
          };
        }

        return { text: JSON.stringify({ candidates, cdpPort }, null, 2) };
      },
    },

    {
      name: 'relaunch_with_cdp',
      description:
        'Relaunch a WebView2 / Electron app with a remote-debugging port enabled so `browser` tools can attach. ' +
        'The relaunch closes the existing instance (asks the OS to close politely via window_close first), then ' +
        'starts a new one with `--remote-debugging-port=<port>`. The user MUST consent — this WILL lose any unsaved work ' +
        'in the app. Returns instructions + the new port. Prefer the hint from `detect_webview_apps` when possible.',
      parameters: {
        appName: { type: 'string', description: 'Process name of the app (e.g. "discord", "slack", "olk")', required: true },
        port:    { type: 'number', description: 'Port to open for CDP. Default 9222.', required: false, default: 9222 },
      },
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 1,
      handler: async ({ appName, port }, ctx: ToolContext): Promise<ToolResult> => {
        await ctx.ensureInitialized();
        if (!ctx.platform) {
          return { text: 'relaunch_with_cdp: platform adapter not initialized', isError: true };
        }
        const p = typeof port === 'number' ? port : 9222;
        const name = String(appName);
        // Try to close the existing instance gracefully.
        await ctx.platform.setWindowState('close', { processName: name }).catch(() => false);
        // Wait briefly for the close to propagate.
        await new Promise(r => setTimeout(r, 600));

        try {
          // Relaunch with the debug flag. On Windows we pass args via launchApp's
          // url field as a positional argument to Start-Process — adapter handles
          // the quoting.
          const flag = `--remote-debugging-port=${p}`;
          if (ctx.platform.platform === 'win32') {
            const { spawn } = await import('child_process');
            // The name arrives as $env:, never as script source (platform/ps-input.ts).
            const child = spawn(powershellExe(), [
              '-NoProfile', '-Command',
              `Start-Process -FilePath $env:CLAWD_PS_FILE -WorkingDirectory $env:USERPROFILE -ArgumentList '${flag}'`,
            ], psOpts({ stdio: 'ignore', detached: true, windowsHide: true, env: { ...process.env, CLAWD_PS_FILE: name } }));
            child.unref();
          } else {
            // macOS / Linux — open -a / direct spawn.
            await ctx.platform.launchApp(name, { url: flag }).catch(() => ({}));
          }
          await new Promise(r => setTimeout(r, 1500));
          const alive = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(2000) })
            .then(r => r.ok).catch(() => false);
          return {
            text: JSON.stringify({
              appName: name, port: p, cdpLive: alive,
              nextStep: alive ? `Call browser({"action":"connect","port":${p}}).` : 'Relaunch attempted but CDP endpoint not detected. The app may not support this flag.',
            }, null, 2),
            isError: !alive,
          };
        } catch (err) {
          return {
            text: `relaunch_with_cdp failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
  ];
}
