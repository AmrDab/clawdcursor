/**
 * Pause gate — hand the desktop to the human at a roadblock, then continue.
 *
 * When an agent hits something only the user can do (sign in, a 2FA code, a
 * CAPTCHA, a step it isn't allowed to take), it asks the gate to pause. The
 * on-screen overlay turns blue and shows what the user should do with Resume /
 * End task; the agent's run is simply suspended on the returned promise, so it
 * continues with its history intact once the user answers.
 *
 * Answers come from any of: the overlay buttons, `clawdcursor resume`,
 * POST /resume, the dashboard, or the MCP `task {action:"resume"}`.
 *
 * One pause at a time per process. A second request while one is pending
 * waits its turn — except a request with the SAME `key`, which re-attaches to
 * the pending pause (MCP callers re-issue the same call to keep waiting).
 * A keyed pause that settled while its caller was away — the caller had been
 * told "waiting" (markWaiting) — is handed over once to its next call; nothing
 * else is ever handed over, so a NEW pause with the same text asks again.
 *
 * "Something else" on the pill lets the user type an answer instead of doing the
 * step: the outcome is 'replied' with their text, and the agent continues from it
 * (it may answer a question, give a code, or change the plan).
 *
 * Who answered matters: the pill, CLI, dashboard and POST /resume are the
 * human ('resumed'); an AI calling task {action:"resume"} is 'resumed_unverified',
 * so the agent is told the user did NOT confirm it on screen.
 *
 * A pause can also be a small card: `choices` (2-6 short options, one button each) and/or `input` (a text box). A
 * picked option settles as 'replied' with `choice` (the exact option text, looked up here from the index the pill
 * reports, never taken from the pill). Only the user on screen can pick: an agent's answer never carries a choice.
 * A choice answers the agent's QUESTION. It is not an approval and nothing in the safety layer reads it (safety.ts,
 * safety-gate.ts and batch.ts never touch this gate), so it cannot lift a confirm-tier block (Send / Delete / Pay).
 *
 * Only offered when a human can see it: the overlay must be able to show, and
 * CLAWD_NO_PAUSE=1 restores the old fail-fast behaviour (CI / unattended runs).
 */

import { controlBanner } from './banner';
import { foreignOverlayState, untilNoForeignPause } from './overlay-state';
import { isStopped, resumeControl } from './control';
import { unguarded } from '../platform/pointer-guard';
import { logger } from './observability/logger';

export type PauseAnswer = 'resume' | 'end' | 'reply' | 'choice';
export type PauseOutcome = 'resumed' | 'resumed_unverified' | 'ended' | 'timeout' | 'replied';

/** A text box on the pause card. */
export interface PauseInput { placeholder?: string; multiline?: boolean }

/** The outcome, plus what the user typed (`reply`) or the option they picked (`choice`, an exact entry of `choices`). */
export interface PauseResult {
  outcome: PauseOutcome;
  reply?: string;
  choice?: string;
  /**
   * Resumed because `doneWhen` came true, not by a click. What it observed is screen state a page can write (a title,
   * text), so it is NOT the user's confirmation — callers must not report it as one.
   */
  detected?: boolean;
}

export interface PauseRequest {
  /** What the user should do. Shown on screen. */
  message: string;
  /** Re-attach key (MCP callers). Same key → same pending pause. */
  key?: string;
  /**
   * True once the user's step is done (signed in, code entered). Checked every `donePollMs` (default 1.5 s) while the
   * pause is up; when it holds, the pause resumes by itself — the prompt goes back to amber the moment the user is done,
   * without a click.
   */
  doneWhen?: () => Promise<boolean>;
  /** How often to check `doneWhen` (ms). Longer for expensive checks such as OCR. */
  donePollMs?: number;
  /** Options shown as buttons (see parsePauseCard for the limits). A pick settles as 'replied' with `choice`. */
  choices?: string[];
  /** A text box on the card. */
  input?: PauseInput;
}

export interface PauseInfo {
  id: number;
  message: string;
  since: number;
  choices?: string[];
  input?: PauseInput;
}

interface Pending {
  info: PauseInfo;
  key?: string;
  promise: Promise<PauseResult>;
  settle: (r: PauseResult) => void;
}

