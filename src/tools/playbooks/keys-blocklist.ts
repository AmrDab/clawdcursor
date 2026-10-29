/**
 * Destructive-key blocklist.
 *
 * v0.8.0 shipped a 3-entry list (alt+f4, ctrl+alt+delete, ctrl+alt+del).
 * The audit flagged this as cosmetic. v0.8.1 expands to the full known
 * destructive set with whitespace-normalized matching so "alt +f4" also
 * blocks.
 *
 * Used by the SafetyLayer. Adding a combo here blocks it across EVERY
 * path (text-agent, vision-agent, MCP direct, REST /action, playbooks).
 */

import { normalizeKey } from '../../platform/keys';

/**
 * Platform-aware substitution for the `mod` modifier — resolves to `cmd` on
 * macOS and `ctrl` on Windows/Linux. Mirrors the `mod` alias in `src/keys.ts`
 * so `mod+q` on macOS is treated the same as `cmd+q` for blocklist matching.
 */
const PLATFORM_MOD_LOWER = process.platform === 'darwin' ? 'cmd' : 'ctrl';

/**
 * One name per key for every spelling an executor accepts: keys.ts
 * `normalizeKey`, the Windows adapter's WIN_KEY_MAP, the nut-js `Key` enum
 * names both Windows executors fall back to (`LeftControl`, `RightAlt`), the
 * Linux and Wayland tables (`rightctrl`, `altgr`) and the macOS ones
 * (`forwarddelete`). Left/right and `_l`/`_r` variants fold into the base key,
 * so a side spelling no table lists yet still classifies as that modifier.
 */
const KEY_FAMILIES: ReadonlyArray<[RegExp, string]> = [
  [/^(left|right|l|r)?(ctrl|control)(_?(l|r))?$/, 'ctrl'],
  [/^(left|right|l|r)?(alt|option|opt)(_?(l|r))?$|^altgr$/, 'alt'],
  [/^(left|right|l|r)?shift(_?(l|r))?$/, 'shift'],
  [/^(esc|escape)$/, 'esc'],
  [/^(del|delete|forwarddelete)$/, 'delete'],
  [/^(space|spacebar)$/, 'space'],
];
/**
 * The super family. Exact `win`/`windows`, `cmd`/`command`, `super`, `meta`
 * keep their spelling (`win` vs `cmd`); the per-OS views below resolve what
 * they press. A side or suffixed variant (`super_l`, `command_l`, `LeftWin`,
 * `RightCmd`, `LeftMeta`), or anything else `normalizeKey` resolves to Super,
 * is `super`: every executor that accepts one presses the Super/Windows key
 * (Command on macOS) — none of them maps those to Ctrl.
 */
const SUPER_SPELLING: ReadonlyMap<string, string> = new Map([['win', 'win'], ['windows', 'win'], ['cmd', 'cmd'], ['command', 'cmd'], ['super', 'super'], ['meta', 'meta']]);
const SUPER_VARIANT = /^(left|right|l|r)?(super|win|windows|meta|cmd|command)(_?(l|r))?$/;
const SUPER_FAMILY: ReadonlySet<string> = new Set(['win', 'cmd', 'super', 'meta']);
/** Modifiers in one fixed order, so `shift+ctrl+esc` is `ctrl+shift+esc`. */
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'win', 'cmd', 'super', 'meta', 'fn'];

/**
 * What a super-family token presses on this OS, per executor. macOS: Command.
 * Linux, and NativeDesktop on Windows (keys.ts): the Super/Windows key. The
 * Windows adapter sends cmd/command/meta as Ctrl and only super/win as the
 * Windows key — so on Windows a chord is classified both ways.
 */
const SUPER_VIEWS: ReadonlyArray<(token: string) => string> =
  process.platform === 'darwin' ? [() => 'cmd']
  : process.platform === 'win32' ? [() => 'win', t => (t === 'super' || t === 'win' ? 'win' : 'ctrl')]
  : [() => 'win'];

/** `token` is lowercased. */
function canonToken(token: string): string {
  const t = token === 'mod' ? PLATFORM_MOD_LOWER : token;
  if (!t) return t;
  const spelled = SUPER_SPELLING.get(t);
  if (spelled) return spelled;
  if (SUPER_VARIANT.test(t) || normalizeKey(t) === 'Super') return 'super';
  return KEY_FAMILIES.find(([re]) => re.test(t))?.[1] ?? t;
}

/** Also breaks on `_` and `-`, so the documented `ctrl-alt-delete` matches. */
function tokensOf(combo: string): string[] {
  return combo.toLowerCase().replace(/\s+/g, '').replace(/[+_-]+/g, '+').split('+').map(canonToken);
}

/** Tokens as the executors read them: split on `+` only, each whole token resolved (`super_l` stays one token). */
function executorTokensOf(combo: string): string[] {
  return combo.toLowerCase().split('+').map(p => p.trim()).filter(Boolean).map(canonToken);
}

function joinTokens(tokens: string[]): string {
  const mods = MODIFIER_ORDER.filter(m => tokens.includes(m));
  return [...mods, ...tokens.filter(t => !MODIFIER_ORDER.includes(t))].join('+');
}

/** Normalize a user-supplied combo for comparison — lowercase, collapse whitespace, resolve `mod` and the executors' aliases, order modifiers. */
export function normalizeCombo(combo: string): string {
  return joinTokens(tokensOf(combo));
}

