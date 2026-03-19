/**
 * Structured Task Logger — persistent JSONL logs for every task execution.
 *
 * Each task gets a separate .jsonl file with one JSON object per line:
 * - Step entries: individual actions with params, results, verification status
 * - Summary entry: final line with task-level stats (status, duration, LLM calls, cost)
 *
 * Key distinction: "verified_success" vs "unverified_success" — tracks whether
 * completion was independently confirmed or just LLM-declared.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TASK_LOGS_DIR } from './paths';

// ─── Log Sanitization ────────────────────────────────────────
// Redact API keys, Bearer tokens, and secret-like patterns from log text.
// Gated behind CLAWD_DEBUG_RAW_LOGS=1 for debugging.

const RAW_LOGS = process.env.CLAWD_DEBUG_RAW_LOGS === '1';

const SENSITIVE_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[a-zA-Z0-9_-]{20,}/g, 'sk-ant-***REDACTED***'],
  [/sk-[a-zA-Z0-9]{20,}/g, 'sk-***REDACTED***'],
  [/Bearer\s+[a-zA-Z0-9._-]{20,}/g, 'Bearer ***REDACTED***'],
  [/api[_-]?key\s*[:=]\s*\S{8,}/gi, 'api_key=***REDACTED***'],
  [/xai-[a-zA-Z0-9]{20,}/g, 'xai-***REDACTED***'],
  [/gsk_[a-zA-Z0-9]{20,}/g, 'gsk_***REDACTED***'],
  [/fw_[a-zA-Z0-9]{20,}/g, 'fw_***REDACTED***'],
  [/pplx-[a-zA-Z0-9]{20,}/g, 'pplx-***REDACTED***'],
];

function sanitizeLogText(text: string): string {
  if (RAW_LOGS) return text;
  let result = text;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ─── Types ───────────────────────────────────────────────────

export type PipelineLayer = 0 | 1 | 1.5 | 2 | 2.5 | 3 | 'preprocess' | 'decompose';

export type CompletionStatus =
  | 'verified_success'
  | 'unverified_success'
  | 'failed'
  | 'timeout'
  | 'aborted'
  | 'needs_human'
  | 'in_progress';

export interface VerificationInfo {
  method: 'action_verifier' | 'cdp_readback' | 'a11y_readback' | 'vision' | 'window_state' | 'checkpoint' | 'contradiction_check' | 'none';
  verified: boolean;
  detail?: string;
}

export interface StepLogEntry {
  stepIndex: number;
  timestamp: string;
  layer: PipelineLayer;
  actionType: string;
  actionParams?: Record<string, unknown>;
  llmReasoning?: string;
  uiStateSummary?: string;
  result: 'success' | 'fail' | 'timeout' | 'skipped' | 'blocked';
  verification?: VerificationInfo;
  error?: string;
  durationMs?: number;
}

export interface TaskSummary {
  _type: 'task_summary';
  task: string;
  refinedTask?: string;
  status: CompletionStatus;
  totalSteps: number;
  layersUsed: PipelineLayer[];
  llmCallCount: number;
  estimatedCostUsd?: number;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  targetApp?: string;
  navigatedUrl?: string;
}

// ─── TaskLogger Class ────────────────────────────────────────

export class TaskLogger {
  private logDir: string;
  private stream: fs.WriteStream | null = null;
  private currentLogPath: string | null = null;
  private stepIndex = 0;
  private startTime = 0;
  private llmCallCount = 0;
  private layersUsed = new Set<PipelineLayer>();
  private currentTask = '';

  constructor(logDir?: string) {
    this.logDir = logDir ?? TASK_LOGS_DIR;
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
    } catch { /* directory may already exist */ }
    this.pruneOldLogs(30);
  }

  /**
   * Start logging a new task. Opens a JSONL file stream.
   */
  startTask(task: string): string {
    // Close any previous stream
    this.endTask('failed');

    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const id = Math.random().toString(36).substring(2, 6);
    const filename = `${dateStr}_${id}.jsonl`;
    this.currentLogPath = path.join(this.logDir, filename);

    try {
      this.stream = fs.createWriteStream(this.currentLogPath, { flags: 'a' });
      this.stream.on('error', () => { this.stream = null; });
    } catch {
      this.stream = null;
    }

    this.stepIndex = 0;
    this.startTime = Date.now();
    this.llmCallCount = 0;
    this.layersUsed.clear();
    this.currentTask = task;

    return id;
  }

  /**
   * Log a single step. Fire-and-forget — never blocks the agent loop.
   */
  logStep(entry: Partial<StepLogEntry> & { layer: PipelineLayer; actionType: string; result: StepLogEntry['result'] }): void {
    if (!this.stream) return;

    this.layersUsed.add(entry.layer);

    const full: StepLogEntry = {
      stepIndex: this.stepIndex++,
      timestamp: new Date().toISOString(),
      layer: entry.layer,
      actionType: entry.actionType,
      result: entry.result,
      ...(entry.actionParams && { actionParams: entry.actionParams }),
      ...(entry.llmReasoning && { llmReasoning: sanitizeLogText(entry.llmReasoning.substring(0, 500)) }),
      ...(entry.uiStateSummary && { uiStateSummary: sanitizeLogText(entry.uiStateSummary.substring(0, 300)) }),
      ...(entry.verification && { verification: entry.verification }),
      ...(entry.error && { error: sanitizeLogText(entry.error.substring(0, 300)) }),
      ...(entry.durationMs !== undefined && { durationMs: entry.durationMs }),
    };

    try {
      this.stream.write(JSON.stringify(full) + '\n');
    } catch { /* never crash the agent */ }
  }

  /**
   * Record an LLM API call (for cost tracking).
   */
  recordLlmCall(): void {
    this.llmCallCount++;
  }

  /**
   * Finalize the task log with a summary line. Closes the stream.
   */
  endTask(status: CompletionStatus, extras?: Partial<TaskSummary>): void {
    if (!this.stream) return;

    const summary: TaskSummary = {
      _type: 'task_summary',
      task: this.currentTask,
      status,
      totalSteps: this.stepIndex,
      layersUsed: Array.from(this.layersUsed),
      llmCallCount: this.llmCallCount,
      durationMs: Date.now() - this.startTime,
      startedAt: new Date(this.startTime).toISOString(),
      completedAt: new Date().toISOString(),
      ...extras,
    };

    try {
      this.stream.write(JSON.stringify(summary) + '\n');
      this.stream.end();
    } catch { /* never crash */ }

    this.stream = null;
    // Keep currentLogPath for API access
  }

  /**
   * Get the path to the current/last log file.
   */
  getCurrentLogPath(): string | null {
    return this.currentLogPath;
  }

  /**
   * Get the log directory path.
   */
  getLogDir(): string {
    return this.logDir;
  }

  /**
   * Delete log files older than maxAgeDays.
   */
  private pruneOldLogs(maxAgeDays: number): void {
    try {
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      const files = fs.readdirSync(this.logDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(this.logDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        }
      }
    } catch { /* non-critical */ }
  }

  /**
   * Read the most recent N task summaries (for dashboard/API).
   */
  getRecentSummaries(count = 20): TaskSummary[] {
    try {
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.endsWith('.jsonl'))
        .sort()
        .reverse()
        .slice(0, count);

      const summaries: TaskSummary[] = [];
      for (const file of files) {
        const content = fs.readFileSync(path.join(this.logDir, file), 'utf-8');
        const lines = content.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        try {
          const parsed = JSON.parse(lastLine);
          if (parsed._type === 'task_summary') {
            summaries.push(parsed);
          }
        } catch { /* skip malformed */ }
      }
      return summaries;
    } catch {
      return [];
    }
  }
}
