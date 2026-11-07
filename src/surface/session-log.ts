/**
 * Local record of what each MCP session did — one JSONL line per tool call.
 *
 * Why: the only way to know whether agents follow "blind first, then
 * vision" (read the a11y tree / text, act by name; screenshots + coordinate
 * clicks only as a fallback) is to count it. It is also what `clawdcursor
 * report` sends, so a user can report a bad session in one step.
 *
 * Records: tool, action, perception class, ok, duration, a short redacted
 * error. NEVER typed text, clipboard contents, element names, window titles,
 * URLs or coordinates. Local only (~/.clawdcursor/sessions/), last 50
 * sessions kept, off with CLAWDCURSOR_SESSION_LOG=0.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR } from '../paths';
import { logger } from '../core/observability/logger';
import { isProcessAlive } from './pidfile';

export type CallClass = 'blind' | 'vision' | 'act-name' | 'act-coords' | 'act-other';

const VISION_ACTIONS = new Set(['screenshot', 'screenshot_region', 'zoom']);
const COORD_ACTIONS = new Set(['click', 'double_click', 'right_click', 'middle_click', 'triple_click', 'hover', 'move',
  'move_relative', 'scroll', 'scroll_horizontal', 'drag', 'drag_path', 'mouse_down', 'mouse_up']);
const NAME_ACTIONS = new Set(['invoke', 'smart_click', 'smart_type', 'set_value', 'toggle', 'select', 'expand',
  'collapse', 'focus_element', 'click_element']);
const BLIND_OTHER = new Set(['ocr', 'clipboard_read', 'copy_all_text', 'page_context', 'read_text', 'list_tabs',
  'list', 'active', 'screen_size', 'list_displays']);

/** Classify a call on either the compact surface (tool + action) or a granular tool name. */
export function classifyCall(tool: string, action?: string): CallClass {
  const a = (action ?? '').toLowerCase();
  const t = tool.toLowerCase();
  if (VISION_ACTIONS.has(a) || /screenshot|zoom/.test(t)) return 'vision';
  if (t === 'accessibility' || t.startsWith('a11y_')) {
    const verb = a || t.replace(/^a11y_/, '');
    return NAME_ACTIONS.has(verb) ? 'act-name' : 'blind';
  }
  if (/^smart_(click|type)$/.test(t)) return 'act-name';
  if (t === 'computer' ? COORD_ACTIONS.has(a) : /^mouse_/.test(t)) return 'act-coords';
  if (BLIND_OTHER.has(a) || /^(read_screen|ocr_|read_clipboard|copy_all_text|smart_read|compile_ui|find_|get_screen|cdp_page_context|cdp_read)/.test(t)) return 'blind';
  return 'act-other';
}

/** What a call produced: `empty` / `timeout` blind reads are where agents give up on blind perception.
 *  `refused`: the safety gate stopped it before it ran. `consent_required`: the
 *  one-time consent prompt stopped it before it ran. */
export type Outcome = 'ok' | 'empty' | 'partial' | 'timeout' | 'error' | 'refused' | 'consent_required';
/** One step of a batch, classified like a call of its own. */
export interface StepCall { tool: string; action?: string; cls: CallClass; ok: boolean; outcome: Outcome }
export interface SessionCall { t: string; tool: string; action?: string; cls: CallClass; ok: boolean; ms: number; outcome?: Outcome; space?: string; err?: string; steps?: StepCall[] }

