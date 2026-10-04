/**
 * Assertion engine — harness-executed task verification.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Task verification used to be model-claimed: `done(evidence)` took a prose
 * string and the guards only checked it for length/hedging — nothing
 * re-checked reality. In the 2026-06-06 live Outlook run the model looked at
 * a real screenshot, "verified" a recipient that was never committed, and the
 * task died 12 turns later at send time.
 *
 * THE DESIGN
 * ----------
 * The model PROPOSES machine-checkable proofs; the harness EXECUTES them
 * against ground truth. No LLM judgment, no screenshot tokens. The checks
 * mirror the perception cost ladder — strongest/cheapest first:
 *
 *   out-of-band artifacts   file_exists / file_contains / clipboard_contains
 *   OS window facts         window_title_contains / app_running
 *   UIA element facts       element_exists / element_value_contains
 *   pixel-derived text      ocr_contains  (the only check that touches pixels)
 *
 * LAYERING
 * --------
 * This module is pure core: it depends on PlatformAdapter (reads only) and
 * node:fs — never on tools, the agent loop, or the MCP surface. It is mounted
 * twice: by the System B `verify` tool (which projects to the MCP surface for
 * external agents) and by the `done(assertions)` completion gate.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import type { PlatformAdapter } from '../../platform/types';

// ─── Types ───────────────────────────────────────────────────────────────────

export type Assertion =
  | { type: 'window_title_contains'; value: string }
  | { type: 'app_running'; name: string }
  | { type: 'element_exists'; name: string }
  | { type: 'element_value_contains'; name: string; value: string }
  | { type: 'clipboard_contains'; value: string }
  | { type: 'file_exists'; path: string }
  | { type: 'file_contains'; path: string; value: string }
  | { type: 'ocr_contains'; value: string }
  | { type: 'file_changed_since_start'; path: string };

export interface AssertionDeps {
  adapter: PlatformAdapter;
  /** Lazy OCR reader — only invoked for `ocr_contains` (the one pixel-derived
   *  check). Left unwired in contexts without an OCR engine; the assertion
   *  then fails with an explanatory detail instead of throwing. */
  ocrText?: () => Promise<string>;
  /** Epoch-ms timestamp of task start. Required by `file_changed_since_start`
   *  (the proof that a mutating task actually wrote the file it claims to). */
  taskStartedAt?: number;
}

export interface AssertionOutcome {
  index: number;
  /** Compact human/LLM-readable restatement, e.g. `element_value_contains("To", "a@b.com")`. */
  summary: string;
  ok: boolean;
  /** Why it failed (or what matched) — includes the ACTUAL observed value so
   *  a failing model can correct course instead of retrying blind. */
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  passed: number;
  failed: number;
  outcomes: AssertionOutcome[];
}

/** Hard cap — verification is a proof, not a checklist dump. */
export const MAX_ASSERTIONS = 8;

/** Required string fields per assertion type. Single source of truth for
 *  parse validation AND the error message listing valid types. */
const FIELDS_BY_TYPE: Record<Assertion['type'], readonly string[]> = {
  window_title_contains: ['value'],
  app_running: ['name'],
  element_exists: ['name'],
  element_value_contains: ['name', 'value'],
  clipboard_contains: ['value'],
  file_exists: ['path'],
  file_contains: ['path', 'value'],
  ocr_contains: ['value'],
  file_changed_since_start: ['path'],
};

// ─── Parsing / validation ────────────────────────────────────────────────────

/**
 * Validate raw model input into a typed assertion list. Returns `{error}`
 * (never throws) so tool handlers can reject with a corrective message.
 */
