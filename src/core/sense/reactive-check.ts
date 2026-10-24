/**
 * Layer C — reactive step discipline. After a consequential action, verify the
 * agent-stated expected effect (hard) or a tolerant "did anything change" net
 * (soft), so the agent never blindly proceeds on an action that didn't take.
 * Pure over its inputs + PlatformAdapter reads (OS-agnostic, unit-testable).
 * See docs/superpowers/specs/2026-06-07-ui-state-compiler-layer-c-design.md.
 */
import type { PlatformAdapter } from '../../platform/types';
import { parseAssertions, checkAssertions, renderReport } from '../verify/assertions';

export interface ReactiveInput {
  /** Raw `expect` arg from the tool call (assertions array), or undefined. */
  expect: unknown;
  /** The tool's own result text + success, to fold the note into. */
  toolText: string;
  toolSuccess: boolean;
  /** Whether the tool is screen-changing (consequential). */
  changesScreen: boolean;
  /** Whether the loop observed a change after the action (fingerprint/pixel). */
  observedChange: boolean;
  adapter: PlatformAdapter;
  /** Lazy OCR reader for ocr_contains assertions; omit when unavailable. */
  ocrText?: () => Promise<string>;
  /** Settle budget for hard checks (ms). Defaults to SETTLE_BUDGET_MS. */
  settleMs?: number;
}

/**
 * How long a failing hard check re-polls before declaring a DEVIATION. UIs
 * are asynchronous: a recipient chip resolves via a directory lookup
 * (0.5–3s), window titles update lazily after a save. Declaring DEVIATION
 * off a single immediate check told the model to RETRY actions that had
 * actually taken — a duplicate-send risk on Send/Submit (audit 2026-06-10,
 * finding D1).
 */
export const SETTLE_BUDGET_MS = 2_000;
export const SETTLE_INTERVAL_MS = 250;

/** A modified result (success/text) to replace the tool's, or null = leave as-is. */
export interface ReactiveOutcome { success: boolean; text: string; }

export async function reactiveCheck(input: ReactiveInput): Promise<ReactiveOutcome | null> {
  const hasExpect = input.expect !== undefined && input.expect !== null;

  // A failed action keeps its own error: checking its expected effect would wait out the settle window and then relabel
  // "not found" / "timed out" as a DEVIATION ("it ran but the effect was not seen") when nothing ran.
  if (hasExpect && input.toolSuccess) {
    const parsed = parseAssertions(input.expect);
    if ('error' in parsed) {
      return { success: false, text: `${input.toolText}\nexpect rejected: ${parsed.error}` };
    }
    // Poll until the assertions pass or the settle budget runs out — the UI
    // is allowed to take a moment to manifest the effect before we call it
    // a DEVIATION (which tells the model to retry a possibly-taken action).
    const budget = input.settleMs ?? SETTLE_BUDGET_MS;
    const deadline = Date.now() + budget;
    let report = await checkAssertions(parsed.assertions, { adapter: input.adapter, ocrText: input.ocrText });
    while (!report.ok && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, SETTLE_INTERVAL_MS));
      report = await checkAssertions(parsed.assertions, { adapter: input.adapter, ocrText: input.ocrText });
    }
    if (report.ok) {
      return { success: input.toolSuccess, text: `${input.toolText} — verified ${report.passed} check(s)` };
    }
    return {
      success: false,
      text: `${input.toolText}\nDEVIATION: ${report.failed}/${report.outcomes.length} expected check(s) failed (still failing after a ${Math.round(budget / 1000)}s settle window) — the action did not achieve its effect; adapt (re-find, retry, or a different approach) before continuing:\n${renderReport(report)}`,
    };
  }

  // No expect: tolerant soft net — only for a SUCCESSFUL consequential action
  // that produced no observable change. Never fails the action.
  if (input.changesScreen && input.toolSuccess && !input.observedChange) {
    return { success: true, text: `${input.toolText}\n⚠ no observable change — verify it took (pass \`expect\`) or try another approach.` };
  }

  return null;
}
