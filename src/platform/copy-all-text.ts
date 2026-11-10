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
  // The title is the page's to choose: quoted, so it cannot end its quotes or pose as part of the result.
  const label = win ? `[${win.processName}] ${quoteScreenText(String(win.title ?? ''))}` : 'the focused window';
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
