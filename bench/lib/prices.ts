/**
 * What a run cost, for the models the benchmark compares. The price table lives here, not in the shipped add-on: prices
 * change, and a wrong one in a release would mislead every user. The runner's own cost (Claude Code's total_cost_usd)
 * is used whenever it gives one.
 */
import type { Usage } from '../../packages/clawdcursor-agent/src/trace';

/** USD per million tokens. */
export const PRICES = {
  haiku: { in: 0.10, out: 0.50, cacheRead: 0.01 },
  sonnet: { in: 2, out: 10, cacheRead: 0.10 },
  opus: { in: 4, out: 20, cacheRead: 0.20 },
} as const;

/** Cache writes are billed at 1.25 x the input price (Anthropic's 5-minute cache). */
const CACHE_WRITE_FACTOR = 1.25;

/** The cost of a run, or null when the runner gave none and the model has no price here. `model` is a label ("claude-code:sonnet") or an id. */
export function costOf(model: string, u: Usage): number | null {
  if (u.usd !== undefined) return u.usd;
  const tier = (['haiku', 'sonnet', 'opus'] as const).find(t => model.toLowerCase().includes(t));
  if (!tier) return null;
  const p = PRICES[tier];
  return (u.in * p.in + u.out * p.out + (u.cacheRead ?? 0) * p.cacheRead + (u.cacheWrite ?? 0) * p.in * CACHE_WRITE_FACTOR) / 1e6;
}
