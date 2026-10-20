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
