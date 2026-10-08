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

/** What a call produced: `empty` / `timeout` blind reads are where agents give up on blind perception. */
export type Outcome = 'ok' | 'empty' | 'partial' | 'timeout' | 'error';
export interface SessionCall { t: string; tool: string; action?: string; cls: CallClass; ok: boolean; ms: number; outcome?: Outcome; space?: string; err?: string }

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
  private tally: SessionTally = { calls: 0, blind: 0, vision: 0, actName: 0, actCoords: 0, actOther: 0, errors: 0, visionAfterBlind: 0, firstPerception: null, blindEmpty: 0, visionAfterBlindMiss: 0 };
  private lastBlindMissed = false;
  private blindSinceVision = false;
  private visionStreak = 0;
  private headerWritten = false;

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

  /** Record one tool call. `client` (host name/version) is written once, when first known. */
  record(tool: string, action: string | undefined, ok: boolean, ms: number, err?: string,
    client?: { name?: string; version?: string }, extra?: { outcome?: Outcome; space?: string }): CallClass {
    const cls = classifyCall(tool, action);
    const t = this.tally;
    const outcome = extra?.outcome ?? (ok ? 'ok' : 'error');
    t.calls++;
    if (!ok) t.errors++;
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

    if (this.file) {
      try {
        if (!this.headerWritten) {
          fs.appendFileSync(this.file, JSON.stringify({ type: 'session', started: new Date().toISOString(), ...this.meta,
            platform: process.platform, client: client?.name ? `${client.name} ${client.version ?? ''}`.trim() : undefined }) + '\n');
          this.headerWritten = true;
        }
        const line: SessionCall = { t: new Date().toISOString(), tool, ...(action ? { action } : {}), cls, ok, ms: Math.round(ms),
          outcome, ...(extra?.space ? { space: extra.space } : {}), ...(err ? { err: redact(err) } : {}) };
        fs.appendFileSync(this.file, JSON.stringify(line) + '\n');
      } catch { /* never break a tool call over logging */ }
    }
    return cls;
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
      try { const o = JSON.parse(line); (o.type === 'session' ? header : calls).push(o); } catch { /* skip */ }
    }
  } catch { /* missing file */ }
  const replay = new SessionLog({ version: '', surface: '' }, false);
  for (const c of calls) replay.record(c.tool, c.action, c.ok, c.ms, undefined, undefined, { outcome: c.outcome });
  return { header: header[0] ?? null, calls, tally: replay.summary };
}

/** Newest session files first. */
export function listSessions(): string[] {
  try {
    const dir = sessionDir();
    return fs.readdirSync(dir).filter(f => f.startsWith('session-') && f.endsWith('.jsonl')).sort().reverse().map(f => path.join(dir, f));
  } catch { return []; }
}
