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
 * Who answered matters: the pill, CLI, dashboard and POST /resume are the
 * human ('resumed'); an AI calling task {action:"resume"} is 'resumed_unverified',
 * so the agent is told the user did NOT confirm it on screen.
 *
 * Only offered when a human can see it: the overlay must be able to show, and
 * CLAWD_NO_PAUSE=1 restores the old fail-fast behaviour (CI / unattended runs).
 */

import { controlBanner } from './banner';

export type PauseAnswer = 'resume' | 'end';
export type PauseOutcome = 'resumed' | 'resumed_unverified' | 'ended' | 'timeout';

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
  promise: Promise<PauseOutcome>;
  settle: (o: PauseOutcome) => void;
}

const MAX_MESSAGE = 300;
const RECENT_TTL_MS = 5 * 60_000;

function timeoutMs(): number {
  const min = Number(process.env.CLAWD_PAUSE_TIMEOUT_MIN);
  return (Number.isFinite(min) && min > 0 ? min : 15) * 60_000;
}

class PauseGate {
  private pending: Pending | null = null;
  private nextId = 1;
  private recent = new Map<string, { outcome: PauseOutcome; at: number }>();
  /** Keys whose caller was answered "waiting" — only their outcome is handed over. */
  private waiting = new Set<string>();

  /** True when a pause would reach a human (overlay can show, not opted out). */
  available(): boolean {
    return process.env.CLAWD_NO_PAUSE !== '1' && controlBanner.canShow();
  }

  current(): PauseInfo | null {
    return this.pending ? { ...this.pending.info } : null;
  }

  async request(req: PauseRequest, opts: { signal?: AbortSignal } = {}): Promise<PauseOutcome> {
    for (;;) {
      if (opts.signal?.aborted) return 'ended';
      // Re-checked after every wait: a same-key call that queued behind another
      // pause must re-attach, not show the same prompt a second time.
      if (req.key) {
        if (this.pending?.key === req.key) return this.pending.promise;
        const done = this.recent.get(req.key);
        if (done && Date.now() - done.at < RECENT_TTL_MS) {
          this.recent.delete(req.key);
          return done.outcome;
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
    let settle!: (o: PauseOutcome) => void;
    const promise = new Promise<PauseOutcome>(resolve => { settle = resolve; });
    const entry: Pending = { info, key: req.key, promise, settle };
    this.pending = entry;

    const timer = setTimeout(() => this.finish(entry, 'timeout'), timeoutMs());
    timer.unref?.();
    const onAbort = () => this.finish(entry, 'ended');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    void promise.then(() => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    });

    controlBanner.showPaused(info, answer => { this.answer(answer); });
    return promise;
  }

  /**
   * Answer the pending pause: Resume continues the run, End task ends it.
   * `by: 'agent'` (an AI calling task {action:"resume"}) resumes as unverified.
   */
  answer(a: PauseAnswer, by: 'user' | 'agent' = 'user'): { ok: true; outcome: PauseOutcome } | { ok: false; error: string } {
    const p = this.pending;
    if (!p) return { ok: false, error: 'nothing is paused' };
    const outcome: PauseOutcome = a === 'end' ? 'ended' : by === 'agent' ? 'resumed_unverified' : 'resumed';
    this.finish(p, outcome);
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

  private finish(p: Pending, outcome: PauseOutcome): void {
    if (this.pending !== p) return;
    this.pending = null;
    if (p.key && this.waiting.delete(p.key)) this.recent.set(p.key, { outcome, at: Date.now() });
    controlBanner.showRunning();
    p.settle(outcome);
  }

  // ── test hooks ──
  __resetForTests(): void {
    if (this.pending) this.finish(this.pending, 'ended');
    this.recent.clear();
    this.waiting.clear();
  }
}

/** Singleton — one pause at a time per process (daemon or stdio MCP server). */
export const pauseGate = new PauseGate();
