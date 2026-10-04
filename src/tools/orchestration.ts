/**
 * Orchestration tools — delegate tasks, launch apps, navigate browser.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition } from './types';
import { agentBrowserConnectOptions } from '../llm/browser-config';
import { resolveAlias } from '../core/router/aliases';

const execFileAsync = promisify(execFile);

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// ─── Bounded-sync delegation (timeout-proof `task`) ─────────────────────────
//
// MCP clients enforce a per-tool-call timeout (commonly ~60s). The old
// delegate_to_agent awaited the WHOLE autonomous loop — a 90s task blew the
// client's deadline, the call "timed out", and the work finished invisibly in
// the background (live failure 2026-06-12: wallpaper task succeeded in 22
// turns while the caller saw a timeout). Fix: wait synchronously only up to a
// bound that stays under the client ceiling; if the loop is still going,
// return a RUNNING receipt and keep the task alive. A re-call with the SAME
// task text re-attaches to the in-flight run instead of starting a duplicate.

interface InflightDelegation {
  task: string;
  startedAt: number;
  /** Never rejects — settle state is recorded on the entry fields. */
  promise: Promise<void>;
  settled: boolean;
  result?: { success: boolean; steps?: Array<{ description?: string }>; duration?: number };
  error?: unknown;
}

let inflightDelegation: InflightDelegation | null = null;

/** Test hook — clears the module-level in-flight holder. */
export function __resetInflightDelegationForTests(): void {
  inflightDelegation = null;
}

const SYNC_WAIT_DEFAULT_MS = 45_000; // under common 60s MCP client timeouts
const SYNC_WAIT_MIN_MS = 1_000;
const SYNC_WAIT_MAX_MS = 50_000;

const normTask = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function startDelegation(
  agent: { executeTask: (t: string) => Promise<NonNullable<InflightDelegation['result']>> },
  task: string,
): InflightDelegation {
  const entry: InflightDelegation = { task, startedAt: Date.now(), promise: Promise.resolve(), settled: false };
  entry.promise = agent.executeTask(task).then(
    r => { entry.settled = true; entry.result = r; },
    e => { entry.settled = true; entry.error = e; },
  );
  return entry;
}

function formatDelegationResult(entry: InflightDelegation): { text: string; isError?: boolean } {
  if (entry.error) {
    const err = entry.error as { message?: string };
    return { text: `delegate_to_agent: ${err?.message ?? String(entry.error)}`, isError: true };
  }
  const result = entry.result;
  return {
    text: JSON.stringify({
      success: result?.success,
      steps: result?.steps?.length ?? 0,
      duration: `${((result?.duration ?? 0) / 1000).toFixed(1)}s`,
      lastAction: result?.steps?.slice(-1)?.[0]?.description ?? '(unknown)',
    }, null, 2),
    isError: !result?.success,
  };
}