export function parseAssertions(raw: unknown): { assertions: Assertion[] } | { error: string } {
  // The compound MCP surface publishes array params as JSON arrays, but hosts
  // routinely deliver them as a JSON-encoded STRING (batch.steps already
  // decodes that form). Accept it here too — rejecting a form the schema
  // advertises made `expect` fail AFTER the action had run (live, 2026-10).
  if (typeof raw === 'string' && raw.trimStart().startsWith('[')) {
    try { raw = JSON.parse(raw); } catch { /* fall through to the array error */ }
  }
  if (!Array.isArray(raw)) {
    return { error: `assertions must be an array of {type, ...} objects, or a JSON-encoded string of one (got ${typeof raw}). Valid types: ${Object.keys(FIELDS_BY_TYPE).join(', ')}.` };
  }
  if (raw.length === 0) {
    return { error: 'assertions array is empty — provide at least one machine-checkable proof.' };
  }
  if (raw.length > MAX_ASSERTIONS) {
    return { error: `too many assertions (${raw.length} > ${MAX_ASSERTIONS}) — verify the few facts that actually prove the task.` };
  }
  const assertions: Assertion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i] as Record<string, unknown> | null;
    if (!a || typeof a !== 'object') {
      return { error: `assertion ${i} is not an object.` };
    }
    const type = String(a.type ?? '');
    const fields = (FIELDS_BY_TYPE as Record<string, readonly string[]>)[type];
    if (!fields) {
      return { error: `assertion ${i} has unknown type "${type}". Valid types: ${Object.keys(FIELDS_BY_TYPE).join(', ')}.` };
    }
    for (const f of fields) {
      if (typeof a[f] !== 'string' || (a[f] as string).length === 0) {
        return { error: `assertion ${i} (${type}) is missing required string field "${f}".` };
      }
    }
    assertions.push(a as unknown as Assertion);
  }
  return { assertions };
}

/**
 * Pre-flight for a tool call's `expect`: null when absent or well-formed,
 * otherwise the parse error. Callers check this BEFORE acting so a malformed
 * `expect` is refused with nothing executed — validating after the action
 * meant a retrying agent double-clicked (live, 2026-10).
 */
export function validateExpect(expect: unknown): string | null {
  if (expect === undefined || expect === null) return null;
  const parsed = parseAssertions(expect);
  return 'error' in parsed ? parsed.error : null;
}

// ─── Execution ───────────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase();
const containsCI = (haystack: string, needle: string) => norm(haystack).includes(norm(needle));
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Expand a leading `~` so model-supplied paths like `~/Documents/x.txt` work. */
function expandHome(p: string): string {
  return p.startsWith('~') ? homedir() + p.slice(1) : p;
}

/** Cap file_contains reads — verification targets are documents, not dumps. */
const MAX_FILE_BYTES = 1024 * 1024;

