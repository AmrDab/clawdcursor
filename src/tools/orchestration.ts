/**
 * Orchestration tools — delegate tasks, launch apps, navigate browser.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { ToolDefinition } from './types';
import { DEFAULT_CDP_PORT } from '../browser-config';

const execFileAsync = promisify(execFile);

/** Read auth token from ~/.clawdcursor/token for agent API calls. */
function loadAgentToken(): string {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.clawdcursor', 'token'), 'utf-8').trim();
  } catch {
    return '';
  }
}
function agentHeaders(): Record<string, string> {
  const token = loadAgentToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}
/** Map common agent-server errors to actionable messages. */
function formatAgentError(err: any): string {
  const code = err?.cause?.code ?? err?.code ?? '';
  const msg = err?.message ?? String(err);
  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
    return 'The clawdcursor agent server is not running. Start it first with: clawdcursor start';
  }
  return `Agent unavailable: ${msg}`;
}

/** Map HTTP status from agent API to an actionable message. */
function formatAgentHttpError(status: number, body: string, statusText: string): string {
  switch (status) {
    case 404:
      return 'The /task endpoint was not found. Make sure you\'re running clawdcursor v0.7.2+ with: clawdcursor start';
    case 401:
      return 'Authentication failed. The server token may have changed. Try: clawdcursor stop && clawdcursor start';
    default:
      return `Agent API error ${status}: ${body || statusText}`;
  }
}

export function getOrchestrationTools(): ToolDefinition[] {
  return [
    {
      name: 'delegate_to_agent',
      description: "Delegate a task to clawdcursor's autonomous pipeline (runs independently with its own LLM reasoning). Returns when the task completes or times out.",
      parameters: {
        task: { type: 'string', description: 'Natural language task description', required: true },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)', required: false },
      },
      category: 'orchestration',
      handler: async ({ task, timeout }) => {
        const timeoutMs = (timeout ?? 300) * 1000;
        const start = Date.now();
        try {
          const resp = await fetch('http://127.0.0.1:3847/task', {
            method: 'POST',
            headers: agentHeaders(),
            body: JSON.stringify({ task }),
          });
          if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            return { text: formatAgentHttpError(resp.status, body, resp.statusText), isError: true };
          }
          while (Date.now() - start < timeoutMs) {
            await new Promise(r => setTimeout(r, 2000));
            try {
              const status = await fetch('http://127.0.0.1:3847/status');
              const data: any = await status.json();
              if (data.status === 'idle') {
                const result = data.lastResult;
                return {
                  text: JSON.stringify({
                    success: result?.success ?? false,
                    verified: result?.verified ?? false,
                    steps: result?.steps?.length ?? 0,
                    duration: `${((Date.now() - start) / 1000).toFixed(1)}s`,
                    lastAction: result?.steps?.slice(-1)?.[0]?.description ?? '(unknown)',
                  }, null, 2),
                };
              }
            } catch { /* keep polling */ }
          }
          await fetch('http://127.0.0.1:3847/abort', { method: 'POST', headers: agentHeaders() }).catch(() => {});
          return { text: `Agent timed out after ${timeout ?? 300}s. Task aborted.`, isError: true };
        } catch (err: any) {
          return { text: formatAgentError(err), isError: true };
        }
      },
    },

    {
      name: 'open_app',
      description: 'Open an application by name. Uses platform-native launch.',
      parameters: {
        name: { type: 'string', description: 'Application name (e.g. "notepad", "calc", "mspaint")', required: true },
      },
      category: 'orchestration',
      handler: async ({ name }, ctx) => {
        await ctx.ensureInitialized();
        try {
          if (process.platform === 'win32') {
            await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `Start-Process "${name}"`], { timeout: 10000 });
          } else if (process.platform === 'darwin') {
            await execFileAsync('open', ['-a', name], { timeout: 10000 });
          } else {
            await execFileAsync(name, [], { timeout: 10000 });
          }
          await new Promise(r => setTimeout(r, 2000));
          ctx.a11y.invalidateCache();
          return { text: `Launched: ${name}` };
        } catch (err: any) {
          return { text: `Failed to launch "${name}": ${err.message}`, isError: true };
        }
      },
    },

    {
      name: 'navigate_browser',
      description: `Open a URL in the browser. Launches with CDP enabled (port ${DEFAULT_CDP_PORT}) for DOM interaction. Call cdp_connect after.`,
      parameters: {
        url: { type: 'string', description: 'URL to navigate to', required: true },
      },
      category: 'orchestration',
      handler: async ({ url }, ctx) => {
        await ctx.ensureInitialized();
        if (await ctx.cdp.isConnected()) {
          try {
            const page = ctx.cdp.getPage();
            if (page) {
              await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
              const title = await page.title().catch(() => '(loading)');
              return { text: `Navigated to: "${title}" at ${url}` };
            }
          } catch { /* fall through */ }
        }
        try {
          const userDataDir = path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'clawdcursor-edge');
          if (process.platform === 'win32') {
            await execFileAsync('powershell.exe', ['-NoProfile', '-Command',
              `Start-Process "msedge" -ArgumentList @("--remote-debugging-port=${DEFAULT_CDP_PORT}","--user-data-dir=${userDataDir}","--no-first-run","--disable-default-apps","${url}")`
            ], { timeout: 10000 });
          } else if (process.platform === 'darwin') {
            await execFileAsync('open', ['-a', 'Google Chrome', '--args',
              `--remote-debugging-port=${DEFAULT_CDP_PORT}`, `--user-data-dir=${userDataDir}`, '--no-first-run', url
            ], { timeout: 10000 });
          } else {
            await execFileAsync('google-chrome', [
              `--remote-debugging-port=${DEFAULT_CDP_PORT}`, `--user-data-dir=${userDataDir}`, '--no-first-run', url
            ], { timeout: 10000 });
          }
          await new Promise(r => setTimeout(r, 3000));
          ctx.a11y.invalidateCache();
          return { text: `Opened: ${url} (CDP port ${DEFAULT_CDP_PORT} enabled)` };
        } catch (err: any) {
          return { text: `Navigation failed: ${err.message}`, isError: true };
        }
      },
    },

    {
      name: 'wait',
      description: 'Wait for a specified duration. Useful after animations or page loads.',
      parameters: {
        seconds: { type: 'number', description: 'Duration to wait (0.1 to 30)', required: true, minimum: 0.1, maximum: 30 },
      },
      category: 'orchestration',
      handler: async ({ seconds }) => {
        await new Promise(r => setTimeout(r, seconds * 1000));
        return { text: `Waited ${seconds}s` };
      },
    },
  ];
}
