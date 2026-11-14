/**
 * Paste-as-type is only safe when the clipboard really holds what we meant to type.
 *
 * A clipboard write can fail silently — on Windows it is `Set-Clipboard` in a fresh PowerShell with a 2 s budget, and a
 * timeout or error was swallowed — and the Ctrl+V that followed then pasted the USER'S clipboard into the focused field.
 * Seen live (2026-10-19): typing a URL + Enter into Edge's address bar submitted the user's own clipboard contents as a
 * web search, twice. Every paste path checks the clipboard first and types the text instead when it does not hold it.
 *
 * What was typed or set is then read back from the field (readBackTyped, setResult).
 */
import type { PlatformAdapter } from '../platform/types';
import { quoteScreenText } from '../core/untrusted-screen-content';
import { sleep } from '../sleep';

/** Clipboards differ in line endings and trailing whitespace (Windows reads come back trimmed). */
const same = (a: string, b: string): boolean => a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();

/**
 * Write `text` and confirm the clipboard holds it, trying twice. False: do NOT paste — type the text instead.
 * Never throws.
 */
export async function writeClipboardVerified(
  write: (text: string) => Promise<void>,
  read: () => Promise<string>,
  text: string,
  attempts = 2,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try { await write(text); } catch { /* checked below */ }
    try { if (same(await read(), text)) return true; } catch { /* unreadable: not confirmed */ }
  }
  return false;
}

/**
 * After Ctrl/Cmd+V, wait until the paste has landed before the clipboard is put back. The keystroke is only posted: the
 * app reads the clipboard when it gets to it, and a busy one (an Electron app, a loaded browser tab, a remote session)
 * could otherwise read the RESTORED clipboard — typing the user's own clipboard where the text should go.
 *
 * Watches the focused field for the text, up to `maxMs`. A field that shows no value (a password box), or whose value
 * never changes (a canvas or code editor that does not report its text), gets the shorter `blindMs` instead. A slow
 * read (AT-SPI spawns a process per read) cannot push the wait past `maxMs`. Never throws.
 */
export async function waitForPaste(
  readFocusedValue: () => Promise<string | null | undefined>,
  text: string,
  opts: { minMs?: number; blindMs?: number; maxMs?: number; stepMs?: number } = {},
): Promise<void> {
  const { minMs = 100, blindMs = 400, maxMs = 1000, stepMs = 50 } = opts;
  const want = text.replace(/\r\n/g, '\n').trim();
  const t0 = Date.now();
  await sleep(minMs);
  let first: string | undefined;
  let changed = false;
  for (;;) {
    const left = maxMs - (Date.now() - t0);
    if (left <= 0) return;
    let v: string | null | undefined = null;
    try { v = await Promise.race([readFocusedValue(), sleep(left).then(() => null)]); } catch { /* unreadable */ }
    if (typeof v === 'string') {
      const norm = v.replace(/\r\n/g, '\n');
      if (!want || norm.includes(want)) return;
      if (first === undefined) first = norm;
      else if (norm !== first) changed = true;
    }
    if (!changed && Date.now() - t0 >= blindMs) return;
    await sleep(stepMs);
  }
}

/**
 * Up to this many characters, typing is real keystrokes and the user's clipboard is never touched. Longer text is
 * pasted (verified, restored): keystrokes run ~20 ms a character, so 2,000 would take 40 s.
 */
export const TYPE_KEYS_MAX = 120;

/**
 * Whether `text` goes as keystrokes: short, and plain printable ASCII only. A newline or tab would be a KEY (Return sends
 * a chat message half-typed, Tab moves to the next field), and non-ASCII needs a helper that is not on every machine
 * (macOS without its accessibility helper refuses it) — those are pasted, as literal text, as before.
 */
export function typesAsKeys(text: string): boolean {
  return text.length <= TYPE_KEYS_MAX && /^[\x20-\x7e]*$/.test(text);
}

/**
 * 'match': the field shows the text. 'suffix': it shows the text with more after it — an inline autocomplete suggestion
 * (an address bar), the case where Return would go somewhere else — or, for a replaced field, in another format.
 * 'mismatch': it shows other text (the field rewrote it, or the keys went elsewhere). 'unknown': it cannot be told.
 */
export type ReadBack = 'match' | 'suffix' | 'mismatch' | 'unknown';

/** What a field's text looks like for comparison: line breaks and runs of spaces as one space. */
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Windows reads a field without a value pattern through TextPattern, capped at 1000 characters: past that, no verdict. */
const READ_CAP = 1000;

/** A plain number at the start of a text; a comma may be its decimal mark. */
const NUMBER = /^[-+]?\d+(?:[.,]\d+)?/;

