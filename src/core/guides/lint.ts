/**
 * App guide lint: the one check every guide passes before the client shows it (bundled, refreshed or saved on this PC),
 * and before the pack builder (scripts/build-guide-pack.mjs) lets a guide into the pack.
 *
 * The injection and danger rules are the guides repo's (AmrDab/clawdcursor-guides scripts/lint-guide.mjs): keep them equal.
 * The v2 shape and the chord grammar are the format contract (tasks/guide-format-v2.md). Only v2 guides load: a guide
 * without `kind` is refused, so a guide can not pick a weaker check by leaving it out.
 */

export type GuideChord = string | Partial<Record<'default' | 'darwin' | 'win32' | 'linux', string>>;
export interface GuideStep { type: 'pressKey' | 'typeAtFocus' | 'wait' | 'verify'; key?: string; field?: string; ms?: number; name?: string; note?: string }
export interface Guide {
  app: string;
  name?: string;
  kind?: 'web' | 'desktop';
  os?: string[];
  domainHints?: string[];
  processNames?: string[];
  shortcuts: Record<string, GuideChord>;
  consequential?: string[];
  workflows?: Record<string, string | { name?: string; steps?: GuideStep[] }>;
  layout?: Record<string, string>;
  tips?: string[];
  sources?: string[];
  lastVerified?: string;
}

export interface LintOptions {
  /** A guide saved on this PC: smaller caps, and no sources or lastVerified (nothing official to cite). */
  local?: boolean;
}
export interface LintResult { ok: boolean; errors: string[] }

