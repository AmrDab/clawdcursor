/**
 * `normalizeAppName` — turn a free-form app reference into the short
 * canonical token the alias table is keyed on.
 *
 * Background. A model calls `open_app` with `"outlook app"`. The alias
 * table is keyed on `'outlook'` — so without normalization the lookup
 * misses and the raw name goes to the launcher, which finds no installed
 * app called "outlook app". Same pattern hits "the calculator",
 * "edge browser", "chrome browser", etc.
 *
 * Properties:
 *   - **App-agnostic.** No allowlist of specific apps. Operates on
 *     stop-word stripping rules that work for any English app name.
 *   - **OS-agnostic.** Pure string transform. No platform calls.
 *   - **Model-agnostic.** Can be applied at the alias-resolution choke
 *     point so every caller (open_app, open_file) gets it without
 *     knowing it exists.
 *
 * Why not ask the LLM to normalize? Because the agent's `open_app` tool
 * receives a `name` argument from the LLM directly, and we want the
 * platform layer to be defensive against whatever the LLM emits — same
 * model, same capability, different days, different verbosity. Doing
 * this in code is cheaper, deterministic, and testable.
 */

/**
 * Articles to strip from the front of an app reference.
 * "the outlook" → "outlook" / "an excel sheet" → "excel sheet".
 */
const ARTICLE_PREFIX = /^(?:the|a|an)\s+/i;

/**
 * Generic suffixes that don't change which app the user means.
 * "outlook app" → "outlook" / "edge browser" → "edge" /
 * "calculator window" → "calculator" / "chrome program" → "chrome".
 *
 * Run iteratively so doubled suffixes ("outlook app application")
 * collapse correctly.
 */
const FILLER_SUFFIX = /\s+(?:app|application|browser|window|program)$/i;

/**
 * Quotes / smart quotes the LLM sometimes wraps app names in.
 * Stripped globally so `"outlook"` and `'outlook'` and `"outlook"` all
 * collapse to `outlook` regardless of where they appear.
 */
const QUOTE_CHARS = /['"`‘’“”]/g;

/**
 * Normalize an app reference. Returns a lowercased, trimmed, filler-
 * word-stripped string suitable for direct lookup against
 * `APP_ALIASES`. Returns the empty string for empty / whitespace input.
 *
 * Examples:
 *   "Outlook"                  → "outlook"
 *   "the Outlook app"          → "outlook"
 *   "Microsoft Outlook"        → "microsoft outlook"
 *   "Edge browser"             → "edge"
 *   '"google chrome browser"'  → "google chrome"
 *   "calc app application"     → "calc"
 *   ""                         → ""
 */
export function normalizeAppName(name: string): string {
  let s = name.replace(QUOTE_CHARS, '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(ARTICLE_PREFIX, '').trim();
  for (let i = 0; i < 4; i += 1) {
    const next = s.replace(FILLER_SUFFIX, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}
