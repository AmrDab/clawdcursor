/**
 * Orchestration tools — launch apps, navigate browser, wait.
 */

import { execFile } from 'child_process';
import { quoteScreenText } from '../core/untrusted-screen-content';
import { promisify } from 'util';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { agentBrowserConnectOptions } from '../platform/browser-config';
import { resolveAlias, appNameRefusal, startedNoWindowText, notConfirmedText, startMenuNote } from '../platform/app-aliases';
import { sleepUnlessStopped, STOPPED_TEXT } from '../core/control';
import { timeWait } from '../core/observability/steps';
import { psOpts, powershellExe, windowsDirExe } from '../platform/ps-spawn';
import * as os from 'os';

const execFileAsync = promisify(execFile);

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/** clawdcursor's own browser is Edge or Chrome (agentBrowserConnectOptions): which of them an app is, if either. */
function ownBrowserKind(processNames: readonly string[] | undefined): 'chrome' | 'edge' | null {
  if (processNames?.includes('chrome')) return 'chrome';
  if (processNames?.includes('msedge')) return 'edge';
  return null;
}

/** Bring clawdcursor's own browser (by its pid, never by app name) to the front, and say whose browser it is. */
async function focusOwnBrowser(ctx: ToolContext, rawName: string, pid: number): Promise<ToolResult> {
  const platform = ctx.platform!;
  const raised = await platform.focusWindow({ processId: pid }).catch(() => false);
  ctx.a11y.invalidateCache();
  const front = raised ? await platform.getActiveWindow().catch(() => null) : null;
  const whose = `clawdcursor's own "${rawName}" (its own profile, not the user's; the user's own copy, if open, was not touched)`;
  if (front?.processId === pid) return { text: `Opened ${whose} (pid=${pid}, window=${quoteScreenText(front.title)})` };
  return { text: `Opened a window in ${whose} (pid=${pid}), but could not bring it to the front: window {"action":"focus","processId":${pid}}` };
}