/** Derive an outcome from a result's text (no content is stored, only the class). */
export function outcomeOf(isError: boolean, text: string): Outcome {
  // Only the head of a result says what happened; long bodies (page text, a
  // report) can contain these words as content.
  const head = text.slice(0, 300);
  if (/PSRunner timeout|timed out after|ETIMEDOUT|walk timed out/i.test(head)) return 'timeout';
  if (/UI TREE \(PARTIAL|"truncated":\s*true/i.test(head)) return 'partial';
  if (head.startsWith('(no elements found)')
    || /no elements? (?:found|named)|no_clickable_target|could not read|Nothing was copied|no option named/i.test(head)) return 'empty';
  return isError ? 'error' : 'ok';
}
export interface SessionTally {
  calls: number; blind: number; vision: number; actName: number; actCoords: number; actOther: number; errors: number;
  /** calls a guard (or the consent gate) refused before they ran — the guard working, not a failure, so not in `errors` */
  refused: number;
  /** vision calls that had a blind read since the previous vision call */
  visionAfterBlind: number;
  firstPerception: 'blind' | 'vision' | null;
  /** blind reads that came back empty / timed out — the abandonment trigger */
  blindEmpty: number;
  /** vision calls immediately after an empty / timed-out blind read */
  visionAfterBlindMiss: number;
}

const KEEP = 50;
const SECRET = [/sk-[A-Za-z0-9_-]{16,}/g, /(bearer|token|key)[\s:=]+[A-Za-z0-9_.-]{12,}/gi, /[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi];

export function sessionDir(): string {
  return process.env.CLAWDCURSOR_SESSION_DIR || path.join(DATA_DIR, 'sessions');
}

function redact(s: string): string {
  let out = s.slice(0, 160);
  for (const re of SECRET) out = out.replace(re, '[redacted]');
  const home = os.homedir();
  return out.split(home).join('~').replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '~').replace(/\/(home|Users)\/[^/\s]+/g, '~');
}

export class SessionLog {
  readonly file: string | null;
  private tally: SessionTally = { calls: 0, blind: 0, vision: 0, actName: 0, actCoords: 0, actOther: 0, errors: 0, refused: 0, visionAfterBlind: 0, firstPerception: null, blindEmpty: 0, visionAfterBlindMiss: 0 };
  private lastBlindMissed = false;
  private blindSinceVision = false;
  private visionStreak = 0;
  private headerWritten = false;
  /** The call the handler is running now: an exit while it runs names it. */
  private current: { tool: string; action?: string; at: number } | null = null;

  /** `persist: false` keeps only the in-memory tally (used to replay a file). */
  constructor(private meta: { version: string; surface: string }, persist = true) {
    if (!persist || process.env.CLAWDCURSOR_SESSION_LOG === '0') { this.file = null; return; }
    const dir = sessionDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.file = path.join(dir, `session-${stamp}-${process.pid}.jsonl`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const old = fs.readdirSync(dir).filter(f => f.startsWith('session-') && f.endsWith('.jsonl')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - (KEEP - 1)))) fs.rmSync(path.join(dir, f), { force: true });
    } catch { /* logging must never break a tool call */ }
  }

  /** Record one tool call. `client` (host name/version) is written once, when first known.
   *  A batch passes its `steps`: each is tallied by its own class instead of the batch's. */
  record(tool: string, action: string | undefined, ok: boolean, ms: number, err?: string,
    client?: { name?: string; version?: string },
    extra?: { outcome?: Outcome; space?: string; steps?: Array<{ tool: string; action?: string; ok: boolean; outcome?: Outcome }> }): CallClass {
    const cls = classifyCall(tool, action);
    const outcome = extra?.outcome ?? (ok ? 'ok' : 'error');
    this.current = null;
    const steps: StepCall[] | undefined = extra?.steps?.map(s => ({ tool: s.tool, ...(s.action ? { action: s.action } : {}),
      cls: classifyCall(s.tool, s.action), ok: s.ok, outcome: s.outcome ?? (s.ok ? 'ok' : 'error') }));
    this.tally.calls++;
    if (outcome === 'refused' || outcome === 'consent_required') this.tally.refused++;
    else if (!ok) this.tally.errors++;
    if (steps?.length) for (const s of steps) this.tallyClass(s.cls, s.outcome);
    else this.tallyClass(cls, outcome);

    if (this.file) {
      // The day log gets the same line, so one file shows what ran, how long it took and how it ended.
      logger.info('tool.done', { tool, ...(action ? { action } : {}), ms: Math.round(ms), outcome, ...(err ? { err: redact(err) } : {}) });
      try {
        this.writeHeader(client);
        const line: SessionCall = { t: new Date().toISOString(), tool, ...(action ? { action } : {}), cls, ok, ms: Math.round(ms),
          outcome, ...(extra?.space ? { space: extra.space } : {}), ...(err ? { err: redact(err) } : {}), ...(steps ? { steps } : {}) };
        fs.appendFileSync(this.file, JSON.stringify(line) + '\n');
      } catch { /* never break a tool call over logging */ }
    }
    return cls;
  }

  private writeHeader(client?: { name?: string; version?: string }): void {
    if (this.headerWritten || !this.file) return;
    fs.appendFileSync(this.file, JSON.stringify({ type: 'session', started: new Date().toISOString(), ...this.meta,
      platform: process.platform, pid: process.pid,
      client: client?.name ? `${client.name} ${client.version ?? ''}`.trim() : undefined }) + '\n');
    this.headerWritten = true;
  }

  /** The handler of this call starts now. The file exists from here: a kill during the first call still leaves a trace. */
  running(tool: string, action?: string, client?: { name?: string; version?: string }): void {
    this.current = { tool, ...(action ? { action } : {}), at: Date.now() };
    try { this.writeHeader(client); } catch { /* never break a tool call over logging */ }
  }

  /**
   * The server is exiting: say why, and which call it cut off. Synchronous, so it lands before process.exit. A kill
   * (Task Manager, kill -9) or a crash never gets here: the next server reports those (reportUncleanExits).
   */
  end(reason: string): void {
    const cut = this.current ? { tool: this.current.tool, ...(this.current.action ? { action: this.current.action } : {}),
      ranMs: Date.now() - this.current.at } : undefined;
    (cut ? logger.warn : logger.info)('mcp.exit', { reason, pid: process.pid, ...(cut ? { cutOff: cut } : {}) });
    if (!this.file || !this.headerWritten) return;  // no call was made: no session file to close
    try { fs.appendFileSync(this.file, JSON.stringify({ type: 'end', t: new Date().toISOString(), reason, ...(cut ? { cutOff: cut } : {}) }) + '\n'); }
    catch { /* best-effort */ }
  }

  private tallyClass(cls: CallClass, outcome: Outcome): void {
    const t = this.tally;
    if (cls === 'blind') {
      t.blind++; this.blindSinceVision = true; this.visionStreak = 0; t.firstPerception ??= 'blind';
      this.lastBlindMissed = outcome === 'empty' || outcome === 'timeout';
      if (this.lastBlindMissed) t.blindEmpty++;
    }
    else if (cls === 'vision') {
      t.vision++; t.firstPerception ??= 'vision';
      if (this.lastBlindMissed) t.visionAfterBlindMiss++;
      this.lastBlindMissed = false;
      if (this.blindSinceVision) t.visionAfterBlind++;
      this.blindSinceVision = false;
      this.visionStreak++;
    }
    else if (cls === 'act-name') t.actName++;
    else if (cls === 'act-coords') t.actCoords++;
    else t.actOther++;
  }

  /** Screenshots in a row with no blind read in between. */
  get visionOnlyStreak(): number { return this.visionStreak; }
  get summary(): SessionTally { return { ...this.tally }; }
}