/** The combo as spelled, plus what each executor on this OS presses for its super-family tokens — for both tokenizations. */
function chordViews(combo: string): string[] {
  return [tokensOf(combo), executorTokensOf(combo)].flatMap(tokens => [
    joinTokens(tokens),
    ...SUPER_VIEWS.map(v => joinTokens(tokens.map(t => (SUPER_FAMILY.has(t) ? v(t) : t)))),
  ]);
}

// Two tiers (v1.6.0): the old single list HARD-blocked everything with NO
// confirm path — even though `blockReason` promised "consent via Confirm-tier".
// That dead-ended legitimate agent actions: win+d (show desktop), ctrl+w
// (close a tab), win+r. Split by reversibility/intent:
//   HARD   — locks the machine, force-quits, or fires a secure-attention /
//            shutdown sequence. Never an agent action; no confirm path.
//   CONFIRM — consequential but legitimate (close window/tab, show desktop,
//            open a launcher). Routes through the normal confirm/allowConfirm
//            gate so an authorized caller can proceed.

/** Hard-blocked: no confirm path. */
const HARD_BLOCK: string[] = [
  'ctrl+alt+delete', 'ctrl+alt+del',  // secure attention sequence
  'win+l', 'cmd+ctrl+q',              // lock the machine
  'cmd+shift+q',                      // macOS log out
  'cmd+opt+esc',                      // macOS force-quit picker
  'ctrl+shift+esc',                   // task manager / force-quit escalation
  'fn+alt+f4',                        // shutdown combo some laptops map to
];

/** Confirm-tier: consequential but a legitimate agent action with approval. */
const CONFIRM_BLOCK: string[] = [
  'alt+f4', 'cmd+q',                  // close all windows / quit app (may lose unsaved work)
  'ctrl+w', 'cmd+w',                  // close tab/window
  'win+r', 'cmd+space',               // Run dialog / Spotlight launcher
  'win+d', 'cmd+f3',                  // show desktop / minimize everything
  'f11',                              // full-screen — often interferes with UIA
];

const HARD_BLOCK_SET: ReadonlySet<string> = new Set(HARD_BLOCK.map(normalizeCombo));
const CONFIRM_BLOCK_SET: ReadonlySet<string> = new Set(CONFIRM_BLOCK.map(normalizeCombo));

export type KeyBlockTier = 'block' | 'confirm' | null;

/** Which element of a sequence matched, and at what tier. */
export interface KeyBlockMatch {
  tier: 'block' | 'confirm';
  /** The offending element — the sequence member, not necessarily the whole input. */
  combo: string;
}

/** Tier of a SINGLE chord — no sequence handling. */
function chordTier(combo: string): KeyBlockTier {
  const views = chordViews(combo);
  if (views.some(n => HARD_BLOCK_SET.has(n))) return 'block';
  if (views.some(n => CONFIRM_BLOCK_SET.has(n))) return 'confirm';
  return null;
}

/**
 * Strongest blocklist match for a chord OR a whitespace-separated sequence.
 *
 * `normalizeCombo` collapses whitespace, so a lookup on the raw input only ever
 * saw ONE chord: "esc win+l" became "escwin+l", matched nothing, and the
 * executor then split that same string on whitespace and pressed win+l anyway
 * (GHSA-35pc-g74h-p476, defect 2). Classification has to mirror what the
 * executor actually does with the string.
 *
 * Both views are checked, strongest tier wins:
 *   - per element — catches every member of a sequence ("esc win+l" -> win+l).
 *   - collapsed whole — keeps the documented "alt +f4" match, a chord that
 *     merely carries a stray space.
 * Checking both cannot under-block relative to either view alone.
 */
export function keyBlockMatch(input: string): KeyBlockMatch | null {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  const views = parts.length > 1 ? [...parts, input] : parts;
  let confirm: KeyBlockMatch | null = null;
  for (const view of views) {
    const tier = chordTier(view);
    if (tier === 'block') return { tier, combo: view }; // strongest possible, stop
    if (tier === 'confirm' && confirm === null) confirm = { tier, combo: view };
  }
  return confirm;
}

/** Classify a chord or sequence: 'block' (hard, no path), 'confirm' (allowConfirm-able), or null (free). */
export function keyBlockTier(combo: string): KeyBlockTier {
  return keyBlockMatch(combo)?.tier ?? null;
}

/** Truthful reason for the given tier. */
export function keyBlockReason(combo: string, tier: 'block' | 'confirm'): string {
  return tier === 'block'
    ? `Key combo "${combo}" is hard-blocked — it locks the machine, force-quits, or fires a system/shutdown sequence an agent must never send.`
    : `Key combo "${combo}" needs confirmation — it closes windows/tabs, shows the desktop, or opens a run/search launcher. If the user authorized it, re-issue inside batch({allowConfirm:true}).`;
}

// ── Back-compat: the old names now mean HARD blocks only ──
/** The read-only normalized HARD-block set. */
export const BLOCKED_KEYS: ReadonlySet<string> = HARD_BLOCK_SET;
/** True only for HARD-blocked combos (no confirm path). Sequence-aware. */
export function isBlockedKey(combo: string): boolean {
  return keyBlockMatch(combo)?.tier === 'block';
}
/** Reason string for a HARD block. */
export function blockReason(combo: string): string {
  return keyBlockReason(combo, 'block');
}