/** A window to give the keyboard back to: a process, and the title of its window when known. */
export interface FocusTarget { processId: number; title?: string }
interface FocusTracker {
  capture(): Promise<FocusTarget | null>;
  focus(t: FocusTarget): Promise<void>;
}
/** Through the platform adapter, so the same code serves Windows, macOS and Linux. */
const defaultFocusTracker: FocusTracker = {
  async capture() {
    const { getPlatform } = await import('../platform');
    const w = await (await getPlatform()).getActiveWindow();
    return w && w.processId ? { processId: w.processId, title: w.title || undefined } : null;
  },
  async focus(t) {
    const { getPlatform } = await import('../platform');
    await (await getPlatform()).focusWindow(t);
  },
};

const MAX_MESSAGE = 300;
/** How often `doneWhen` is checked while a pause is up. */
const DONE_POLL_MS = 1500;
const MAX_REPLY = 2000;
const RECENT_TTL_MS = 5 * 60_000;

export const MIN_CHOICES = 2;
export const MAX_CHOICES = 6;
export const MAX_CHOICE_LEN = 40;
export const MAX_PLACEHOLDER_LEN = 80;
/**
 * Would this choice pose as one of the card's own buttons? Compared case-insensitively with punctuation and emoji
 * dropped ("Resume!", "End-task", "✅ Resume now"): "resume" as the first word, "send" as the whole label (a longer
 * "Yes, send" is a real answer), "end task" / "something else" / "type an answer" anywhere.
 */
