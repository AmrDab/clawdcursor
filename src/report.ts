/**
 * Error Report — opt-in user report submission.
 *
 * Users can send task logs + system info to help improve the agent.
 * All data is redacted before sending (no clipboard, no typed text,
 * no file paths with usernames, no API keys).
 *
 * Privacy-first: never automatic, user must explicitly trigger.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { getVersion } from './version';
import { TASK_LOGS_DIR, REPORTS_DIR } from './paths';

// ─── Configuration ──────────────────────────────────────────

const REPORT_ENDPOINT = process.env.CLAWD_REPORT_URL || 'https://api.clawdcursor.com/reports';
const LOG_DIR = TASK_LOGS_DIR;

// ─── Types ──────────────────────────────────────────────────

export interface ErrorReport {
  reportId: string;
  timestamp: string;
  version: string;
  system: {
    platform: string;
    arch: string;
    nodeVersion: string;
    osRelease: string;
  };
  task?: {
    description: string;
    status: string;
    totalSteps: number;
    durationMs: number;
    layersUsed: (string | number)[];
    llmCallCount: number;
  };
  steps: RedactedStep[];
  userNote?: string;
  errorContext?: string;
}

interface RedactedStep {
  stepIndex: number;
  timestamp: string;
  layer: string | number;
  actionType: string;
  result: string;
  durationMs?: number;
  error?: string;
  verification?: {
    method: string;
    verified: boolean;
  };
}

// ─── Redaction ───────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  // API keys
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /api[_-]?key["\s:=]+["']?[a-zA-Z0-9_-]{16,}/gi,
  /bearer\s+[a-zA-Z0-9_.-]{20,}/gi,
  // Auth tokens in URLs
  /token=[a-zA-Z0-9_.-]{10,}/gi,
  /auth=[a-zA-Z0-9_.-]{10,}/gi,
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
];

/** Redact user home directory from paths */
function redactPaths(text: string): string {
  const home = os.homedir().replace(/\\/g, '/');
  const homeWin = os.homedir().replace(/\//g, '\\');
  let result = text.replace(new RegExp(escapeRegex(home), 'gi'), '~');
  result = result.replace(new RegExp(escapeRegex(homeWin), 'gi'), '~');
  // Also redact common username patterns in paths
  const username = os.userInfo().username;
  if (username.length > 2) {
    result = result.replace(new RegExp(`/Users/${escapeRegex(username)}`, 'gi'), '/Users/[REDACTED]');
    result = result.replace(new RegExp(`\\\\Users\\\\${escapeRegex(username)}`, 'gi'), '\\Users\\[REDACTED]');
    result = result.replace(new RegExp(`/home/${escapeRegex(username)}`, 'gi'), '/home/[REDACTED]');
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Redact sensitive patterns from a string */
function redactSensitive(text: string): string {
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return redactPaths(result);
}

/** Redact a step entry — strips typed text, clipboard, actionParams with sensitive data */
function redactStep(raw: Record<string, unknown>): RedactedStep {
  const step: RedactedStep = {
    stepIndex: raw.stepIndex as number ?? 0,
    timestamp: raw.timestamp as string ?? '',
    layer: raw.layer as string | number ?? '',
    actionType: raw.actionType as string ?? '',
    result: raw.result as string ?? '',
  };

  if (raw.durationMs !== undefined) step.durationMs = raw.durationMs as number;
  if (raw.error) step.error = redactSensitive(String(raw.error));
  if (raw.verification) {
    const v = raw.verification as Record<string, unknown>;
    step.verification = {
      method: v.method as string ?? 'unknown',
      verified: v.verified as boolean ?? false,
    };
  }

  // Deliberately omit: actionParams (may contain typed text, selectors with user data),
  // llmReasoning (may reference user content), uiStateSummary (may contain screen text)

  return step;
}

// ─── Report Building ────────────────────────────────────────

/** Read and parse a task log JSONL file */
function readTaskLog(logPath: string): Record<string, unknown>[] {
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    return content.trim().split('\n').map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

/** Get the most recent task log file path */
function getMostRecentLog(): string | null {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    return path.join(LOG_DIR, files[0]);
  } catch {
    return null;
  }
}

/** Get N most recent log files */
function getRecentLogs(count: number): string[] {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse()
      .slice(0, count)
      .map(f => path.join(LOG_DIR, f));
  } catch {
    return [];
  }
}

/** Build a report from a task log */
export function buildReport(logPath?: string, userNote?: string): ErrorReport {
  const targetPath = logPath || getMostRecentLog();
  const entries = targetPath ? readTaskLog(targetPath) : [];

  // Separate summary from steps
  const summary = entries.find(e => e._type === 'task_summary') as Record<string, unknown> | undefined;
  const steps = entries.filter(e => e._type !== 'task_summary');

  const reportId = `rpt_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

  const report: ErrorReport = {
    reportId,
    timestamp: new Date().toISOString(),
    version: getVersion(),
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      osRelease: os.release(),
    },
    steps: steps.map(redactStep),
  };

  if (summary) {
    report.task = {
      description: redactSensitive(String(summary.task || '')),
      status: String(summary.status || 'unknown'),
      totalSteps: summary.totalSteps as number ?? 0,
      durationMs: summary.durationMs as number ?? 0,
      layersUsed: summary.layersUsed as (string | number)[] ?? [],
      llmCallCount: summary.llmCallCount as number ?? 0,
    };
  }

  if (userNote) {
    report.userNote = userNote;
  }

  // Check if the last step had an error
  const lastStep = steps[steps.length - 1];
  if (lastStep?.error) {
    report.errorContext = redactSensitive(String(lastStep.error));
  }

  return report;
}

// ─── Submission ─────────────────────────────────────────────

/** Submit a report to the backend */
export async function submitReport(report: ErrorReport): Promise<{ success: boolean; reportId: string; error?: string }> {
  try {
    const resp = await fetch(REPORT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(15000),
    });

    if (resp.ok) {
      const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
      return { success: true, reportId: data.reportId as string ?? report.reportId };
    }

    return { success: false, reportId: report.reportId, error: `Server responded ${resp.status}` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Network error';
    return { success: false, reportId: report.reportId, error: message };
  }
}

/** Save report locally (fallback if network fails) */
export function saveReportLocally(report: ErrorReport): string {
  const reportDir = REPORTS_DIR;
  fs.mkdirSync(reportDir, { recursive: true });
  const filePath = path.join(reportDir, `${report.reportId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Interactive CLI ────────────────────────────────────────

/** Interactive report flow — shows what will be sent, asks for confirmation */
export async function interactiveReport(): Promise<void> {
  const logPath = getMostRecentLog();

  if (!logPath) {
    console.log('\n  No task logs found. Run a task first, then try again.\n');
    return;
  }

  const logName = path.basename(logPath);
  console.log(`\n  Most recent task log: ${logName}`);

  // Show available logs
  const recentLogs = getRecentLogs(5);
  if (recentLogs.length > 1) {
    console.log('\n  Recent logs:');
    recentLogs.forEach((l, i) => {
      const entries = readTaskLog(l);
      const summary = entries.find(e => e._type === 'task_summary') as Record<string, unknown> | undefined;
      const task = summary?.task ? redactSensitive(String(summary.task)).substring(0, 60) : '(no summary)';
      const status = summary?.status ?? 'unknown';
      const marker = i === 0 ? ' [latest]' : '';
      console.log(`    ${i + 1}. ${path.basename(l)} — ${status} — "${task}"${marker}`);
    });
  }

  // Build the report
  const report = buildReport(logPath);

  // Show preview
  console.log('\n  ── Report Preview ──────────────────────────────');
  console.log(`  Report ID:  ${report.reportId}`);
  console.log(`  Version:    ${report.version}`);
  console.log(`  Platform:   ${report.system.platform}/${report.system.arch}`);
  console.log(`  Node:       ${report.system.nodeVersion}`);
  if (report.task) {
    console.log(`  Task:       "${report.task.description}"`);
    console.log(`  Status:     ${report.task.status}`);
    console.log(`  Steps:      ${report.task.totalSteps}`);
    console.log(`  Duration:   ${(report.task.durationMs / 1000).toFixed(1)}s`);
    console.log(`  LLM Calls:  ${report.task.llmCallCount}`);
  }
  console.log(`  Step data:  ${report.steps.length} entries (redacted)`);
  if (report.errorContext) {
    console.log(`  Error:      ${report.errorContext}`);
  }
  console.log('  ────────────────────────────────────────────────');
  console.log('\n  Privacy: No typed text, clipboard data, screenshots,');
  console.log('  or personal file paths are included.');

  // Ask for optional note
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const note = await new Promise<string>((resolve) => {
    rl.question('\n  Add a note (optional, press Enter to skip): ', resolve);
  });

  if (note.trim()) {
    report.userNote = note.trim();
  }

  // Confirm
  const confirm = await new Promise<string>((resolve) => {
    rl.question('  Send this report? (y/N) ', resolve);
  });
  rl.close();

  if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
    // Save locally as fallback
    const savedPath = saveReportLocally(report);
    console.log(`\n  Report saved locally: ${savedPath}`);
    console.log('  You can manually share this file if needed.\n');
    return;
  }

  // Submit
  console.log('\n  Sending report...');
  const result = await submitReport(report);

  if (result.success) {
    console.log(`  Report sent. ID: ${result.reportId}`);
    console.log('  Thank you — this helps us make clawdcursor better.\n');
  } else {
    // Save locally on failure
    const savedPath = saveReportLocally(report);
    console.log(`  Failed to send: ${result.error}`);
    console.log(`  Report saved locally: ${savedPath}`);
    console.log('  You can manually share this file if needed.\n');
  }
}

// ─── Server API Helpers ─────────────────────────────────────

/** Build and submit a report programmatically (for REST API) */
export async function apiSubmitReport(opts: {
  logPath?: string;
  userNote?: string;
  logIndex?: number;
}): Promise<{ success: boolean; reportId: string; preview?: ErrorReport; error?: string }> {
  let targetPath = opts.logPath;

  if (!targetPath && opts.logIndex !== undefined) {
    const logs = getRecentLogs(opts.logIndex + 1);
    targetPath = logs[opts.logIndex];
  }

  if (!targetPath) {
    targetPath = getMostRecentLog() ?? undefined;
  }

  if (!targetPath) {
    return { success: false, reportId: '', error: 'No task logs found' };
  }

  const report = buildReport(targetPath, opts.userNote);
  const result = await submitReport(report);

  if (!result.success) {
    saveReportLocally(report);
  }

  return { ...result, preview: report };
}