const APP_ID_RE = /^[a-z0-9-]{2,32}$/;
const SHORTCUT_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OS_VALUES = ['win32', 'darwin', 'linux'];
const CHORD_OS_KEYS = ['default', 'darwin', 'win32', 'linux'];
const MODIFIERS = ['mod', 'ctrl', 'shift', 'alt', 'cmd'];
const NAMED_KEYS = new Set([
  'Return', 'Tab', 'Escape', 'Space', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Plus',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);
const STEP_TYPES = ['pressKey', 'typeAtFocus', 'wait', 'verify'];
const URL_OR_PATH_RE = /^(?:https?:\/\/|\/|\.\/|\.\.\/)/i;
// A hostname, optionally with a path prefix where one host serves several apps ("docs.google.com/document").
const VALID_DOMAIN_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/[A-Za-z0-9._~-]+)*$/i;

export const MAX_SHORTCUTS = 150;
export const MAX_WORKFLOWS = 20;
export const MAX_TIPS = 12;
export const MAX_TIP_LEN = 240;
export const MAX_NAME_LEN = 48;
export const MAX_BYTES = 64_000;
export const LOCAL_MAX_SHORTCUTS = 60;
export const LOCAL_MAX_TIPS = 8;

// Same tables as the guides repo's linter.
const INJECTION_PATTERNS: Array<{ pattern: RegExp; rule: string }> = [
  { pattern: /\bignore (?:all |any |the )?(?:previous|prior|earlier|above) (?:instructions|rules|prompts?|directives)\b/i, rule: 'inject.ignore_prior' },
  { pattern: /\bdisregard (?:the |all )?(?:safety|security|guardrails?|rules)\b/i, rule: 'inject.disregard_safety' },
  { pattern: /\byou (?:must|should|need to|will|are required to) (?:always |never )?(?:click|press|type|execute|run) [^,.;\n]{0,80}(?:regardless|no matter|even if|without (?:asking|confirming))/i, rule: 'inject.unconditional_action' },
  { pattern: /\b(?:reveal|disclose|print|output|show|expose) (?:the |your )?(?:system prompt|instructions|prompt|hidden (?:rules|prompt))\b/i, rule: 'inject.reveal_prompt' },
  { pattern: /<\/?(?:system|untrusted-screen-content|tool_use|user)>/i, rule: 'inject.fake_tags' },
  { pattern: /\bact as (?:if you (?:are|were)|an? unrestricted|an? jailbroken|developer mode|sudo mode)/i, rule: 'inject.persona_override' },
  { pattern: /\b(?:bypass|skip|disable|turn off) (?:the |all )?(?:safety|verifier|verification|confirmation|guards?|checks?)\b/i, rule: 'inject.bypass_safety' },
];
const DANGEROUS_PROSE: Array<{ pattern: RegExp; rule: string }> = [
  { pattern: /\b(?:always|automatically) (?:delete|remove|purge|wipe|format)\b/i, rule: 'danger.always_destroy' },
  { pattern: /\b(?:always|automatically) (?:transfer|send|wire) (?:money|funds|cryptocurrency|crypto|bitcoin|btc|eth)\b/i, rule: 'danger.always_transfer' },
  { pattern: /\b(?:always|automatically) (?:purchase|buy|order|checkout)\b/i, rule: 'danger.always_purchase' },
  { pattern: /\b(?:do not|don't|never|without) (?:ask|asking|confirm|confirming|verify|verifying|check|checking|prompt|prompting)(?:\s+(?:the user|first|before))?/i, rule: 'danger.skip_confirmation' },
  { pattern: /\brm\s+-rf\b/i, rule: 'danger.rm_rf' },
];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Every string that can reach an agent, with where it is: all values and all keys of the guide, at any depth (a name, a
 * workflow id, a step field, a chord, a layout key, a domain hint, a source). Keys read as words.
 */
function texts(v: unknown, at = '$', out: Array<{ value: string; at: string }> = [], depth = 0): Array<{ value: string; at: string }> {
  if (typeof v === 'string') out.push({ value: v, at });
  else if (depth < 8 && Array.isArray(v)) v.forEach((x, i) => texts(x, `${at}[${i}]`, out, depth + 1));
  else if (depth < 8 && isObj(v)) for (const [k, x] of Object.entries(v)) { out.push({ value: k.replace(/_/g, ' '), at: `${at}.${k}` }); texts(x, `${at}.${k}`, out, depth + 1); }
  return out;
}

/** What a reader sees: look-alike forms folded (NFKC), zero-width and bidi marks removed, whitespace collapsed to one space. */
export const normalizeText = (s: string): string => s.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ');

/** The chord grammar (guides repo scripts/lint-guide.mjs, kept equal). Returns the problem, or null. `cmd` only where allowed (a darwin chord). */
export function chordProblem(chord: unknown, allowCmd = true): string | null {
  if (typeof chord !== 'string' || chord === '') return 'chord must be a non-empty string';
  for (const part of chord.split(' ')) {
    if (part === '') return `chord "${chord}" has a leading, trailing or doubled space; separate sequence steps with exactly one space`;
    const tokens = part.split('+');
    if (tokens.some(t => t === '')) return `chord "${part}" has an empty token; join tokens with "+" and no spaces`;
    const key = tokens[tokens.length - 1];
    const seen = new Set<string>();
    for (const m of tokens.slice(0, -1)) {
      if (!MODIFIERS.includes(m)) return `"${m}" in "${part}" is not a modifier (use ${MODIFIERS.join(', ')}, lowercase)`;
      if (m === 'cmd' && !allowCmd) return `"cmd" in "${part}" is macOS only; use "mod" or put the chord under "darwin"`;
      if (seen.has(m)) return `modifier "${m}" repeated in "${part}"`;
      seen.add(m);
    }
    if (NAMED_KEYS.has(key)) continue;
    // A modifier on its own is a tap (Office KeyTips: "alt h o"); after other modifiers it is no key.
    if (MODIFIERS.includes(key) && tokens.length === 1 && (key !== 'cmd' || allowCmd)) continue;
    if (MODIFIERS.includes(key)) return `"${part}" ends in a modifier; a chord needs a key`;
    if ([...key].length !== 1) return `"${key}" in "${part}" is not a key`;
    if (key !== key.toLowerCase()) return `key "${key}" in "${part}" must be lowercase; write shift+${key.toLowerCase()} for a shifted letter`;
  }
  return null;
}

/** Lint one guide. Never throws. */
export function lintGuide(raw: unknown, opts: LintOptions = {}): LintResult {
  const errors: string[] = [];
  const err = (m: string) => { errors.push(m); };
  if (!isObj(raw)) return { ok: false, errors: ['guide must be a JSON object'] };
  const g = raw;
  const local = !!opts.local;

  if (typeof g.app !== 'string' || !g.app) return { ok: false, errors: ['app must be a non-empty string'] };
  if (g.name !== undefined && typeof g.name !== 'string') err('name must be a string');
  for (const key of ['shortcuts', 'layout', 'workflows']) if (g[key] !== undefined && !isObj(g[key])) err(`${key} must be an object`);
  if (g.tips !== undefined && !Array.isArray(g.tips)) err('tips must be an array of strings');
  if (g.domainHints !== undefined && !Array.isArray(g.domainHints)) err('domainHints must be an array of strings');
  if (!isObj(g.shortcuts)) err('shortcuts is required');
  if (errors.length) return { ok: false, errors };

  const shortcuts = g.shortcuts as Record<string, unknown>;
  if (Array.isArray(g.domainHints)) {
    g.domainHints.forEach((h, i) => {
      if (typeof h !== 'string') err(`domainHints[${i}] must be a string`);
      else if (URL_OR_PATH_RE.test(h)) err(`domainHints must be bare domains, not URLs or paths (got "${h}")`);
      else if (!VALID_DOMAIN_RE.test(h)) err(`domainHints[${i}] is not a valid domain`);
    });
  }

  // The injection and danger rules apply to every guide.
  for (const { value, at } of texts(g)) {
    const text = normalizeText(value);
    for (const { pattern, rule } of [...INJECTION_PATTERNS, ...DANGEROUS_PROSE]) if (pattern.test(text)) err(`${at}: text matches ${rule}`);
  }
  if (!Object.values(shortcuts).every(c => typeof c === 'string' || isObj(c))) err('every shortcut is a chord string or a per-OS object');
  let size = 0;
  try { size = JSON.stringify(g).length; } catch { /* a cyclic value cannot be a parsed guide */ }
  if (size > MAX_BYTES) err(`guide is ${size} bytes; max ${MAX_BYTES}`);

  // ── v2 shape (the only one: a guide without `kind` is not loaded) ──
  if (!APP_ID_RE.test(g.app)) err('app must be a lowercase id: a-z, 0-9, "-", 2 to 32 characters');
  if (typeof g.name !== 'string' || !g.name.trim()) err('name is required');
  if (g.kind !== 'web' && g.kind !== 'desktop') err('kind must be "web" or "desktop"');
  if (g.os !== undefined && (!Array.isArray(g.os) || !g.os.length || !g.os.every(o => OS_VALUES.includes(o as string)))) err('os must be a list of win32, darwin, linux');
  const strList = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s && s.length <= 100);
  if (g.kind === 'web' && !strList(g.domainHints)) err('a web guide needs domainHints');
  if (g.kind === 'desktop' && !strList(g.processNames)) err('a desktop guide needs processNames');
  if (Array.isArray(g.processNames) && g.processNames.some(p => typeof p === 'string' && (/\.exe$/i.test(p) || /[\\/]/.test(p)))) err('processNames are names without ".exe" or a path');

  const names = Object.keys(shortcuts);
  const maxShortcuts = local ? LOCAL_MAX_SHORTCUTS : MAX_SHORTCUTS;
  if (!names.length) err('shortcuts must not be empty');
  if (names.length > maxShortcuts) err(`${names.length} shortcuts; max ${maxShortcuts}`);
  for (const n of names) {
    if (n.length > MAX_NAME_LEN || !SHORTCUT_NAME_RE.test(n)) { err(`shortcut name "${n.slice(0, 30)}" must be readable snake_case, at most ${MAX_NAME_LEN} characters`); continue; }
    const c = shortcuts[n];
    if (typeof c === 'string') {
      const p = chordProblem(c, false);
      if (p) err(`shortcuts.${n}: chord ${p}`);
    } else if (isObj(c)) {
      const keys = Object.keys(c);
      if (!keys.length || keys.some(k => !CHORD_OS_KEYS.includes(k))) err(`shortcuts.${n}: a per-OS chord has keys among ${CHORD_OS_KEYS.join(', ')}`);
      for (const [k, v] of Object.entries(c)) {
        if (typeof v !== 'string') { err(`shortcuts.${n}.${k} must be a string`); continue; }
        const p = v === '' ? null : chordProblem(v, k === 'darwin');
        if (p) err(`shortcuts.${n}.${k}: chord ${p}`);
      }
    }
  }
  if (g.consequential !== undefined) {
    if (!Array.isArray(g.consequential)) err('consequential must be a list of shortcut names');
    else for (const n of g.consequential) if (typeof n !== 'string' || !(n in shortcuts)) err(`consequential: "${String(n).slice(0, 30)}" is not a shortcut`);
  }
  if (isObj(g.workflows)) {
    const wf = Object.entries(g.workflows);
    if (wf.length > MAX_WORKFLOWS) err(`${wf.length} workflows; max ${MAX_WORKFLOWS}`);
    for (const [id, w] of wf) {
      if (id.length > MAX_NAME_LEN || !SHORTCUT_NAME_RE.test(id)) err(`workflow id "${id.slice(0, 30)}" must be readable snake_case, at most ${MAX_NAME_LEN} characters`);
      if (typeof w === 'string') continue;
      if (!isObj(w) || !Array.isArray(w.steps)) { err(`workflows.${id} needs steps`); continue; }
      if (typeof w.name !== 'string' || !w.name) err(`workflows.${id}.name must be a non-empty string`);
      w.steps.forEach((s, i) => {
        if (!isObj(s) || !STEP_TYPES.includes(s.type as string)) { err(`workflows.${id}.steps[${i}].type must be one of ${STEP_TYPES.join(', ')}`); return; }
        if (s.type === 'pressKey') { const p = chordProblem(s.key); if (p) err(`workflows.${id}.steps[${i}].key: ${p}`); }
        if (s.type === 'wait' && !(typeof s.ms === 'number' && Number.isFinite(s.ms) && s.ms >= 0)) err(`workflows.${id}.steps[${i}].ms must be a number`);
      });
    }
  }
  if (Array.isArray(g.tips)) {
    const maxTips = local ? LOCAL_MAX_TIPS : MAX_TIPS;
    if (g.tips.length > maxTips) err(`${g.tips.length} tips; max ${maxTips}`);
    g.tips.forEach((t, i) => { if (typeof t !== 'string' || t.length > MAX_TIP_LEN) err(`tips[${i}] must be a string of at most ${MAX_TIP_LEN} characters`); });
  }
  if (!local) {
    if (!Array.isArray(g.sources) || !g.sources.length || !g.sources.every(s => typeof s === 'string' && /^https:\/\//.test(s))) err('sources must be a list of https URLs');
    if (typeof g.lastVerified !== 'string' || !DATE_RE.test(g.lastVerified) || Number.isNaN(Date.parse(`${g.lastVerified}T00:00:00Z`)) || new Date(`${g.lastVerified}T00:00:00Z`).toISOString().slice(0, 10) !== g.lastVerified) err('lastVerified must be YYYY-MM-DD');
  }
  return { ok: errors.length === 0, errors };
}