/**
 * Does a field that was to hold `want`, and nothing else, hold it? The one rule behind every value-setting path (both
 * texts flattened; case is ignored, as the Windows bridge's own check does):
 *   - the same text is a 'match';
 *   - a NUMBER is compared as a number, against the number the field starts with (after a currency sign): "30.0",
 *     "30,00", "30 mm" and "$30.00" hold 30 (AT-SPI reads a value back as a float, a field adds decimals or a unit),
 *     "300" and "10030" do not — and for a number "starts with it" proves nothing;
 *   - a 'suffix' cannot be told from a success: other text with more AFTER it (an inline autocomplete suggestion), or
 *     the same letters and digits in another format ("1,000" for 1000, "(555) 123-4567", a card number in groups);
 *   - anything else is a 'mismatch' (old text that was not replaced, a rewrite).
 */
function holdsValue(shown: string, want: string): Exclude<ReadBack, 'unknown'> {
  const v = shown.toLowerCase(), w = want.toLowerCase();
  if (v === w) return 'match';
  const numeric = NUMBER.exec(w)?.[0] === w;
  if (numeric) {
    const amount = v.replace(/^\p{Sc}\s*/u, '');
    const n = NUMBER.exec(amount)?.[0];
    if (n !== undefined && !/\d/.test(amount.slice(n.length)) && Number(n.replace(',', '.')) === Number(w.replace(',', '.'))) return 'match';
  }
  const bare = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '');
  return (!numeric && w && v.startsWith(w)) || (bare(w) && bare(v) === bare(w)) ? 'suffix' : 'mismatch';
}

/**
 * The warning when a field that can be read still reads empty after typing (#377). Not a failure, and no retype: an app
 * that takes keys through a hidden input it empties (an xterm.js terminal, Google Docs) reads the same way.
 */
export const EMPTY_AFTER_TYPING = 'read back: the focused field reads empty. The text may not have arrived (the keys went to another element, or a paste came too late), or the app takes keys through a hidden input it empties (a terminal, an online document editor). Read what the screen shows first (compile_ui or ocr); type again only if the text is not there.';

/** What a read of a field gave. `readable`: the read itself worked, so an empty `value` means the field IS empty. */
export type FieldRead = { value?: string; secure?: boolean; readable?: boolean };

/**
 * Read the focused field after typing. 'unknown' when it cannot be told — no focused element, a password field (its
 * value is withheld), a field that exposes no text (empty value: many custom controls), or a value at the read cap.
 * Polls briefly: a field can lag the keys. `value` is what the field showed (for the caller to report). Never throws.
 *
 * `whole`: the field was to be REPLACED, so it must hold the text and nothing else (holdsValue).
 *
 * An empty read counts only when the reader says the field is `readable` (a by-name value read does, see fieldRead, and
 * so does the focused-element read): then a clear is confirmed, and a field that still shows nothing after typing or a
 * set is a 'mismatch' with value '' (#377: a paste that read the clipboard after it was restored); typing callers report
 * it as a warning only (EMPTY_AFTER_TYPING). Without `readable`, an empty read is also what an unreadable field gives,
 * and stays 'unknown'.
 */
export async function readBackTyped(
  focused: () => Promise<FieldRead | null | undefined>,
  text: string,
  opts: { maxMs?: number; stepMs?: number; submit?: boolean; whole?: boolean } = {},
): Promise<{ result: ReadBack; value?: string; secure?: boolean }> {
  const { maxMs = 300, stepMs = 100, submit = false, whole = false } = opts;
  const want = flat(text);
  if (!want && !whole) return { result: 'unknown' };
  const t0 = Date.now();
  let last: { result: ReadBack; value?: string } = { result: 'unknown' };
  for (;;) {
    let el: FieldRead | null | undefined = null;
    try { el = await focused(); } catch { /* unreadable */ }
    if (el?.secure) return { result: 'unknown', secure: true };
    const raw = typeof el?.value === 'string' ? el.value : '';
    const v = raw.length >= READ_CAP ? '' : flat(raw);
    if (v || (el?.readable === true && raw.length < READ_CAP)) {
      // Before a submit the field must END with the text (Return goes to whatever follows it); otherwise anywhere will
      // do — typing into the middle of a document.
      const result = whole ? holdsValue(v, want)
        : (submit ? v.endsWith(want) : v.includes(want)) ? 'match' : v.includes(want) ? 'suffix' : 'mismatch';
      if (result === 'match') return { result, value: v };
      last = { result, value: v };
    }
    if (Date.now() - t0 >= maxMs) return last;
    await new Promise(r => setTimeout(r, stepMs));
  }
}

