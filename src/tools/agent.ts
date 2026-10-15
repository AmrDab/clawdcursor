/**
 * Agent-control tools — drive the autonomous Agent from outside the daemon.
 *
 * These are the MCP equivalents of the legacy REST routes that lived in
 * src/server.ts (POST /task, POST /abort, GET /status, GET /screenshot,
 * GET /task-logs, GET /task-logs/current). Each tool reaches into
 * `ctx.agent` — populated by the daemon when it constructs the MCP server,
 * and undefined when running through stdio MCP without a live agent.
 *
 * Tools that require an agent return an `isError` result with a clear
 * message rather than throwing — clients shouldn't crash because they
 * called submit_task on a stdio MCP that has no Pipeline wired.
 */

import * as fs from 'fs';
import type { ToolDefinition } from './types';
import { setLastFrame } from '../core/agent-loop/coord-scale';
import { pauseGate } from '../core/pause-gate';

const PAUSE_WAIT_DEFAULT_MS = 45_000; // under common 60s MCP client timeouts
const normMessage = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function needAgent(tool: string): { text: string; isError: true } {
  return {
    text: `${tool}: no autonomous agent is attached to this MCP context. ` +
          `This tool needs \`clawdcursor agent\` running WITH an LLM configured. ` +
          `Tools-only contexts (stdio \`clawdcursor mcp\`, or \`agent --no-llm\`) cannot use it — ` +
          `drive the desktop yourself with the other tools instead: the compound ` +
          `computer/accessibility/window/system/browser tools (compact surface), ` +
          `or the granular mouse_click/type_text/… tools.`,
    isError: true,
  };
}

