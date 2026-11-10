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
import { quoteScreenText } from '../core/result-codes';

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
  const sleep = (ms: number) => new Promise<null>(r => setTimeout(() => r(null), ms));
  const want = text.replace(/\r\n/g, '\n').trim();
  const t0 = Date.now();
  await sleep(minMs);
  let first: string | undefined;
  let changed = false;
  for (;;) {
    const left = maxMs - (Date.now() - t0);
    if (left <= 0) return;
    let v: string | null | undefined = null;
    try { v = await Promise.race([readFocusedValue(), sleep(left)]); } catch { /* unreadable */ }
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
 * (an address bar), the case where Return would go somewhere else. 'mismatch': it shows other text (the field reformatted
 * it — a phone number, an amount — or the keys went elsewhere). 'unknown': it cannot be told.
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
 *   - the same text is a 'match'; so is an empty field after a clear;
 *   - a NUMBER is compared as a number, against the number the field starts with: "30.0", "30,00" and "30 mm" hold 30
 *     (AT-SPI reads a value back as a float, a field adds decimals or a unit), "300" and "10030" do not — and for a
 *     number "starts with it" proves nothing, so it is never a 'suffix';
 *   - other text with more AFTER it is a 'suffix' (an inline autocomplete suggestion): it cannot be told from a success;
 *   - anything else is a 'mismatch' (old text that was not replaced, a reformat).
 */
function holdsValue(shown: string, want: string): Exclude<ReadBack, 'unknown'> {
  const v = shown.toLowerCase(), w = want.toLowerCase();
  if (v === w) return 'match';
  if (NUMBER.exec(w)?.[0] === w) {
    const n = NUMBER.exec(v)?.[0];
    const same = n !== undefined && !/\d/.test(v.slice(n.length)) && Number(n.replace(',', '.')) === Number(w.replace(',', '.'));
    return same ? 'match' : 'mismatch';
  }
  return w && v.startsWith(w) ? 'suffix' : 'mismatch';
}

/**
 * Read the focused field after typing. 'unknown' when it cannot be told — no focused element, a password field (its
 * value is withheld), a field that exposes no text (empty value: many custom controls), or a value at the read cap.
 * Polls briefly: a field can lag the keys. `value` is what the field showed (for the caller to report). Never throws.
 *
 * `whole`: the field was to be REPLACED, so it must hold the text and nothing else (holdsValue). Only then can an empty
 * text be checked: a field that reads empty was cleared.
 */
export async function readBackTyped(
  focused: () => Promise<{ value?: string; secure?: boolean } | null | undefined>,
  text: string,
  opts: { maxMs?: number; stepMs?: number; submit?: boolean; whole?: boolean } = {},
): Promise<{ result: ReadBack; value?: string; secure?: boolean }> {
  const { maxMs = 300, stepMs = 100, submit = false, whole = false } = opts;
  const want = flat(text);
  if (!want && !whole) return { result: 'unknown' };
  const t0 = Date.now();
  let last: { result: ReadBack; value?: string } = { result: 'unknown' };
  for (;;) {
    let el: { value?: string; secure?: boolean } | null | undefined = null;
    try { el = await focused(); } catch { /* unreadable */ }
    if (el?.secure) return { result: 'unknown', secure: true };
    const readable = typeof el?.value === 'string' && el.value.length < READ_CAP;
    const v = readable ? flat(el!.value!) : '';
    if (v || (readable && !want)) {
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
 * How every set_field_value path ends: one read-back (readBackTyped, whole value) decides the result. A field that holds
 * the value is confirmed; one that shows it with more after it, or cannot be read, is a success said to be NOT verified;
 * any other text is a failure that says what the field shows. Reads `named` (the field a native set wrote to), or
 * without it the focused field (where the value was typed).
 */
export async function setResult(
  platform: Pick<PlatformAdapter, 'getFocusedElement' | 'invokeElement'>, value: string, label: string, how: string,
  named?: { name: string; controlType?: string; processId?: number },
): Promise<{ success: boolean; text: string; targetLabel: string }> {
  const rb = await readBackTyped(async () => {
    if (!named) return platform.getFocusedElement();
    const res = await platform.invokeElement({ ...named, action: 'get-value' });
    const d = res.data as { value?: unknown; method?: unknown } | undefined;
    // A bridge that finds no value answers with the element's NAME (method "Name"): that is not the field's text.
    return res.success && typeof d?.value === 'string' && !/^name$/i.test(String(d.method)) ? { value: d.value } : null;
  }, value, { whole: true });
  const set = `${quoteScreenText(label)} = ${value.length} chars${how}`;
  const cut = (s: string) => quoteScreenText(s.length > 80 ? `${s.slice(0, 79)}…` : s);
  const shows = `the field shows ${cut(rb.value ?? '')}`;
  switch (rb.result) {
    case 'match': return { success: true, text: `Set (read back ✓) ${set}`, targetLabel: label };
    case 'unknown': return { success: true, text: `Set ${set} — the field could not be read back: NOT verified. Read it to check.`, targetLabel: label };
    case 'suffix': return { success: true, text: `Set ${set} — ${shows}, the value with more after it (a suggestion, a unit): NOT verified.`, targetLabel: label };
    default: return { success: false, text: `Set ${quoteScreenText(label)} failed: ${shows}, not the value asked for (${cut(value)}) — its old text was not replaced, or the field rewrote it.`, targetLabel: label };
  }
}