/**
 * What a by-name get-value says the field holds. Null: it could not be read — the read failed, or the element has no
 * value and the bridge answered with its NAME (`method` "name", `readable` false): that is not the field's text.
 * The bridges say `readable` themselves; a non-empty value was evidently read.
 */
export function fieldRead(res: { success: boolean; data?: Record<string, unknown> }): FieldRead | null {
  const d = res.data;
  if (!res.success || !d) return null;
  if (d.secure === true) return { secure: true };
  if (typeof d.value !== 'string' || /^name$/i.test(String(d.method))) return null;
  return (typeof d.readable === 'boolean' ? d.readable : d.value !== '') ? { value: d.value, readable: true } : null;
}

/** How the typing fallback went: 'typed'; 'unfocused' (clicked, the focus did not go to the field, nothing typed); or why it was not tried. */
export type Retyped = 'typed' | 'unfocused' | { skipped: string };
/**
 * How every set_field_value path ends: one read-back (readBackTyped, whole value) decides the result. A field that holds
 * the value is confirmed; one that shows it with more after it or in another format, or cannot be read, is a success
 * said to be NOT verified; any other text — or nothing, in a field that can be read — is a failure that says what the
 * field shows. Reads `named` (the field a native set wrote to), or without it the focused field (where the value was
 * typed).
 *
 * `retry`: the direct set wrote to `named` and had NO effect — the field is still empty, or holds exactly what it held
 * `before` the set (a web field can ignore a value set through accessibility). `type` is then called ONCE to type the
 * value into the field instead; when it did ('typed') the field is read again and the result names that path. Any other
 * mismatch (a reformat, other text) stays a failure, and a field that cannot be read (a password field) is never typed into.
 */
export async function setResult(
  platform: Pick<PlatformAdapter, 'getFocusedElement' | 'invokeElement'>, value: string, label: string, how: string,
  named?: { name: string; controlType?: string; processId?: number },
  retry?: { before?: string; type: () => Promise<Retyped> },
): Promise<{ success: boolean; text: string; targetLabel: string }> {
  const read = () => readBackTyped(async () => {
    if (!named) return platform.getFocusedElement();
    return fieldRead(await platform.invokeElement({ ...named, action: 'get-value' }));
  }, value, { whole: true });
  let rb = await read();
  let retyped: Retyped | undefined;
  const noEffect = rb.result === 'mismatch' && (!rb.value || (retry?.before !== undefined && flat(retry.before) === rb.value));
  if (named && retry && noEffect) {
    retyped = await retry.type();
    if (retyped === 'typed') rb = await read();
  }
  return { ...setVerdict(rb, value, label, how, retyped), targetLabel: label };
}

/**
 * The words every set ends with, from its one read-back (readBackTyped, whole value): confirmed, NOT verified, or a failure
 * that says what the field shows. Also how a browser type (a CDP fill, #399) ends: it replaces the field's text too.
 */
export function setVerdict(
  rb: { result: ReadBack; value?: string }, value: string, label: string, how: string, retyped?: Retyped,
): { success: boolean; text: string } {
  const typed = retyped === 'typed';
  const set = `${quoteScreenText(label)} = ${value.length} chars${how}${typed ? ' (set via keys after the direct set had no effect)' : ''}`;
  const cut = (s: string) => quoteScreenText(s.length > 80 ? `${s.slice(0, 79)}…` : s);
  const shows = `the field shows ${cut(rb.value ?? '')}`;
  const alsoTyped = typed ? ' Typing it into the field (select-all + keys) after the direct set did not change that.'
    : retyped === 'unfocused' ? ' To type it instead, the field was clicked, but could not focus the field to type into it; nothing was typed.'
    : typeof retyped === 'object' ? ` It was not typed into the field instead: ${retyped.skipped}.` : '';
  switch (rb.result) {
    case 'match': return { success: true, text: `Set (read back ✓) ${set}` };
    case 'unknown': return { success: true, text: `Set ${set} — the field could not be read back: NOT verified. Read it to check.` };
    case 'suffix': return { success: true, text: `Set ${set} — ${shows}, which may be the value in another format, or with a suggestion or old text after it: NOT verified.` };
    default: return {
      success: false,
      text: rb.value
        ? `Set ${quoteScreenText(label)} failed: ${shows}, not the value asked for (${cut(value)}) — its old text was not replaced, or the field rewrote it.${alsoTyped}`
        : `Set ${quoteScreenText(label)} failed: the field still shows nothing, not the value asked for (${cut(value)}) — the set had no effect.${alsoTyped}`,
    };
  }
}