export function getAgentTools(): ToolDefinition[] {
  return [
    {
      name: 'submit_task',
      description:
        'Submit a natural-language task to the autonomous agent. The agent ' +
        'classifies, decomposes, and executes the task through the unified ' +
        'pipeline (a11y → text-agent → vision fallback). Returns immediately ' +
        'with `accepted: true`; poll agent_status to track progress. ' +
        'Runs locally on a cheap model — prefer this over driving the ' +
        'mouse_*/screenshot tools yourself to save tokens.',
      parameters: {
        task: { type: 'string', description: 'Natural-language task', required: true },
      },
      category: 'orchestration',
      compactGroup: 'task',
      safetyTier: 1,
      handler: async ({ task }, ctx) => {
        if (!ctx.agent) return needAgent('submit_task');
        const trimmed = String(task ?? '').trim();
        if (!trimmed) {
          return { text: 'submit_task: task must be a non-empty string', isError: true };
        }
        if (trimmed.length > 2000) {
          return { text: 'submit_task: task is too long (max 2000 chars)', isError: true };
        }
        const state = ctx.agent.getState();
        if (state.status !== 'idle') {
          return {
            text: `Agent is busy (status=${state.status}). Wait or call abort_task first.`,
            isError: true,
          };
        }
        // Fire-and-poll: kick off the task, return acceptance immediately.
        // The agent updates its own state; clients use agent_status to track.
        ctx.agent.executeTask(trimmed).catch((err: any) => {
          // Errors are surfaced via agent state + the daemon's log buffer.
          // Don't re-throw here — submit_task already returned.

          console.error('submit_task: pipeline error', err?.message ?? err);
        });
        return { text: JSON.stringify({ accepted: true, task: trimmed }) };
      },
    },

    {
      name: 'abort_task',
      description:
        'Signal the running task to abort. The pipeline checks `isAborted()` ' +
        'between steps; long-running LLM calls may take a few seconds to ' +
        'wind down. agent_status will return `idle` once the abort has settled.',
      parameters: {},
      category: 'orchestration',
      compactGroup: 'task',
      safetyTier: 1,
      handler: async (_params, ctx) => {
        if (!ctx.agent) return needAgent('abort_task');
        ctx.agent.abort();
        return { text: JSON.stringify({ aborted: true }) };
      },
    },

    {
      name: 'agent_status',
      description:
        'Return the autonomous agent\'s current state: status (idle | thinking | ' +
        'acting | waiting_confirm), currentTask, currentStep, stepsCompleted, ' +
        'stepsTotal. Cheap (synchronous read) — safe to poll at 1–2 Hz.',
      parameters: {},
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        if (!ctx.agent) {
          // Stdio MCP — there's no daemon. Surface a sentinel state so
          // clients can degrade gracefully instead of crashing.
          return {
            text: JSON.stringify({
              status: 'no_agent',
              stepsCompleted: 0,
              stepsTotal: 0,
              pause: pauseGate.current() ?? undefined,
            }),
          };
        }
        return { text: JSON.stringify({ ...ctx.agent.getState(), pause: pauseGate.current() ?? undefined }) };
      },
    },

    {
      name: 'pause_for_user',
      description:
        'Hand the desktop to the user for a step only they can do (sign in, a password or 2FA code, a CAPTCHA, a choice only they can make) instead of stopping or asking them to come back to this chat. ' +
        'Shows an on-screen prompt: blue glow, your message, Resume / End task. ' +
        'BOUNDED: waits up to `timeout` seconds (default 45). {status:"waiting"} → the user is still busy: re-call with the SAME message to keep waiting (re-attaches, the prompt stays up). ' +
        '{status:"resumed"} → re-read the screen, then continue the task. {status:"ended"} → the user stopped it: report back.',
      parameters: {
        message: { type: 'string', description: 'Exactly what the user should do, e.g. "Sign in to GitHub, then click Resume".', required: true },
        timeout: { type: 'number', description: 'Max seconds to wait for the answer before returning {status:"waiting"} (default 45, clamped 1–50). The prompt stays up.', required: false },
      },
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async ({ message, timeout }) => {
        const text = String(message ?? '').trim();
        if (!text) return { text: 'pause_for_user: `message` is required (what the user should do).', isError: true };
        if (!pauseGate.available()) {
          return {
            text: 'pause_for_user: no on-screen prompt is available on this machine (the overlay is off: --no-banner, CLAWD_NO_BANNER, CLAWD_NO_PAUSE, or not supported on this OS yet). Ask the user in your own chat instead.',
            isError: true,
          };
        }
        const key = `mcp:${normMessage(text)}`;
        const sec = Number(timeout);
        const boundMs = Math.min(50_000, Math.max(1_000, Number.isFinite(sec) && sec > 0 ? sec * 1000 : PAUSE_WAIT_DEFAULT_MS));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          pauseGate.request({ message: text, key }),
          new Promise<null>(r => { timer = setTimeout(() => r(null), boundMs); }),
        ]);
        clearTimeout(timer);
        if (outcome === null) {
          pauseGate.markWaiting(key); // only a caller told "waiting" gets the outcome handed over
          return {
            text: JSON.stringify({
              status: 'waiting',
              waitingFor: text,
              next: 'The user has not answered yet. Re-call pause_for_user with the SAME message to keep waiting (re-attaches; the prompt stays up). Do not act on the desktop meanwhile.',
            }),
          };
        }
        pauseGate.forget(key);
        if (outcome === 'resumed' || outcome === 'resumed_unverified') {
          return {
            text: JSON.stringify({
              status: 'resumed',
              confirmedByUser: outcome === 'resumed',
              next: outcome === 'resumed'
                ? 'The user finished and clicked Resume. The screen may have changed: read it again before acting, then continue the task.'
                : 'Resumed by an AI (task resume), not by the user on screen: check the screen before assuming the step was done.',
            }),
          };
        }
        return {
          text: JSON.stringify({
            status: outcome === 'timeout' ? 'timed_out' : 'ended',
            next: outcome === 'timeout' ? 'Nobody answered the on-screen prompt. Stop and report back.' : 'The user clicked End task. Stop and report back.',
          }),
        };
      },
    },

    {
      name: 'resume_task',
      description:
        'Resume after a pause for the user when the user tells YOU they finished (normally they click Resume on screen).',
      parameters: {},
      category: 'orchestration',
      compactGroup: 'task',
      safetyTier: 1,
      handler: async () => {
        const p = pauseGate.current();
        if (!p) return { text: 'resume_task: nothing is paused.', isError: true };
        const r = pauseGate.answer('resume', 'agent'); // an AI resuming is never the user's on-screen confirmation
        if (!r.ok) return { text: `resume_task: ${r.error}`, isError: true };
        return { text: JSON.stringify({ resumed: true, was: p.message }) };
      },
    },

    {
      name: 'screenshot_full',
      description:
        'Capture the full primary display. Returns base64 image bytes plus a ' +
        '`format` field (`jpeg` by default, `png` if configured); the MCP ' +
        '`image.mimeType` is set to match. Equivalent to desktop_screenshot ' +
        'but returns the full frame unconditionally (no region cropping). ' +
        'Useful for the dashboard\'s /screenshot REST replacement.',
      parameters: {},
      category: 'perception',
      compactGroup: 'computer',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        try {
          await ctx.ensureInitialized();
          const frame = await ctx.desktop.captureForLLM();
          setLastFrame(null);   // image coords now refer to this primary capture
          // captureForLLM returns { buffer, scaleFactor, llmWidth, llmHeight,
          // format }. Format is configured per-capture (`'jpeg'` by default,
          // sometimes `'png'`); use it to set the correct mimeType instead
          // of the previous hardcoded 'image/png' which lied for the JPEG path.
          const b64 = Buffer.isBuffer(frame.buffer)
            ? frame.buffer.toString('base64')
            : Buffer.from(frame.buffer).toString('base64');
          const mimeType = frame.format === 'png' ? 'image/png' : 'image/jpeg';
          return {
            text: JSON.stringify({
              scaleFactor: frame.scaleFactor,
              llmWidth: frame.llmWidth,
              llmHeight: frame.llmHeight,
              format: frame.format,
            }),
            image: { data: b64, mimeType },
          };
        } catch (err) {
          return { text: `Screenshot failed: ${(err as Error).message}`, isError: true };
        }
      },
    },

    {
      name: 'task_logs_list',
      description:
        'List the last 50 task summaries from the daemon\'s structured log. ' +
        'Each summary contains task text, correlation ID, start/end timestamps, ' +
        'and final status. Returns [] when no logger is attached.',
      parameters: {},
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        if (!ctx.agent) return { text: '[]' };
        try {
          const logger = (ctx.agent as any).logger;
          if (!logger || typeof logger.getRecentSummaries !== 'function') {
            return { text: '[]' };
          }
          return { text: JSON.stringify(logger.getRecentSummaries(50)) };
        } catch {
          return { text: '[]' };
        }
      },
    },

    {
      name: 'task_logs_current',
      description:
        'Return the structured log entries for the currently-executing task ' +
        '(or the most recent if no task is running). Each entry is a JSONL ' +
        'event from the pipeline trace.',
      parameters: {},
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        if (!ctx.agent) {
          return { text: 'task_logs_current: no agent attached', isError: true };
        }
        try {
          const logger = (ctx.agent as any).logger;
          const logPath = logger?.getCurrentLogPath?.();
          if (!logPath || !fs.existsSync(logPath)) {
            return { text: 'task_logs_current: no current log file', isError: true };
          }
          const content = fs.readFileSync(logPath, 'utf-8');
          const entries = content
            .trim()
            .split('\n')
            .map((l: string) => {
              try { return JSON.parse(l); } catch { return null; }
            })
            .filter(Boolean);
          return { text: JSON.stringify(entries) };
        } catch (err) {
          return { text: `task_logs_current: ${(err as Error).message}`, isError: true };
        }
      },
    },
  ];
}
