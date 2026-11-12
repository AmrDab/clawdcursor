/**
 * Read ALL text of the focused window. First through accessibility, with no
 * keystrokes, nothing selected and the clipboard untouched: the document's
 * text (Windows: UIA TextPattern). Where that can't be read, a browser page
 * gets select-all, copy, read the clipboard, put the user's clipboard back —
 * and the result says so. Any other window gets no keys: the names and values
 * in its tree, labelled as names only.
 *
 * Why: OCR garbles identifiers (l→1, o→0) and accessibility trees can be empty
 * or time out on big web apps; the copied text is the page's real characters.
 * A field session reading Stripe got every ID and amount right this way.
 * Why keys only in a browser: elsewhere select-all acts on whatever the app
 * selects (live, Siemens NX: every feature, then NX's own Copy dialog opened).
 *
 * Refuses in terminals — Ctrl+C there interrupts the running program. A
 * sentinel written before the copy tells "copied nothing" apart from "the
 * page text equals what was already on the clipboard".
 */
import type { PlatformAdapter, UiElement, WindowInfo } from './types';
import { unguarded } from './pointer-guard';
import { quoteScreenText } from '../core/result-codes';

const TERMINALS = /^(windowsterminal|wt|cmd|powershell|pwsh|conhost|openconsole|terminal|iterm2?|gnome-terminal(-server)?|konsole|xterm|uxterm|alacritty|kitty|wezterm(-gui)?|tilix|xfce4-terminal|terminator|lxterminal|mate-terminal|hyper|warp|tabby|foot|ghostty)(\.exe)?$/i;

/** Window classes that ARE terminals (Windows: classic console, Windows Terminal). */
const TERMINAL_CLASSES = /^(ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS|PseudoConsoleWindow|mintty|VirtualConsoleClass)$/i;
/** Shell processes that may also own ordinary GUI windows (a WinForms form, an editor). */
const SHELLS = /^(cmd|powershell|pwsh|wt)(\.exe)?$/i;

export function isTerminalWindow(win: Pick<WindowInfo, 'processName' | 'className'> | null | undefined): boolean {
  if (!win) return false;
  const proc = String(win.processName ?? '').trim();
  const cls = String(win.className ?? '').trim();
  if (cls) {
    if (TERMINAL_CLASSES.test(cls)) return true;
    // A GUI window (known class) owned by a shell is not a terminal.
    if (SHELLS.test(proc)) return false;
  }
  return TERMINALS.test(proc);
}

/** `source` says where the text came from: the document or the clipboard (exact text) or
 *  the accessibility tree (element names and values).
 *  `note`: something the agent must know about the state the read left behind.
 *  `pressedKeys`: select-all + copy were sent to the app, so this was input, not only a read. */
export interface CopyAllTextResult { ok: boolean; text: string; window?: string; source?: 'document' | 'clipboard' | 'accessibility'; note?: string; pressedKeys?: boolean }

/** Browsers: select-all there means the page's text. Linux names included (firefox-esr, chromium-browser, google-chrome-stable). */
const BROWSERS = /^(msedge|chrome|chromium(-browser)?|firefox(-esr|-bin)?|brave|opera|vivaldi|arc|safari|google chrome|google-chrome(-stable)?|microsoft edge|zen|librewolf|waterfox)(\.exe)?$/i;
/** Roles whose content select-all would select — the next keystroke then replaces it. */
const EDITABLE_ROLE = /edit|entry|textfield|textarea|text field|text area|password|combo|spin/i;
/** Roles where select-all selects every item — a following Delete acts on all of them. */
const ITEM_ROLE = /list|tree|table|grid|dataitem|cell|row/i;

/**
 * Why Ctrl+A must not be pressed in a browser with this element focused, or null when it is safe (#249). Ctrl+A acts on
 * whatever has focus: in a field it selects the content and the agent's next keystroke replaces it; in a list it selects
 * every item. Unknown focus is not a hazard: page text is what this tool is for.
 */