export function getOrchestrationTools(): ToolDefinition[] {
  return [
    {
      name: 'delegate_to_agent',
      description:
        "Hand a whole task to clawdcursor's built-in thin agent loop, which drives the toolbox with the model configured via `clawdcursor doctor` (perceive → act → iterate until done). " +
        "For an expensive frontier model this is the delegation lever: hand grunt work to a cheaper configured model that takes the wheel. " +
        "BOUNDED-SYNC: waits up to `timeout` seconds (default 45) for completion. A finished task returns its result directly; a longer task returns a {status:\"running\"} receipt with progress while the loop CONTINUES in the background — re-call with the SAME task text to keep waiting (re-attaches, never restarts), or poll agent_status / abort via abort_task. " +
        "Requires `clawdcursor agent` running WITH a model configured; in tools-only / --no-llm mode there is no model to drive it.",
      parameters: {
        task: { type: 'string', description: 'Natural language task description', required: true },
        timeout: { type: 'number', description: 'Max seconds to WAIT for completion before returning a running receipt (default 45, clamped 1–50; stays under MCP client call-timeouts). The task itself keeps running — this only bounds the wait.', required: false },
      },
      category: 'orchestration',
      compactGroup: 'task',
      safetyTier: 1,
      handler: async ({ task, timeout }, ctx) => {
        // Run the task IN-PROCESS on the daemon's configured-model agent.
        // (This previously self-called the daemon's own /mcp via mcpCall, which
        // the streamable-HTTP transport rejects with "Already connected to a
        // transport" — a re-entrant MCP call. Calling ctx.agent directly avoids
        // the self-call and returns a clean error when no model is configured.)
        if (!ctx?.agent) {
          return { text: 'delegate_to_agent: no model-backed agent attached. This needs `clawdcursor agent` running WITH a model configured (run `clawdcursor doctor`). In tools-only / --no-llm mode there is no model to drive the task — drive the toolbox tools directly instead.', isError: true };
        }
        const text = String(task ?? '').trim();
        if (!text) {
          return { text: 'delegate_to_agent: task must be a non-empty string', isError: true };
        }
        const timeoutSec = Number(timeout);
        const boundMs = Math.min(SYNC_WAIT_MAX_MS, Math.max(SYNC_WAIT_MIN_MS,
          Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : SYNC_WAIT_DEFAULT_MS));

        let entry = inflightDelegation;
        if (entry && !entry.settled) {
          // A delegated task is still running. Same text → re-attach and keep
          // waiting; different text → tell the caller the truth instead of
          // queueing or double-running.
          if (normTask(entry.task) !== normTask(text)) {
            const runningFor = ((Date.now() - entry.startedAt) / 1000).toFixed(0);
            return {
              text: `delegate_to_agent: the agent is BUSY with a different task ("${entry.task.slice(0, 100)}", running ${runningFor}s). ` +
                    `Poll agent_status (compact: task {action:"status"}), abort it first (abort_task / task {action:"abort"}), ` +
                    `or re-call with the SAME task text to keep waiting on it.`,
              isError: true,
            };
          }
        } else if (entry && entry.settled && normTask(entry.task) === normTask(text)) {
          // Finished while the caller was away — hand over the stored result.
          inflightDelegation = null;
          return formatDelegationResult(entry);
        } else {
          // Start fresh. Guard against a run started through another route
          // (submit_task / scheduler) that this holder doesn't know about.
          const state = ctx.agent.getState?.();
          if (state?.status && state.status !== 'idle') {
            return {
              text: `delegate_to_agent: agent is busy (status=${state.status}) with a task started elsewhere (submit_task/scheduler). Poll agent_status or call abort_task first.`,
              isError: true,
            };
          }
          entry = startDelegation(ctx.agent, text);
          inflightDelegation = entry;
        }

        await Promise.race([entry.promise, sleepMs(boundMs)]);

        if (entry.settled) {
          if (inflightDelegation === entry) inflightDelegation = null;
          return formatDelegationResult(entry);
        }

        // Still running — return a receipt instead of blowing the caller's
        // MCP timeout. NOT an error: the task is alive and progressing.
        const st = ctx.agent.getState?.() ?? {};
        return {
          text: JSON.stringify({
            status: 'running',
            task: entry.task,
            elapsed: `${((Date.now() - entry.startedAt) / 1000).toFixed(0)}s`,
            progress: {
              status: st.status,
              currentStep: st.currentStep,
              stepsCompleted: st.stepsCompleted,
              stepsTotal: st.stepsTotal,
            },
            next: 'Task continues in the background. Re-call this tool with the SAME task text to keep waiting (re-attaches — it will NOT restart the task). Or poll agent_status (compact: task {action:"status"}) / abort with abort_task (task {action:"abort"}).',
          }, null, 2),
        };
      },
    },

    {
      name: 'open_app',
      description: 'Open an application by name. Uses the cross-OS app alias table + the PlatformAdapter\'s launchApp (UWP-aware on Windows, `open -a` on macOS, gtk-launch / xdg-open on Linux).',
      parameters: {
        name: { type: 'string', description: 'Application name (e.g. "notepad", "calc", "mspaint", "Outlook", "Chrome")', required: true },
      },
      category: 'orchestration',
      compactGroup: 'window',
      safetyTier: 1,
      handler: async ({ name }, ctx) => {
        await ctx.ensureInitialized();
        const rawName = String(name ?? '');
        if (!rawName) {
          return { text: 'open_app: `name` is required', isError: true };
        }

        // Resolve through the canonical alias table so "Notepad" / "notepad" /
        // "Calculator" / "calc" all map to the right launch hints. The MCP
        // open_app used to call `Start-Process <name>` directly, which fails
        // for UWP apps (Calculator, Win11 Notepad) and is case-sensitive on
        // PowerShell's Start-Process arg. The alias table + platform adapter
        // is the same path the autonomous agent-loop uses.
        const alias = resolveAlias(rawName);

        // If we have a PlatformAdapter (we always do post-v0.9 init), use it.
        // Falls back to the old execFile path only when the adapter isn't
        // available (shouldn't happen in normal operation).
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
          try {
            const res = await ctx.platform.launchApp(launchName, {
              alwaysNewInstance: alias?.alwaysNewInstance,
              uwpAppId: alias?.uwpAppId,
              searchTerm: alias?.searchTerm
                ?? (process.platform === 'darwin' ? alias?.macOSAppName : undefined),
            });
            ctx.a11y.invalidateCache();
            return {
              text: res?.title
                ? `Opened "${rawName}" (pid=${res.pid}, window="${res.title}")`
                : `Launched "${rawName}" (no window surfaced yet)`,
            };
          } catch (err: any) {
            return { text: `Failed to launch "${rawName}": ${err?.message ?? err}`, isError: true };
          }
        }

        // Fallback: pre-adapter path (kept for safety, should be unreachable).
        try {
          if (process.platform === 'win32') {
            const exe = alias?.executable ?? rawName;
            const uwpId = alias?.uwpAppId;
            if (uwpId) {
              await execFileAsync('explorer.exe', [`shell:AppsFolder\\${uwpId}`], { timeout: 10000 });
            } else {
              // Defense-in-depth: `exe` (a caller-supplied app name) is interpolated
              // into a PowerShell -Command string. Inside a double-quoted PS string,
              // `"`, backtick, and `$(...)` can break out and run arbitrary code.
              // Reject those metacharacters — real executable names/paths never
              // contain them (spaces and parens, e.g. "Program Files (x86)", are fine).
              if (/["`$\r\n]/.test(exe)) {
                return { text: `Refusing to launch "${rawName}": unsafe characters in target name`, isError: true };
              }
              await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `Start-Process "${exe}"`], { timeout: 10000 });
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
      compactGroup: 'window',
      safetyTier: 2,
      handler: async ({ url }, ctx) => {
        await ctx.ensureInitialized();
        // Go through the ONE driver with the SAME attach/launch policy as
        // cdp_connect. Launching a second browser on the user port here (and
        // never telling the driver) left cdp_connect attached to a different
        // instance and cdp_list_tabs blind to this page (1.5.11 live repro).
        // driver.navigate() keeps attached-mode tab discipline: an existing
        // browser gets the agent's own tab, the user's tabs are never driven.
        const ok = await ctx.cdp.ensureConnected(agentBrowserConnectOptions()).catch(() => false);
        if (!ok) return { text: 'Navigation failed: could not launch or attach to a CDP browser.', isError: true };
        const r = await ctx.cdp.navigate(url);
        if (!r.success) return { text: `Navigation failed: ${r.error}`, isError: true };
        ctx.a11y.invalidateCache();
        const title = await ctx.cdp.getTitle().catch(() => '(loading)');
        const mode = ctx.cdp.getConnectionMode?.();
        const where = mode === 'attached'
          ? ' — in the agent\'s own tab of the EXISTING browser (likely the user\'s session; their tabs were not touched)'
          : mode === 'dedicated' ? ' — dedicated agent-owned browser' : '';
        return { text: `Navigated to: "${title}" at ${r.value ?? url}${where}. Next: cdp_page_context to see the page, cdp_click / cdp_type to interact.` };
      },
    },

    {
      name: 'wait',
      description: 'Wait for a specified duration. Useful after animations or page loads.',
      parameters: {
        seconds: { type: 'number', description: 'Duration to wait (0.1 to 30)', required: true, minimum: 0.1, maximum: 30 },
      },
      category: 'orchestration',
      compactGroup: 'computer',
      safetyTier: 0,
      handler: async ({ seconds }) => {
        await new Promise(r => setTimeout(r, seconds * 1000));
        return { text: `Waited ${seconds}s` };
      },
    },
  ];
}
