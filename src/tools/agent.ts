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
            }),
          };
        }
        return { text: JSON.stringify(ctx.agent.getState()) };
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