export function getOrchestrationTools(): ToolDefinition[] {
  return [
    {
      name: 'open_app',
      description: 'Open an application by NAME (not a path: to open a file or run a program by path use open_file). Uses the cross-OS app alias table + the PlatformAdapter\'s launchApp (UWP-aware on Windows, `open -a` on macOS, executable or .desktop entry on Linux). Says plainly when no window appeared (still loading vs. not started).',
      parameters: {
        name: { type: 'string', description: 'Application name (e.g. "notepad", "calc", "mspaint", "Outlook", "Chrome")', required: true },
      },
      category: 'orchestration',
      safetyTier: 1,
      handler: async ({ name }, ctx) => {
        await ctx.ensureInitialized();
        const rawName = String(name ?? '');
        if (!rawName) {
          return { text: 'open_app: `name` is required', isError: true };
        }
        const notAName = appNameRefusal(rawName);
        if (notAName) return { text: `open_app: ${notAName}`, isError: true };

        // Resolve through the canonical alias table so "Notepad" / "notepad" /
        // "Calculator" / "calc" all map to the right launch hints. `Start-Process
        // <name>` alone fails for UWP apps (Calculator, Win11 Notepad) and is
        // case-sensitive on PowerShell's Start-Process arg.
        const alias = resolveAlias(rawName);

        if (ctx.platform && typeof ctx.platform.launchApp === 'function') {
          let launchName = rawName;
          if (alias) {
            if (process.platform === 'darwin') {
              launchName = alias.macOSAppName ?? rawName;
            } else if (process.platform === 'win32') {
              launchName = alias.executable ?? rawName;
            } else {
              launchName = alias.executable?.replace(/\.exe$/i, '') ?? rawName;
            }
          }
          // Chrome or Edge while clawdcursor's own copy of it runs: open_app stays in that copy. By name, the OS raised the
          // user's copy instead (their profile and sign-ins) while the reply named the agent's windowless pid (macOS,
          // 2026-11-18). The user's copy is opened only when it is the one that runs.
          const own = ownBrowserKind(alias?.processNames);
          const ownPid = own ? await ctx.cdp?.showOwnBrowser?.(own).catch(() => null) : null;
          if (ownPid) return focusOwnBrowser(ctx, rawName, ownPid);
          try {
            const res = await ctx.platform.launchApp(launchName, {
              nameOnly: !alias,   // a name we do not know: only an installed app is started (never a URI, a file or a search hit)
              alwaysNewInstance: alias?.alwaysNewInstance,
              uwpAppId: alias?.uwpAppId,
              processNames: alias?.processNames,   // whose windows are this app's (identity, not title text)
              searchTerm: alias?.searchTerm
                ?? (process.platform === 'darwin' ? alias?.macOSAppName : undefined),
            });
            ctx.a11y.invalidateCache();
            const via = startMenuNote(res ?? {});
            if (res?.title) return { text: `Opened "${rawName}" (pid=${res.pid}, window=${quoteScreenText(res.title)})${via}` };
            // Running but no window yet: a slow app still loading (Outlook, IDEs).
            // Not an error — an error invites a second launch.
            if (res?.pid) {
              return { text: startedNoWindowText(`"${rawName}"`, res) + via };
            }
            // No process and no window is not a launch: say so instead of "Launched".
            return { text: notConfirmedText(`"${rawName}"`, rawName) + via, isError: true };
          } catch (err: any) {
            return { text: `Failed to launch "${rawName}": ${err?.message ?? err}`, isError: true };
          }
        }

        // No PlatformAdapter (should be unreachable): start the app directly.
        try {
          if (process.platform === 'win32') {
            const exe = alias?.executable ?? rawName;
            const uwpId = alias?.uwpAppId;
            if (uwpId) {
              await execFileAsync(windowsDirExe('explorer.exe'), [`shell:AppsFolder\\${uwpId}`], { timeout: 10000, cwd: os.homedir() });
            } else {
              // `exe` is a caller-supplied app name: it arrives as $env:, never as script source (platform/ps-input.ts).
              await execFileAsync(powershellExe(), ['-NoProfile', '-Command', 'Start-Process -FilePath $env:CLAWD_PS_FILE -WorkingDirectory $env:USERPROFILE'],
                psOpts({ timeout: 10000, env: { ...process.env, CLAWD_PS_FILE: exe } }));
            }
          } else if (process.platform === 'darwin') {
            await execFileAsync('open', ['-a', alias?.macOSAppName ?? rawName], { timeout: 10000 });
          } else {
            const linuxName = alias?.executable?.replace(/\.exe$/i, '') ?? rawName;
            if (await commandExists('gtk-launch')) {
              await execFileAsync('gtk-launch', [linuxName], { timeout: 10000 });
            } else if (await commandExists('xdg-open')) {
              await execFileAsync('xdg-open', [linuxName], { timeout: 10000 });
            } else {
              await execFileAsync(linuxName, [], { timeout: 10000 });
            }
          }
          await new Promise(r => setTimeout(r, 2000));
          ctx.a11y.invalidateCache();
          return { text: `Launched: ${rawName}` };
        } catch (err: any) {
          return { text: `Failed to launch "${rawName}": ${err.message}`, isError: true };
        }
      },
    },

    {
      name: 'navigate_browser',
      description: 'Open a URL in the agent\'s CDP browser for DOM interaction — attaches to the browser already on the debug port or launches a dedicated agent-owned instance, then navigates. cdp_page_context / cdp_click / cdp_type work on that page directly. Tier 2 (mutation): triggers network egress to an arbitrary destination + spawns/attaches to a browser process.',
      parameters: {
        url: { type: 'string', description: 'URL to navigate to', required: true },
      },
      category: 'orchestration',
      safetyTier: 1,
      destructive: true,
      handler: async ({ url }, ctx) => {
        await ctx.ensureInitialized();
        // Go through the ONE driver with the SAME attach/launch policy as
        // cdp_connect. Launching a second browser on the user port here (and
        // never telling the driver) left cdp_connect attached to a different
        // instance and cdp_list_tabs blind to this page (1.5.11 live repro).
        // driver.navigate() keeps attached-mode tab discipline: an existing
        // browser gets the agent's own tab, the user's tabs are never driven.
        const ok = await ctx.cdp.ensureConnected(agentBrowserConnectOptions()).catch(() => false);
        if (!ok) return { text: `Navigation failed: could not launch or attach to a CDP browser: ${ctx.cdp.getConnectError?.() || 'no reason given'}.`, isError: true };
        const r = await ctx.cdp.navigate(url);
        if (!r.success) return { text: `Navigation failed: ${r.error}`, isError: true };
        ctx.a11y.invalidateCache();
        const title = await ctx.cdp.getTitle().catch(() => '(loading)');
        const mode = ctx.cdp.getConnectionMode?.();
        const where = mode === 'attached'
          ? ' — in the agent\'s own tab of the EXISTING browser (likely the user\'s session; their tabs were not touched)'
          : mode === 'dedicated' ? ' — dedicated agent-owned browser' : '';
        return { text: `Navigated to: ${quoteScreenText(String(title ?? ''))} at ${quoteScreenText(String(r.value ?? url))}${where}. Next: cdp_page_context to see the page, cdp_click / cdp_type to interact.` };
      },
    },

    {
      name: 'wait',
      description: 'Wait for a specified duration. Useful after animations or page loads.',
      parameters: {
        seconds: { type: 'number', description: 'Duration to wait (0.1 to 30)', required: true, minimum: 0.1, maximum: 30 },
      },
      category: 'orchestration',
      safetyTier: 0,
      handler: async ({ seconds }) => {
        // Ends early when the user stops clawdcursor: a wait is exactly when they step in (#294).
        if (await timeWait(() => sleepUnlessStopped(seconds * 1000))) return { text: `wait: ${STOPPED_TEXT}`, isError: true };
        return { text: `Waited ${seconds}s` };
      },
    },
  ];
}
