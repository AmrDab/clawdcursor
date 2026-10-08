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
import { TASK_LOGS_DIR, REPORTS_DIR } from '../paths';
import { listSessions, readSession, type SessionTally } from './session-log';

// ─── Configuration ──────────────────────────────────────────

const REPORT_ENDPOINT = process.env.CLAWD_REPORT_URL || 'https://api.clawdcursor.com/reports';
/** Fallback when the endpoint is unreachable: a prefilled issue the user reviews and submits. */
const ISSUES_NEW_URL = 'https://github.com/AmrDab/clawdcursor/issues/new';
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
  /** An MCP session (what an external agent did) — no content, only tool/action/class/outcome. */
  session?: {
    client?: string;
    surface?: string;
    startedAt?: string;
    durationMs: number;
    tally: SessionTally;
    /** Compressed class sequence, e.g. "blind vision×3 act-coords×2" */
    sequence: string;
    recentCalls: Array<{ tool: string; action?: string; cls: string; ok: boolean; ms: number }>;
    errors: string[];
  };
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
export function buildReport(logPath?: string, userNote?: string, skipTaskLog = false): ErrorReport {
  const targetPath = skipTaskLog ? null : (logPath || getMostRecentLog());
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

/** Newest MCP session file, or null. */
export function getMostRecentSession(): string | null {
  return listSessions()[0] ?? null;
}

/** Report on an MCP session — what an external agent did through clawdcursor. */
export function buildSessionReport(sessionPath?: string, userNote?: string): ErrorReport {
  const file = sessionPath || getMostRecentSession();
  const report = buildReport(undefined, userNote, /* skipTaskLog */ true);
  if (!file) return report;
  const { header, calls, tally } = readSession(file);
  const seq: Array<{ cls: string; n: number }> = [];
  for (const c of calls) {
    const last = seq[seq.length - 1];
    if (last && last.cls === c.cls) last.n++;
    else seq.push({ cls: c.cls, n: 1 });
  }
  const first = calls.length ? Date.parse(calls[0].t) : NaN;
  const lastT = calls.length ? Date.parse(calls[calls.length - 1].t) : NaN;
  report.session = {
    client: header?.client as string | undefined,
    surface: header?.surface as string | undefined,
    startedAt: header?.started as string | undefined,
    durationMs: Number.isFinite(first) && Number.isFinite(lastT) ? lastT - first : 0,
    tally,
    sequence: seq.slice(-60).map(x => (x.n > 1 ? `${x.cls}×${x.n}` : x.cls)).join(' '),
    recentCalls: calls.slice(-40).map(c => ({ tool: c.tool, ...(c.action ? { action: c.action } : {}), cls: c.cls, ok: c.ok, ms: c.ms })),
    errors: [...new Set(calls.filter(c => !c.ok && c.err).map(c => redactSensitive(String(c.err))))].slice(0, 8),
  };
  if (!report.errorContext && report.session.errors.length) report.errorContext = report.session.errors[report.session.errors.length - 1];
  return report;
}

/** The newest source: an MCP session or an agent task log. */
export function buildLatestReport(userNote?: string): ErrorReport {
  const sess = getMostRecentSession();
  const task = getMostRecentLog();
  const mtime = (p: string | null) => { try { return p ? fs.statSync(p).mtimeMs : 0; } catch { return 0; } };
  return sess && mtime(sess) >= mtime(task) ? buildSessionReport(sess, userNote) : buildReport(task ?? undefined, userNote);
}

/** Markdown summary for a GitHub issue — the user sees all of it before submitting. */
export function reportMarkdown(r: ErrorReport): string {
  const L: string[] = [];
  L.push(`**clawdcursor ${r.version}** on ${r.system.platform}/${r.system.arch} (${r.system.osRelease}), Node ${r.system.nodeVersion}`);
  if (r.userNote) L.push('', `**What happened:** ${r.userNote}`);
  if (r.session) {
    const s = r.session;
    const t = s.tally;
    L.push('', `**MCP session**: host ${s.client ?? 'unknown'}, ${s.surface ?? '?'} surface, ${t.calls} calls, ${(s.durationMs / 60000).toFixed(1)} min`);
    L.push(`- perception: ${t.blind} blind (a11y / text) vs ${t.vision} screenshots; first: ${t.firstPerception ?? '-'}; screenshots with a blind read first: ${t.visionAfterBlind}/${t.vision}`);
    L.push(`- blind reads that came back empty / timed out: ${t.blindEmpty}; screenshots right after one: ${t.visionAfterBlindMiss}`);
    L.push(`- actions: ${t.actName} by name, ${t.actCoords} by coordinates, ${t.actOther} other; errors: ${t.errors}`);
    L.push('', '```', s.sequence, '```');
    if (s.errors.length) L.push('', '**Errors (redacted):**', ...s.errors.map(e => `- ${e}`));
  }
  if (r.task) L.push('', `**Agent task:** ${r.task.description} (${r.task.status}, ${r.task.totalSteps} steps)`);
  if (r.errorContext && !r.session) L.push('', `**Error:** ${r.errorContext}`);
  L.push('', `<sub>report ${r.reportId} · contains no typed text, clipboard, screenshots, element names or file paths</sub>`);
  return L.join('\n');
}

/** Prefilled "new issue" link, kept under GitHub's URL length limits. */
export function issueUrl(r: ErrorReport): string {
  const title = r.userNote ? `Report: ${r.userNote.slice(0, 80)}` : `Session report (${r.system.platform}, ${r.version})`;
  let body = reportMarkdown(r);
  if (body.length > 6000) body = body.slice(0, 6000) + '\n…(truncated; the full report is saved locally)';
  return `${ISSUES_NEW_URL}?${new URLSearchParams({ title, body }).toString()}`;
}

/** Open a URL in the user's browser (best effort). */
export async function openInBrowser(url: string): Promise<boolean> {
  const { spawn } = await import('child_process');
  try {
    if (process.platform === 'win32') {
      // rundll32 takes the URL verbatim — `start` would split it on & and ^.
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch { return false; }
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
  const sessionPath = getMostRecentSession();

  if (!logPath && !sessionPath) {
    console.log('\n  Nothing to report yet: no MCP session or task log found. Use clawdcursor, then try again.\n');
    return;
  }

  // Report on whichever is newer — almost always the MCP session an agent just ran.
  const report = buildLatestReport();
  if (report.session) {
    console.log(`\n  Most recent MCP session: ${path.basename(sessionPath!)}`);
  } else {
    console.log(`\n  Most recent task log: ${path.basename(logPath!)}`);
  }

  // Show available logs
  const recentLogs = report.session ? [] : getRecentLogs(5);
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
  if (report.session) {
    const t = report.session.tally;
    console.log(`  Host:       ${report.session.client ?? 'unknown'} (${report.session.surface} surface)`);
    console.log(`  Calls:      ${t.calls} — ${t.blind} blind reads, ${t.vision} screenshots, ${t.actName} by name, ${t.actCoords} by coordinates, ${t.errors} errors`);
    console.log(`  Sequence:   ${report.session.sequence.slice(0, 200)}`);
  } else {
    console.log(`  Step data:  ${report.steps.length} entries (redacted)`);
  }
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
    // The report server is unreachable — hand off to a prefilled GitHub issue
    // the user reviews and submits; the full report stays on disk.
    const savedPath = saveReportLocally(report);
    const url = issueUrl(report);
    console.log(`  Report server unreachable (${result.error}).`);
    console.log(`  Saved locally: ${savedPath}`);
    const opened = await openInBrowser(url);
    console.log(opened
      ? '  Opened a prefilled GitHub issue in your browser — review it and click "Submit new issue".\n'
      : `  Open this prefilled GitHub issue to send it:\n  ${url}\n`);
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