async function checkOne(a: Assertion, deps: AssertionDeps): Promise<{ ok: boolean; detail: string }> {
  const { adapter } = deps;
  switch (a.type) {
    case 'window_title_contains': {
      const wins = await adapter.listWindows();
      const hit = wins.find(w => containsCI(w.title ?? '', a.value));
      if (hit) return { ok: true, detail: `matched "${truncate(hit.title, 60)}"` };
      const titles = wins.slice(0, 5).map(w => `"${truncate(w.title, 40)}"`).join(', ');
      return { ok: false, detail: `no open window title contains "${a.value}" (open: ${titles || 'none'})` };
    }
    case 'app_running': {
      const wins = await adapter.listWindows();
      const hit = wins.find(w => containsCI(w.processName ?? '', a.name));
      return hit
        ? { ok: true, detail: `process "${hit.processName}" has a window` }
        : { ok: false, detail: `no window belongs to a process matching "${a.name}"` };
    }
    case 'element_exists': {
      const hits = await adapter.findElements({ name: a.name });
      return hits.length > 0
        ? { ok: true, detail: `${hits.length} element(s) named "${a.name}"` }
        : { ok: false, detail: `no accessibility element named "${a.name}" (sparse-tree app? try ocr_contains)` };
    }
    case 'element_value_contains': {
      const res = await adapter.invokeElement({ name: a.name, action: 'get-value' });
      if (!res.success) return { ok: false, detail: `"${a.name}" has no readable value` };
      const value = String((res.data as { value?: unknown } | undefined)?.value ?? '');
      return containsCI(value, a.value)
        ? { ok: true, detail: `"${a.name}" = "${truncate(value, 80)}"` }
        : { ok: false, detail: `"${a.name}" = "${truncate(value, 80)}" — does not contain "${a.value}"` };
    }
    case 'clipboard_contains': {
      const clip = await adapter.readClipboard();
      return containsCI(clip ?? '', a.value)
        ? { ok: true, detail: 'clipboard matches' }
        : { ok: false, detail: `clipboard is "${truncate(clip ?? '', 60)}" — does not contain "${a.value}"` };
    }
    case 'file_exists': {
      try {
        const st = await fs.stat(expandHome(a.path));
        return { ok: true, detail: `exists (${st.size} bytes)` };
      } catch {
        return { ok: false, detail: `no file at "${a.path}"` };
      }
    }
    case 'file_contains': {
      let content: string;
      try {
        const fh = await fs.open(expandHome(a.path), 'r');
        try {
          const buf = Buffer.alloc(MAX_FILE_BYTES);
          const { bytesRead } = await fh.read(buf, 0, MAX_FILE_BYTES, 0);
          content = buf.subarray(0, bytesRead).toString('utf8');
        } finally {
          await fh.close();
        }
      } catch {
        return { ok: false, detail: `cannot read "${a.path}"` };
      }
      return containsCI(content, a.value)
        ? { ok: true, detail: 'file content matches' }
        : { ok: false, detail: `file does not contain "${a.value}" (read ${Math.min(content.length, MAX_FILE_BYTES)} chars)` };
    }
    case 'ocr_contains': {
      if (!deps.ocrText) return { ok: false, detail: 'OCR is not wired in this context — use element/window assertions instead' };
      const text = await deps.ocrText();
      return containsCI(text, a.value)
        ? { ok: true, detail: 'visible on screen (OCR)' }
        : { ok: false, detail: `OCR text does not contain "${a.value}"` };
    }
    case 'file_changed_since_start': {
      // The proof that a mutating task actually WROTE the file it claims to —
      // catches "claimed success, nothing happened" for file effects (a live
      // wallpaper task 'verified' via the clock while the wallpaper file went
      // untouched). Discriminating by construction: at task start nothing has
      // been modified-since-start yet.
      if (deps.taskStartedAt === undefined) {
        return { ok: false, detail: 'no task-start timestamp in this context — file_changed_since_start only works inside a task run' };
      }
      try {
        const st = await fs.stat(expandHome(a.path));
        const delta = Math.round((st.mtimeMs - deps.taskStartedAt) / 1000);
        return st.mtimeMs > deps.taskStartedAt
          ? { ok: true, detail: `modified ${delta}s into the task` }
          : { ok: false, detail: `NOT modified since the task started (mtime is ${Math.abs(delta)}s older than task start) — your action did not change this file` };
      } catch {
        return { ok: false, detail: `no file at "${a.path}"` };
      }
    }
  }
}

function summarize(a: Assertion): string {
  const args = (FIELDS_BY_TYPE[a.type] as readonly string[])
    .map(f => `"${truncate(String((a as unknown as Record<string, unknown>)[f]), 40)}"`)
    .join(', ');
  return `${a.type}(${args})`;
}

/**
 * Execute every assertion against current ground truth. Per-assertion errors
 * (UIA down, fs error) fail THAT assertion with the error text — the function
 * itself never throws.
 */
