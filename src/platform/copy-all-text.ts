/**
 * Read ALL text of the focused window. First through accessibility, with no
 * keystrokes, nothing selected and the clipboard untouched: the document's
 * text (Windows: UIA TextPattern), then the names and values in the window's
 * tree. Only a window whose tree cannot be read at all gets select-all, copy,
 * read the clipboard, put the user's clipboard back — and the result says so.
 *
 * Why: OCR garbles identifiers (l→1, o→0) and accessibility trees can be empty
 * or time out on big web apps; the copied text is the page's real characters.
 * A field session reading Stripe got every ID and amount right this way.
 * Why the keys come last: select-all acts on whatever the app selects, not only
 * text (live, Siemens NX: it selected every feature and opened NX's Copy dialog).
 *
 * Refuses in terminals — Ctrl+C there interrupts the running program. A
 * sentinel written before the copy tells "copied nothing" apart from "the
 * page text equals what was already on the clipboard".
 */
import type { PlatformAdapter, UiElement, WindowInfo } from './types';
import { unguarded } from './pointer-guard';

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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
  // Text without marks is returned exactly as read: blank and space-only lines are the document's own (macOS run:
  // TextEdit's three blank lines came back as one).
  if (!text.includes('￼')) return text;
  return text.replace(/\r\n?/g, '\n').replace(/￼/g, '').replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

/** The window's text from its accessibility tree: names (and values) in tree order. Null when the tree could not be read
 *  (no reader, the read failed, or it has no elements); '' when it was read and holds no text. */
async function accessibilityText(platform: CopyPlatform, pid: number | undefined): Promise<string | null> {
  if (!platform.getUiTree) return null;
  const tree = await platform.getUiTree(pid).catch(() => []);
  if (!tree.length) return null;
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
  // First choice: the document's text through accessibility (Windows: UIA TextPattern) — the page or editor text with no
  // keystrokes at all, so nothing is left selected and the clipboard is never touched.
  if (platform.getPageText) {
    const page = await platform.getPageText().catch(() => null);
    const text = page ? withoutObjectMarks(page.text) : '';
    if (text.trim()) return { ok: true, window: label, source: 'document', text };
  }

  // Second choice: the names and values in the window's tree — still no keystrokes. A read must not change the app, and
  // select-all + copy does: it replaces the app's selection and runs the app's own Copy command.
  const treeText = await accessibilityText(platform, win?.processId || undefined);
  if (treeText) {
    return { ok: true, window: label, source: 'accessibility', text: `(${label} has no document text to read; this is its accessibility text: element names and values in tree order, not the exact page text. No keys were pressed.)\n${treeText}` };
  }
  // A tree that was read and holds no text is a drawn view (a canvas, a 3D model): select-all there selects the app's own
  // objects, not text. Keys are for a window whose tree cannot be read at all.
  if (treeText === '') {
    return { ok: false, window: label, text: `Not pressing Ctrl+A in ${label}: its accessibility tree has no text, so its content is drawn rather than text — select-all there would select the app's own objects. Read it with ocr instead.` };
  }

  // Ctrl+A acts on whatever has focus — never on an editor's content or a list of items (#249).
  const focused = platform.getFocusedElement ? await platform.getFocusedElement().catch(() => null) : null;
  const hazard = selectAllHazard(focused, String(win?.processName ?? ''), String(win?.className ?? ''));
  if (hazard) {
    return { ok: false, window: label, text: `Not pressing Ctrl+A in ${label}: ${hazard}. Its accessibility tree could not be read either — read it with ocr instead.` };
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
    await unguarded(() => platform.writeClipboard(prior)).catch(() => { /* best effort */ });
  }

  const pressed = `Pressed Ctrl+A and Ctrl+C in ${label} (its accessibility tree could not be read)`;
  if (!copied || copied === sentinel) {
    return { ok: false, window: label, pressedKeys: true, text: `${pressed} and nothing was copied: no selectable text, or the app blocks select-all / copy. The keys may have changed what is selected there or opened a dialog — check the window before acting. Read it with ocr instead.` };
  }
  return { ok: true, window: label, source: 'clipboard', text: copied, pressedKeys: true,
    note: `${pressed}: its content is now selected (select-all). Click a neutral spot before typing in this window — typed text would replace the selection.` };
}
