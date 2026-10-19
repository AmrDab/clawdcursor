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