export async function checkAssertions(assertions: Assertion[], deps: AssertionDeps): Promise<VerifyReport> {
  const outcomes: AssertionOutcome[] = [];
  for (let i = 0; i < assertions.length; i++) {
    const a = assertions[i];
    let ok: boolean;
    let detail: string;
    try {
      ({ ok, detail } = await checkOne(a, deps));
    } catch (err) {
      ok = false;
      detail = `check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    outcomes.push({ index: i, summary: summarize(a), ok, detail });
  }
  const passed = outcomes.filter(o => o.ok).length;
  return { ok: passed === outcomes.length, passed, failed: outcomes.length - passed, outcomes };
}

/** Compact ✓/✗ report — readable by humans and cheap for LLM context. */
export function renderReport(report: VerifyReport): string {
  return report.outcomes
    .map(o => `${o.ok ? '✓' : '✗'} ${o.summary} — ${o.detail}`)
    .join('\n');
}

// ─── Discriminating-assertion gate (false-success defense) ────────────────────
//
// A passing assertion only PROVES the task did something if it was NOT already
// true before the task ran. A "change the wallpaper" task that 'verifies' via
// ocr_contains("8:41 PM") — a clock that's on screen regardless — proves
// nothing. We capture a cheap baseline at task start and, for the assertion
// types we can judge cheaply, reject a completion whose evidence was ALL true
// at baseline. Types we can't judge from the baseline (element_*, file_exists,
// file_contains) return null and are TRUSTED — never the source of a false
// rejection. This is the non-LLM ~80% gate; full task-intent↔assertion
// semantic relevance (e.g. a clock that genuinely ticked is "discriminating"
// yet irrelevant) stays a deliberate, documented gap.

export interface TaskBaseline {
  startedAt: number;
  /** Lower-cased OCR text of the screen at task start. */
  ocrText: string;
  /** Lower-cased window titles present at task start. */
  windowTitles: string[];
  /** Lower-cased process names with a window at task start. */
  processNames: string[];
  /** Lower-cased clipboard contents at task start. */
  clipboard: string;
}

/** Capture the cheap baseline artifacts at task start. Best-effort: any source
 *  that fails contributes an empty value rather than throwing. */
export async function captureTaskBaseline(
  adapter: PlatformAdapter,
  ocrText?: () => Promise<string>,
): Promise<TaskBaseline> {
  const startedAt = Date.now();
  let windowTitles: string[] = [];
  let processNames: string[] = [];
  try {
    const wins = await adapter.listWindows();
    windowTitles = wins.map(w => (w.title ?? '').toLowerCase());
    processNames = wins.map(w => (w.processName ?? '').toLowerCase());
  } catch { /* empty */ }
  let clipboard = '';
  try { clipboard = ((await adapter.readClipboard()) ?? '').toLowerCase(); } catch { /* empty */ }
  let ocr = '';
  try { ocr = ocrText ? (await ocrText()).toLowerCase() : ''; } catch { /* empty */ }
  return { startedAt, ocrText: ocr, windowTitles, processNames, clipboard };
}

/**
 * Was this assertion ALREADY satisfied at task start?
 *   true  — provably true at baseline (non-discriminating: proves nothing changed)
 *   false — provably NOT true at baseline (discriminating: the task made it true)
 *   null  — undeterminable from the cheap baseline (element/file checks) → trusted
 */
export function wasTrueAtBaseline(a: Assertion, b: TaskBaseline): boolean | null {
  const has = (h: string, n: string) => h.includes(n.toLowerCase());
  switch (a.type) {
    case 'ocr_contains':             return has(b.ocrText, a.value);
    case 'clipboard_contains':       return has(b.clipboard, a.value);
    case 'window_title_contains':    return b.windowTitles.some(t => has(t, a.value));
    case 'app_running':              return b.processNames.some(p => has(p, a.name));
    case 'file_changed_since_start': return false; // by construction: nothing is changed-since-start at start
    default:                         return null;  // element_*, file_exists, file_contains — trust
  }
}

/**
 * Given a PASSING report, is at least one passing assertion discriminating
 * (not provably true at baseline)? Returns true when the evidence genuinely
 * reflects a change, false when EVERY passing proof was already true before
 * the task acted.
 */
export function hasDiscriminatingEvidence(
  assertions: Assertion[],
  report: VerifyReport,
  baseline: TaskBaseline,
): boolean {
  return assertions.some((a, i) =>
    report.outcomes[i]?.ok === true && wasTrueAtBaseline(a, baseline) !== true,
  );
}
