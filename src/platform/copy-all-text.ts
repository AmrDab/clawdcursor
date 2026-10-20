/**
 * Read ALL text of the focused window exactly. First through accessibility
 * (Windows: the document's UIA TextPattern — no keystrokes, nothing selected,
 * clipboard untouched); where that can't be read: select-all, copy, read the
 * clipboard, put the user's clipboard back.
 *
 * Why: OCR garbles identifiers (l→1, o→0) and accessibility trees can be empty
 * or time out on big web apps; the copied text is the page's real characters.
 * A field session reading Stripe got every ID and amount right this way.
 *
 * Refuses in terminals — Ctrl+C there interrupts the running program. A
 * sentinel written before the copy tells "copied nothing" apart from "the
 * page text equals what was already on the clipboard".
 */
import type { PlatformAdapter, UiElement, WindowInfo } from './types';

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

/** `source` says where the text came from: the clipboard (exact page text) or
 *  the accessibility tree (element names and values, when select-all/copy can't work).
 *  `note`: something the agent must know about the state the read left behind. */
export interface CopyAllTextResult { ok: boolean; text: string; window?: string; source?: 'document' | 'clipboard' | 'accessibility'; note?: string }

/** Browsers: a focused "document" there is the page, not an editor. */
const BROWSERS = /^(msedge|chrome|chromium|firefox|brave|opera|vivaldi|arc|safari|google chrome|microsoft edge|zen|librewolf|waterfox)(\.exe)?$/i;
/** Roles whose content select-all would select — the next keystroke then replaces it. */
const EDITABLE_ROLE = /edit|entry|textfield|textarea|text field|text area|password|combo|spin/i;
/** Roles where select-all selects every item — a following Delete acts on all of them. */
const ITEM_ROLE = /list|tree|table|grid|dataitem|cell|row/i;

/**
 * Why Ctrl+A must not be pressed with this element focused, or null when it is safe (#249). Ctrl+A acts on whatever has focus:
 * in an editor it selects the whole document and the agent's next keystroke replaces it; in a mail list or a file view it selects
 * every item. Unknown focus is not a hazard: page text is what this tool is for.
 */
export function selectAllHazard(
  focused: Pick<UiElement, 'controlType' | 'name'> | null | undefined,
  processName: string,
  className = '',
): string | null {
  const role = String(focused?.controlType ?? '').replace(/^ControlType\./, '');
  // An Electron app (a Chromium window that is not a browser) without renderer accessibility reports its focus as a bare
  // Pane, whether that is a list or the message box / the editor holding the user's draft. It cannot be told apart, so it is
  // not selected (live: the Claude desktop app's prompt read as "Pane").
  if (/^Chrome_WidgetWin/.test(className) && !BROWSERS.test(processName.trim()) && (!role || /^(pane|window|group|custom)$/i.test(role))) {
    return `${processName} is an Electron app that does not say what has focus (it reports "${role || 'nothing'}") — it may be a text box holding a draft`;
  }
  if (!focused) return null;
  const name = String(focused.name ?? '').trim();
  const what = name ? `${role} "${name.length > 40 ? name.slice(0, 39) + '…' : name}"` : role;
  if (EDITABLE_ROLE.test(role)) return `focus is in an editable field (${what}) — select-all would select its content, and the next keystroke would replace it`;
  if (/document/i.test(role) && !BROWSERS.test(processName.trim())) return `focus is in a document (${what}) — in an editor, select-all would select all of it, and the next keystroke would replace it`;
  if (ITEM_ROLE.test(role)) return `focus is on ${what} — select-all there selects every item, and a following Delete would act on all of them`;
  return null;
}

/** Said after a select-all copy: the selection stays, so typing next would replace it. */
export const SELECTION_LEFT_NOTE = 'The window\'s content is now selected (select-all). Click a neutral spot before typing in this window — typed text would replace the selection.';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** UWP / XAML app frames (Settings, Store apps): no select-all, so Ctrl+A/C copies nothing. */
const XAML_WINDOW_CLASSES = /^(ApplicationFrameWindow|Windows\.UI\.Core\.CoreWindow)$/;
/** Wall-clock budget for the copy to reach the clipboard. Each read can be a
 *  process spawn (~0.5 s on Windows), so polls are bounded by time, not count. */
const CLIPBOARD_WAIT_MS = 1500;

type CopyPlatform = Pick<PlatformAdapter, 'getActiveWindow' | 'keyPress' | 'readClipboard' | 'writeClipboard'>
  & Partial<Pick<PlatformAdapter, 'getUiTree' | 'getFocusedElement' | 'getPageText'>>;

/**
 * Drop U+FFFC, the mark a document's text uses where an embedded object (an image, a link, a frame) sits. UIA TextPattern
 * returns it as-is, so a Windows page read came back with lines of nothing but marks; AT-SPI text is expanded already.
 */
export function withoutObjectMarks(text: string): string {
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
  const label = win ? `[${win.processName}] "${win.title}"` : 'the focused window';
  if (isTerminalWindow(win)) {
    return { ok: false, window: label, text: `Refused: ${label} is a terminal — Ctrl+C there interrupts the running program. Read it with ocr or accessibility instead.` };
  }
  const fromTree = async (why: string): Promise<CopyAllTextResult | null> => {
    const text = await accessibilityText(platform, win?.processId || undefined);
    return text ? { ok: true, window: label, source: 'accessibility', text: `${why}\n${text}` } : null;
  };
  // Live 2026-10-15: Settings (XAML) took 13.4 s to copy nothing. Don't try.
  if (XAML_WINDOW_CLASSES.test(String(win?.className ?? ''))) {
    const r = await fromTree(`(${label} is a UWP/XAML window with no select-all — this is its accessibility text: element names and values in tree order, not the exact page text)`);
    if (r) return r;
  }

  // First choice: the document's text through accessibility (Windows: UIA TextPattern) — the page or editor text with no
  // keystrokes at all, so nothing is left selected and the clipboard is never touched.
  if (platform.getPageText) {
    const page = await platform.getPageText().catch(() => null);
    const text = page ? withoutObjectMarks(page.text) : '';
    if (text.trim()) return { ok: true, window: label, source: 'document', text };
  }

  // Ctrl+A acts on whatever has focus — never on an editor's content or a list of items (#249).
  const focused = platform.getFocusedElement ? await platform.getFocusedElement().catch(() => null) : null;
  const hazard = selectAllHazard(focused, String(win?.processName ?? ''), String(win?.className ?? ''));
  if (hazard) {
    const r = await fromTree(`(not pressing Ctrl+A: ${hazard}. This is the window's accessibility text instead: element names and values, not the exact page text. To copy a web page exactly, click its content first, then retry.)`);
    if (r) return r;
    return { ok: false, window: label, text: `Not pressing Ctrl+A in ${label}: ${hazard}. Its accessibility tree had no text either — read it with ocr instead.` };
  }

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
    await platform.writeClipboard(prior).catch(() => { /* best effort */ });
  }

  if (!copied || copied === sentinel) {
    const r = await fromTree(`(nothing was copied from ${label} — no selectable text, or the app blocks select-all / copy; this is its accessibility text instead: element names and values, not the exact page text)`);
    if (r) return r;
    return { ok: false, window: label, text: `Nothing was copied from ${label} (no selectable text, or the app blocks select-all / copy).` };
  }
  return { ok: true, window: label, source: 'clipboard', text: copied, note: SELECTION_LEFT_NOTE };
}