/** Read a session file back: header + calls + tally (used by `clawdcursor report`). */
export function readSession(file: string): { header: Record<string, unknown> | null; calls: SessionCall[]; tally: SessionTally } {
  const header: Record<string, unknown>[] = [];
  const calls: SessionCall[] = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'session') header.push(o);
        else if (o.type !== 'end') calls.push(o);
      } catch { /* skip */ }
    }
  } catch { /* missing file */ }
  const replay = new SessionLog({ version: '', surface: '' }, false);
  for (const c of calls) replay.record(c.tool, c.action, c.ok, c.ms, undefined, undefined, { outcome: c.outcome, steps: c.steps });
  return { header: header[0] ?? null, calls, tally: replay.summary };
}

/**
 * Servers that ended without saying why: killed (Task Manager, kill -9, the host force-closing it) or crashed. Their session
 * file has calls but no `end` line, and their process is gone. Logged once each (an `end` line is added), at the next start.
 * Files from before the header carried a pid are skipped: their ending was never recorded.
 */
export function reportUncleanExits(): void {
  for (const file of listSessions()) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
      const header = JSON.parse(lines[0] ?? '{}');
      const pid = header.type === 'session' ? Number(header.pid) : NaN;
      if (!Number.isInteger(pid) || pid === process.pid || isProcessAlive(pid)) continue;
      const last = JSON.parse(lines[lines.length - 1]);
      if (last.type === 'end') continue;
      // Only the header: it was killed during its first call.
      const lastCall = last.type === 'session' ? undefined : { tool: last.tool, ...(last.action ? { action: last.action } : {}), at: last.t };
      const reason = 'killed or crashed: no clean exit was recorded';
      logger.warn('mcp.exit', { reason, pid, detectedAt: 'next start', ...(lastCall ? { lastFinishedCall: lastCall } : {}) });
      fs.appendFileSync(file, JSON.stringify({ type: 'end', t: new Date().toISOString(), reason, detectedAtNextStart: true }) + '\n');
    } catch { /* unreadable file: skip */ }
  }
}

/** Newest session files first. */
export function listSessions(): string[] {
  try {
    const dir = sessionDir();
    return fs.readdirSync(dir).filter(f => f.startsWith('session-') && f.endsWith('.jsonl')).sort().reverse().map(f => path.join(dir, f));
  } catch { return []; }
}
