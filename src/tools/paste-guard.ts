/**
 * Paste-as-type is only safe when the clipboard really holds what we meant to type.
 *
 * A clipboard write can fail silently — on Windows it is `Set-Clipboard` in a fresh PowerShell with a 2 s budget, and a
 * timeout or error was swallowed — and the Ctrl+V that followed then pasted the USER'S clipboard into the focused field.
 * Seen live (2026-10-19): typing a URL + Enter into Edge's address bar submitted the user's own clipboard contents as a
 * web search, twice. Every paste path checks the clipboard first and types the text instead when it does not hold it.
 */

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

export type ReadBack = 'match' | 'mismatch' | 'unknown';

/** What a field's text looks like for comparison: line breaks and runs of spaces as one space. */
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Read the focused field after typing: does it show the text? 'unknown' when it cannot be told — no focused element,
 * a password field (its value is withheld), or a field that exposes no text (empty value: many custom controls). A
 * field that shows other text is a 'mismatch': autocomplete replaced it, the field reformatted it, or the keys went
 * elsewhere. Polls briefly: a field can lag the keys. Never throws.
 */
export async function readBackTyped(
  focused: () => Promise<{ value?: string; secure?: boolean } | null | undefined>,
  text: string,
  opts: { maxMs?: number; stepMs?: number; submit?: boolean } = {},
): Promise<ReadBack> {
  const { maxMs = 500, stepMs = 100, submit = false } = opts;
  const want = flat(text);
  if (!want) return 'unknown';
  const t0 = Date.now();
  let last: ReadBack = 'unknown';
  for (;;) {
    let el: { value?: string; secure?: boolean } | null | undefined = null;
    try { el = await focused(); } catch { /* unreadable */ }
    const v = el && !el.secure && typeof el.value === 'string' ? flat(el.value) : '';
    if (v) {
      // Before a submit the field must END with the text: an inline autocomplete leaves its suggestion after it
      // (an address bar), and Return would go there. Otherwise the text anywhere in the field will do.
      if (submit ? v.endsWith(want) : v.includes(want)) return 'match';
      last = 'mismatch';
    }
    if (Date.now() - t0 >= maxMs) return last;
    await new Promise(r => setTimeout(r, stepMs));
  }
}
