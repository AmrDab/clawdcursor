/**
 * Session-scoped cache of recently compiled UIMaps, enabling safe el_NN element
 * references (resolve {snapshot_id, element_id} -> live element). Strict by
 * design: only the CURRENT, non-invalidated, in-TTL map resolves. See
 * docs/superpowers/specs/2026-06-07-ui-state-compiler-part2-design.md §2.
 */
import type { UIMap, MaxCost } from './ui-map-types';

/**
 * Wall-clock backstop for ref freshness. The PRIMARY staleness signal is
 * event-driven (`invalidate()` after every screen-changing action) plus the
 * resolve-time window guard (pid/title must still match) — the TTL only
 * catches background drift no agent action caused. It must therefore be
 * sized to SURVIVE an LLM round-trip: refs are advertised at the end of
 * turn N and consumed on turn N+1, after prompt assembly + a full model
 * call (45s timeout, backoff retries). The original 5s expired virtually
 * every cross-turn ref (audit 2026-06-10, finding A2).
 */
export const TTL_MS = 60_000;

/** Perception-cost ordering for reuse decisions: cheap < ocr_ok < vision_ok. */
export const COST_RANK: Record<MaxCost, number> = { cheap: 0, ocr_ok: 1, vision_ok: 2 };
/** Keep the current map + one prior (diagnostics); only current resolves. */
export const MAX_HELD = 2;

type Resolution = { ok: true; map: UIMap } | { ok: false; reason: 'unknown' | 'stale' | 'expired' };

export class UIMapHolder {
  private held: Array<{ map: UIMap; compiledAt: number; maxCost?: MaxCost }> = [];
  private counter = 0;
  private invalidated = false;

  /** Mint the next session-scoped id; caller passes it to compileUIMap. */
  nextId(): string {
    this.counter += 1;
    return `obs_${this.counter}`;
  }

  /** Store a compiled map as the new current; records the compiled max_cost
   *  (for currentIfCost reuse); un-invalidates; bounds to MAX_HELD. */
  put(map: UIMap, now: number, maxCost?: MaxCost): void {
    this.held.push({ map, compiledAt: now, maxCost });
    if (this.held.length > MAX_HELD) this.held.shift();
    this.invalidated = false;
  }

  /** Resolve a ref. Only the current, non-invalidated, in-TTL map is usable. */
  resolve(snapshotId: string, now: number): Resolution {
    const current = this.held[this.held.length - 1];
    if (!current || current.map.snapshot_id !== snapshotId) {
      const heldOlder = this.held.some(h => h.map.snapshot_id === snapshotId);
      return { ok: false, reason: heldOlder ? 'stale' : 'unknown' };
    }
    if (this.invalidated) return { ok: false, reason: 'stale' };
    if (now - current.compiledAt > TTL_MS) return { ok: false, reason: 'expired' };
    return { ok: true, map: current.map };
  }

  /** Return the current map iff it resolves (fresh/in-TTL/not-invalidated) AND
   *  was compiled at a cost >= requested. Else null (caller compiles fresh).
   *  Correctness first, cost-reuse second. */
  currentIfCost(requested: MaxCost, now: number): UIMap | null {
    const current = this.held[this.held.length - 1];
    if (!current) return null;
    if (this.resolve(current.map.snapshot_id, now).ok !== true) return null;
    if (current.maxCost === undefined) return null;              // unknown cost → don't reuse
    return COST_RANK[current.maxCost] >= COST_RANK[requested] ? current.map : null;
  }

  /** Mark all held maps invalid — called after any screen-changing action. */
  invalidate(): void {
    this.invalidated = true;
  }

  currentId(): string | undefined {
    return this.held[this.held.length - 1]?.map.snapshot_id;
  }

  /** The latest held map (for rendering/inspection), or undefined. Unlike
   *  resolve(), this ignores TTL/invalidation — callers that need a resolvable
   *  map use resolve()/currentIfCost(). */
  current(): UIMap | undefined {
    return this.held[this.held.length - 1]?.map;
  }
}