export function selectAllHazard(focused: Pick<UiElement, 'controlType' | 'name'> | null | undefined): string | null {
  if (!focused) return null;
  const role = String(focused.controlType ?? '').replace(/^ControlType\./, '');
  const name = String(focused.name ?? '').trim();
  const what = name ? `${role} "${name.length > 40 ? name.slice(0, 39) + '…' : name}"` : role;
  if (EDITABLE_ROLE.test(role)) return `focus is in an editable field (${what}) — select-all would select its content, and the next keystroke would replace it`;
  if (ITEM_ROLE.test(role)) return `focus is on ${what} — select-all there selects every item, and a following Delete would act on all of them`;
  return null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Wall-clock budget for the copy to reach the clipboard. Each read can be a
 *  process spawn (~0.5 s on Windows), so polls are bounded by time, not count. */
const CLIPBOARD_WAIT_MS = 1500;

type CopyPlatform = Pick<PlatformAdapter, 'getActiveWindow' | 'keyPress' | 'readClipboard' | 'writeClipboard'>
  & Partial<Pick<PlatformAdapter, 'getUiTree' | 'getFocusedElement' | 'getPageText' | 'lastTreeTruncated'>>;

/**
 * Drop U+FFFC, the mark a document's text uses where an embedded object (an image, a link, a frame) sits. UIA TextPattern
 * returns it as-is, so a Windows page read came back with lines of nothing but marks; AT-SPI text is expanded already.
 */
export function withoutObjectMarks(text: string): string {
  // Text without marks is returned exactly as read: blank and space-only lines are the document's own (macOS run:
  // TextEdit's three blank lines came back as one).
  if (!text.includes('￼')) return text;
  return text.replace(/\r\n?/g, '\n').replace(/￼/g, '').replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

/** The window's text from its accessibility tree: names (and values) in tree order. */
async function accessibilityText(platform: CopyPlatform, pid: number | undefined): Promise<string> {
  if (!platform.getUiTree) return '';
  const tree = await platform.getUiTree(pid).catch(() => []);
  const lines: string[] = [];
  for (const el of tree) {
    const name = (el.name ?? '').trim();
    const value = (el.value ?? '').trim();
    const line = name && value && value !== name ? `${name}: ${value}` : name || value;
    if (line && lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines.join('\n');
}

export async function copyAllText(platform: CopyPlatform): Promise<CopyAllTextResult> {
  const win = await platform.getActiveWindow().catch(() => null);
  // The title is the page's to choose and the process name the app's: quoted, so neither can end its quotes or pose as
  // part of the result.
  const label = win ? `[${quoteScreenText(String(win.processName ?? ''))}] ${quoteScreenText(String(win.title ?? ''))}` : 'the focused window';
  if (isTerminalWindow(win)) {
    return { ok: false, window: label, text: `Refused: ${label} is a terminal — Ctrl+C there interrupts the running program. Read it with ocr or accessibility instead.` };
  }
  // First choice: the document's text through accessibility (Windows: UIA TextPattern) — the page or editor text with no
  // keystrokes at all, so nothing is left selected and the clipboard is never touched.
  if (platform.getPageText) {
    const page = await platform.getPageText().catch(() => null);
    const text = page ? withoutObjectMarks(page.text) : '';
    if (text.trim()) return { ok: true, window: label, source: 'document', text };
  }

  // THE rule for keys: select-all + copy is pressed only where select-all is known to mean "the text" — a browser, with focus
  // not in a field or a list (#249). Anywhere else it acts on whatever the app selects (NX: every feature), so no key is
  // pressed there, whether the tree read worked, came back empty or failed.
  const processName = String(win?.processName ?? '').trim();
  let hazard: string | null = null;
  if (BROWSERS.test(processName)) {
    const focused = platform.getFocusedElement ? await platform.getFocusedElement().catch(() => null) : null;
    hazard = selectAllHazard(focused);
    if (!hazard) return copyWithKeys(platform, label);
  }

  // No keys: the names and values in the window's tree, labelled as what they are.
  const why = hazard ? ` (${hazard}; to copy a web page exactly, click its content first, then retry)` : '';
  const treeText = await accessibilityText(platform, win?.processId || undefined);
  if (!treeText) {
    return { ok: false, window: label, text: `Could not read text from ${label}: it has no document text, and its accessibility tree gave none (it is empty, or the read failed). No keys were pressed${why}. Read it with ocr instead.` };
  }
  const partial = platform.lastTreeTruncated ? ' — PARTIAL (the walk stopped at its size or time limit)' : '';
  return { ok: true, window: label, source: 'accessibility',
    text: `(names only, not the document's text: the element names and values in the accessibility tree of ${label}${partial}. No keys were pressed${why}. Use ocr for the content.)\n${treeText}` };
}

/** Select-all, copy, read the clipboard, put the user's clipboard back. The result says the keys were pressed. */
async function copyWithKeys(platform: CopyPlatform, label: string): Promise<CopyAllTextResult> {

  const prior = await platform.readClipboard().catch(() => '');
  const sentinel = `⁣clawdcursor-copy-${Date.now()}`;
  let copied: string;
  try {
    await platform.writeClipboard(sentinel);
    await platform.keyPress('mod+a');
    await sleep(120);
    await platform.keyPress('mod+c');
    // Big pages take a moment to reach the clipboard.
    const deadline = Date.now() + CLIPBOARD_WAIT_MS;
    do {
      await sleep(100);
      copied = await platform.readClipboard().catch(() => sentinel);
    } while (copied === sentinel && Date.now() < deadline);
  } finally {
    await unguarded(() => platform.writeClipboard(prior)).catch(() => { /* best effort */ });
  }

  const mod = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
  const pressed = `Pressed ${mod}+A and ${mod}+C in ${label} (its document text could not be read through accessibility)`;
  if (!copied || copied === sentinel) {
    return { ok: false, window: label, pressedKeys: true, text: `${pressed} and nothing was copied: no selectable text, or the app blocks select-all / copy. The keys may have changed what is selected there or opened a dialog — check the window before acting. Read it with ocr instead.` };
  }
  return { ok: true, window: label, source: 'clipboard', text: copied, pressedKeys: true,
    note: `${pressed}: its content is now selected (select-all). Click a neutral spot before typing in this window — typed text would replace the selection.` };
}

/**
 * The most characters copy_all_text returns in one result. A host may keep a large tool result out of the conversation:
 * Claude Code saved the 52,715-char web-long-read page to a file and showed a 2 KB preview, so the table in the middle
 * of the page was never seen (#384). 20,000 chars is about 5-10k tokens: inline in every host, well under Claude Code's
 * 25k-token MCP limit, and still a whole article or form in one call.
 */
export const PAGE_TEXT_CAP = 20_000;
/** find: lines shown before and after a matching line, so a table row's other cells show whether they share its line
 *  (copied text: cells tab-separated) or come one per line (document text). */
const FIND_CONTEXT = 2;
const FIND_MAX_MATCHES = 20;
/** find: a longer line (a paragraph, a page with no line breaks) is shown as this many chars, around the match. */
const FIND_LINE_CHARS = 200;

/** One result's worth of a page text: `head` (says what part this is), `body` (page text, for the untrusted wrapper),
 *  `tail` (how to get the rest). */
export interface PageTextPart { head: string; body: string; tail: string; isError?: boolean }

function clipLine(line: string, needle: string): string {
  if (line.length <= FIND_LINE_CHARS) return line;
  const at = Math.max(0, line.toLowerCase().indexOf(needle));
  const start = Math.max(0, at - 80);
  const end = start + FIND_LINE_CHARS;
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

/** What of `text` (read from `from`) one copy_all_text result shows: the lines containing `find`, or up to
 *  PAGE_TEXT_CAP chars from `offset`. */
export function pageTextPart(text: string, from: string, opts: { find?: unknown; offset?: unknown } = {}): PageTextPart {
  const total = text.length;
  const find = typeof opts.find === 'string' ? opts.find.trim() : '';
  if (find) {
    const needle = find.toLowerCase();
    const lines = text.split(/\r?\n/);
    const hits = lines.flatMap((line, i) => (line.toLowerCase().includes(needle) ? [i] : []));
    const what = JSON.stringify(find);
    if (!hits.length) return { head: `No line of the ${total} chars from ${from} contains ${what}.`, body: '', tail: '' };
    const shown = hits.slice(0, FIND_MAX_MATCHES);
    const keep = new Set<number>();
    for (const i of shown) {
      for (let j = Math.max(0, i - FIND_CONTEXT); j <= Math.min(lines.length - 1, i + FIND_CONTEXT); j++) keep.add(j);
    }
    const out: string[] = [];
    let prev = -1;
    for (const j of [...keep].sort((a, b) => a - b)) {
      if (prev >= 0 && j > prev + 1) out.push('…');
      out.push(clipLine(lines[j], needle));
      prev = j;
    }
    const count = hits.length === 1 ? '1 line' : `${hits.length} lines`;
    const first = hits.length > shown.length ? ` (showing the first ${shown.length}: make find more specific for the rest)` : '';
    return { head: `${count} of the ${total} chars from ${from} contain${hits.length === 1 ? 's' : ''} ${what}${first}, with ${FIND_CONTEXT} lines around each:`, body: out.join('\n'), tail: '' };
  }
  const offset = typeof opts.offset === 'number' && opts.offset > 0 ? Math.floor(opts.offset) : 0;
  if (offset === 0 && total <= PAGE_TEXT_CAP) return { head: `${total} chars from ${from}:`, body: text, tail: '' };
  if (offset >= total) return { head: `offset ${offset} is past the end: the text of ${from} has ${total} chars.`, body: '', tail: '', isError: true };
  let end = Math.min(total, offset + PAGE_TEXT_CAP);
  // End at a line break in the last half of the part, so a table row is not split between two results.
  if (end < total) {
    const nl = text.lastIndexOf('\n', end - 1);
    if (nl >= offset + PAGE_TEXT_CAP / 2) end = nl + 1;
  }
  const tail = end < total
    ? `\nCut: one result holds at most ${PAGE_TEXT_CAP} chars, and the text runs to ${total}. Next part: copy_all_text with offset:${end}. ` +
      'For one value, copy_all_text with find:"<text>" returns only the lines that contain it.'
    : '';
  return { head: `${total} chars from ${from}, showing chars ${offset}-${end}:`, body: text.slice(offset, end), tail };
}
