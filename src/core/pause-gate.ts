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
 * Only offered when a human can see it: the overlay must be able to show, and
 * CLAWD_NO_PAUSE=1 restores the old fail-fast behaviour (CI / unattended runs).
 */

import { controlBanner } from './banner';

export type PauseAnswer = 'resume' | 'end' | 'reply';
export type PauseOutcome = 'resumed' | 'resumed_unverified' | 'ended' | 'timeout' | 'replied';

/** The outcome, plus what the user typed when they answered with "Something else". */
export interface PauseResult {
  outcome: PauseOutcome;
  reply?: string;
}

export interface PauseRequest {
  /** What the user should do. Shown on screen. */
  message: string;
  /** Re-attach key (MCP callers). Same key → same pending pause. */
  key?: string;
}

export interface PauseInfo {
  id: number;
  message: string;
  since: number;
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
const MAX_REPLY = 2000;
const RECENT_TTL_MS = 5 * 60_000;

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
      if (!this.pending) break;
      await this.pending.promise;
    }

    const info: PauseInfo = {
      id: this.nextId++,
      // Control characters (NUL in particular) would make the overlay spawn fail
      // silently, leaving a pause nobody can see.
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      message: req.message.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE) || 'Your turn.',
      since: Date.now(),
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

    this.startWindow = null;
    void this.focusTracker.capture().then(w => { if (this.pending === entry) this.startWindow = w; }, () => { /* unknown */ });
    controlBanner.showPaused(info, (answer, reply) => { this.answer(answer, 'user', reply); }, pid => { this.refocus(pid); });
    return promise;
  }

  /**
   * Answer the pending pause: Resume continues the run, End task ends it, a reply (the pill's "Something else") continues
   * it with what the user typed. `by: 'agent'` (an AI calling task {action:"resume"}) resumes as unverified.
   */
  answer(a: PauseAnswer, by: 'user' | 'agent' = 'user', reply?: string): { ok: true; outcome: PauseOutcome } | { ok: false; error: string } {
    const p = this.pending;
    if (!p) return { ok: false, error: 'nothing is paused' };
    if (a === 'reply') {
      // eslint-disable-next-line no-control-regex -- control characters other than newline/tab are noise from a text box
      const text = String(reply ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_REPLY);
      if (!text) return { ok: false, error: 'the reply is empty' };
      this.finish(p, { outcome: 'replied', reply: text });
      return { ok: true, outcome: 'replied' };
    }
    const outcome: PauseOutcome = a === 'end' ? 'ended' : by === 'agent' ? 'resumed_unverified' : 'resumed';
    this.finish(p, { outcome });
    return { ok: true, outcome };
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
    if (target) void this.focusTracker.focus(target).catch(() => { /* best effort */ });
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