function posesAsButton(choice: string): boolean {
  const n = choice.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return n === 'send' || n === 'resume' || n.startsWith('resume ')
    || n.includes('end task') || n.includes('something else') || n.includes('type an answer');
}
// eslint-disable-next-line no-control-regex -- detecting control characters is the point
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** A tool argument that may arrive as a real value or as its JSON text (the MCP array/object convention here). */
function fromJsonText(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

/**
 * Validate the card options an agent asked for. Strict: a bad value is an error naming the limit, never silently
 * trimmed or cut (the user would see something other than what the agent meant). Choices are trimmed and
 * de-duplicated (case-insensitively, keeping the first); the 2-6 count applies to the distinct options.
 */
export function parsePauseCard(rawChoices: unknown, rawInput: unknown): { choices?: string[]; input?: PauseInput } | { error: string } {
  const card: { choices?: string[]; input?: PauseInput } = {};

  if (rawChoices !== undefined && rawChoices !== null) {
    const list = fromJsonText(rawChoices);
    if (!Array.isArray(list)) return { error: '`choices` must be an array of 2-6 short strings, e.g. ["Yes","No"].' };
    const seen = new Set<string>();
    const choices: string[] = [];
    for (const item of list) {
      if (typeof item !== 'string') return { error: 'every entry of `choices` must be a string.' };
      if (CONTROL_CHARS.test(item)) return { error: 'a choice must be one line of plain text (no line breaks or control characters).' };
      const c = item.replace(/\s+/g, ' ').trim();
      if (!c) return { error: '`choices` must not contain an empty string.' };
      if (c.length > MAX_CHOICE_LEN) return { error: `choice "${c.slice(0, 20)}..." is ${c.length} characters; keep each choice to ${MAX_CHOICE_LEN} or fewer.` };
      if (posesAsButton(c)) return { error: `"${c}" is the label of one of the card's own buttons; pick a different wording for that choice.` };
      const key = c.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      choices.push(c);
    }
    if (choices.length < MIN_CHOICES || choices.length > MAX_CHOICES) {
      return { error: `\`choices\` needs ${MIN_CHOICES}-${MAX_CHOICES} distinct options (got ${choices.length}).` };
    }
    card.choices = choices;
  }

  if (rawInput !== undefined && rawInput !== null) {
    const cfg = fromJsonText(rawInput);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { error: '`input` must be an object: {placeholder?: string, multiline?: boolean}.' };
    const { placeholder, multiline, ...rest } = cfg as Record<string, unknown>;
    const unknown = Object.keys(rest);
    if (unknown.length) return { error: `\`input\` has unknown field(s): ${unknown.join(', ')}. Allowed: placeholder, multiline.` };
    const input: PauseInput = {};
    if (placeholder !== undefined && placeholder !== null) {
      if (typeof placeholder !== 'string') return { error: '`input.placeholder` must be a string.' };
      if (CONTROL_CHARS.test(placeholder)) return { error: '`input.placeholder` must be one line of plain text.' };
      const ph = placeholder.replace(/\s+/g, ' ').trim();
      if (ph.length > MAX_PLACEHOLDER_LEN) return { error: `\`input.placeholder\` is ${ph.length} characters; keep it to ${MAX_PLACEHOLDER_LEN} or fewer.` };
      if (ph) input.placeholder = ph;
    }
    if (multiline !== undefined && multiline !== null) {
      if (typeof multiline !== 'boolean') return { error: '`input.multiline` must be true or false.' };
      if (multiline) input.multiline = true;
    }
    card.input = input;
  }

  return card;
}

function timeoutMs(): number {
  const min = Number(process.env.CLAWD_PAUSE_TIMEOUT_MIN);
  return (Number.isFinite(min) && min > 0 ? min : 15) * 60_000;
}

class PauseGate {
  private pending: Pending | null = null;
  private nextId = 1;
  private recent = new Map<string, { result: PauseResult; at: number }>();
  /** Keys whose caller was answered "waiting" — only their outcome is handed over. */
  private waiting = new Set<string>();
  /** The window the user was in when the pause began — where the keyboard goes back after an Esc in the reply box. */
  private startWindow: FocusTarget | null = null;
  private focusTracker: FocusTracker = defaultFocusTracker;

  /** True when a pause would reach a human (overlay can show, not opted out). */
  available(): boolean {
    return process.env.CLAWD_NO_PAUSE !== '1' && controlBanner.canShow();
  }

  /**
   * Does a call with this re-attach key continue an existing pause — the one on screen, or one that settled while its
   * caller was waiting and whose outcome is about to be handed over? Either way it is not a new pause.
   */
  continues(key: string): boolean {
    if (this.pending?.key === key) return true;
    const done = this.recent.get(key);
    return !!done && Date.now() - done.at < RECENT_TTL_MS;
  }

  /** The pause on screen belongs to the running task itself (no re-attach key) — no caller can re-attach to it. */
  isTaskPause(): boolean {
    return !!this.pending && this.pending.key === undefined;
  }

  current(): PauseInfo | null {
    return this.pending ? { ...this.pending.info } : null;
  }

  /** The outcome only. Callers that can act on a typed answer use requestWithReply. */
  async request(req: PauseRequest, opts: { signal?: AbortSignal } = {}): Promise<PauseOutcome> {
    return (await this.requestWithReply(req, opts)).outcome;
  }

  async requestWithReply(req: PauseRequest, opts: { signal?: AbortSignal } = {}): Promise<PauseResult> {
    for (;;) {
      if (opts.signal?.aborted) return { outcome: 'ended' };
      // Re-checked after every wait: a same-key call that queued behind another
      // pause must re-attach, not show the same prompt a second time.
      if (req.key) {
        if (this.pending?.key === req.key) return this.pending.promise;
        const done = this.recent.get(req.key);
        if (done && Date.now() - done.at < RECENT_TTL_MS) {
          this.recent.delete(req.key);
          return done.result;
        }
      }
      if (!this.pending) {
        // Another clawdcursor process's pause is the user's too: queue behind it, as behind one of ours.
        if (!foreignOverlayState().paused) break;
        await untilNoForeignPause(opts.signal);
        continue;
      }
      await this.pending.promise;
    }

    // Callers (the MCP tool) validate and report errors; a bad card reaching here is dropped, never shown half-formed.
    const card = parsePauseCard(req.choices, req.input);
    const info: PauseInfo = {
      id: this.nextId++,
      // Control characters (NUL in particular) would make the overlay spawn fail
      // silently, leaving a pause nobody can see.
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      message: req.message.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE) || 'Your turn.',
      since: Date.now(),
      ...('error' in card ? {} : card),
    };
    let settle!: (r: PauseResult) => void;
    const promise = new Promise<PauseResult>(resolve => { settle = resolve; });
    const entry: Pending = { info, key: req.key, promise, settle };
    this.pending = entry;

    const timer = setTimeout(() => this.finish(entry, { outcome: 'timeout' }), timeoutMs());
    timer.unref?.();
    const onAbort = () => this.finish(entry, { outcome: 'ended' });
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    void promise.then(() => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    });

    // While the user has stopped clawdcursor this prompt asks for control back: only their click answers it.
    if (req.doneWhen && !isStopped()) this.watchDone(entry, req.doneWhen, req.donePollMs ?? DONE_POLL_MS);

    this.startWindow = null;
    void this.focusTracker.capture().then(w => { if (this.pending === entry) this.startWindow = w; }, () => { /* unknown */ });
    controlBanner.showPaused(info, (answer, reply, choice) => { this.answer(answer, 'user', reply, choice); }, pid => { this.refocus(pid); });
    return promise;
  }

  /**
   * Answer the pending pause: Resume continues the run, End task ends it, a reply (the pill's "Something else") continues
   * it with what the user typed, a choice (the index of one of the card's `choices`, as the pill reports it) continues
   * it with that option's text. `by: 'agent'` (an AI calling task {action:"resume"}) resumes as unverified and can never
   * choose: a choice is the user's.
   */
  answer(a: PauseAnswer, by: 'user' | 'agent' = 'user', reply?: string, choice?: number): { ok: true; outcome: PauseOutcome } | { ok: false; error: string } {
    const p = this.pending;
    if (!p) return { ok: false, error: 'nothing is paused' };
    if (a === 'choice') {
      if (by !== 'user') return { ok: false, error: 'a choice can only be made by the user on screen' };
      const text = Number.isInteger(choice) ? p.info.choices?.[choice as number] : undefined;
      if (text === undefined) return { ok: false, error: 'no such choice' };
      this.finish(p, { outcome: 'replied', choice: text });
      return { ok: true, outcome: 'replied' };
    }
    if (a === 'reply') {
      // eslint-disable-next-line no-control-regex -- control characters other than newline/tab are noise from a text box
      const text = String(reply ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_REPLY);
      if (!text) return { ok: false, error: 'the reply is empty' };
      this.finish(p, { outcome: 'replied', reply: text });
      return { ok: true, outcome: 'replied' };
    }
    const outcome: PauseOutcome = a === 'end' ? 'ended' : by === 'agent' ? 'resumed_unverified' : 'resumed';
    this.finish(p, { outcome });
    return { ok: true, outcome };
  }

  /** Poll `doneWhen` until it holds (resume, detected) or the pause settles some other way. Never overlaps itself. */
  private watchDone(entry: Pending, doneWhen: () => Promise<boolean>, pollMs: number): void {
    const tick = async (): Promise<void> => {
      if (this.pending !== entry) return;
      let done = false;
      try { done = await doneWhen(); } catch { /* not done */ }
      if (this.pending !== entry) return;
      if (done) { this.finish(entry, { outcome: 'resumed', detected: true }); return; }
      const t = setTimeout(() => { void tick(); }, pollMs);
      t.unref?.();
    };
    const t = setTimeout(() => { void tick(); }, pollMs);
    t.unref?.();
  }

  /** A keyed caller was answered "waiting": hand its outcome over on its next call. */
  markWaiting(key: string): void {
    this.waiting.add(key);
  }

  /**
   * A keyed caller that DID receive the outcome drops the hand-over copy, so
   * a later identical request asks the user again instead of reusing it.
   */
  forget(key: string): void {
    this.recent.delete(key);
    this.waiting.delete(key);
  }

  private finish(p: Pending, result: PauseResult): void {
    if (this.pending !== p) return;
    this.pending = null;
    if (p.key && this.waiting.delete(p.key)) this.recent.set(p.key, { result, at: Date.now() });
    // The user's own Resume (never an agent's, never a detected done_when) gives control back after a stop (control.ts).
    // 'ended' is the user's End task (or the task being aborted); the reply text is never logged.
    logger.info('pause.end', { outcome: result.outcome, ...(result.detected ? { detected: true } : {}) });
    if (result.outcome === 'resumed' && !result.detected && isStopped()) resumeControl('pause_resume');
    controlBanner.showRunning();
    p.settle(result);
  }

  /**
   * The user pressed Esc in the reply box: give the keyboard back to their window through the platform's own focus code
   * (the Linux pill asks for it; the Windows pill does it itself, SetForegroundWindow). The macOS pill does not ask yet:
   * a key typed right after Esc is sometimes lost there (#255), and re-activating an app made it worse in tests, so it
   * waits for a measured fix. The pill may name the app the user was last in (`pid`); else the window active when the
   * pause began. Same app → that window's title too, so the right window of a multi-window app comes back.
   */
  refocus(pid?: number): void {
    const start = this.startWindow;
    const target: FocusTarget | null = pid
      ? { processId: pid, title: start && start.processId === pid ? start.title : undefined }
      : start;
    // The user's keyboard going back to their own window: not agent input, so never refused or bound (pointer-guard.ts).
    if (target) void unguarded(() => this.focusTracker.focus(target)).catch(() => { /* best effort */ });
  }

  // ── test hooks ──
  __setFocusTrackerForTests(t: FocusTracker | null): void { this.focusTracker = t ?? defaultFocusTracker; }

  __resetForTests(): void {
    if (this.pending) this.finish(this.pending, { outcome: 'ended' });
    this.recent.clear();
    this.waiting.clear();
  }
}

/** Singleton — one pause at a time per process (daemon or stdio MCP server). */
export const pauseGate = new PauseGate();
