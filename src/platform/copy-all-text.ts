/**
 * Read ALL text of the focused window through accessibility, with no keystrokes, nothing selected and the clipboard
 * untouched: the document's text (Windows: UIA TextPattern; macOS: AX, text markers for a web page). Where there is no
 * document text, the names and values in the window's tree, labelled as names only.
 *
 * Why: OCR garbles identifiers (l→1, o→0) and accessibility trees can be empty or time out on big web apps; the
 * document's text is the page's real characters. A field session reading Stripe got every ID and amount right.
 * Why never select-all + copy (it was the fallback for a browser page): the whole page turned blue on screen, which looked
 * broken to the person watching (owner, 2026-11-15), and select-all acts on whatever the app selects (Siemens NX: every
 * feature, then NX's own Copy dialog).
 *
 * Refuses in terminals.
 */
import type { PlatformAdapter, WindowInfo } from './types';
import { quoteScreenText } from '../core/untrusted-screen-content';

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

/** `source` says where the text came from: the document (exact text) or the accessibility tree (element names and values). */
export interface CopyAllTextResult { ok: boolean; text: string; window?: string; source?: 'document' | 'accessibility' }

/** Browsers: a page's document can come back empty the first time (Chromium turns its accessibility on when first asked). */
const BROWSERS = /^(msedge|chrome|chromium(-browser)?|firefox(-esr|-bin)?|brave|opera|vivaldi|arc|safari|google chrome|google-chrome(-stable)?|microsoft edge|zen|librewolf|waterfox)(\.exe)?$/i;
/** How long a browser gets before its document is read a second time. */
const BROWSER_RETRY_MS = 400;

type CopyPlatform = Pick<PlatformAdapter, 'getActiveWindow'> & Partial<Pick<PlatformAdapter, 'getUiTree' | 'getPageText' | 'lastTreeTruncated'>>;

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

async function documentText(platform: CopyPlatform): Promise<string> {
  if (!platform.getPageText) return '';
  const page = await platform.getPageText().catch(() => null);
  return page ? withoutObjectMarks(page.text) : '';
}

export async function copyAllText(platform: CopyPlatform): Promise<CopyAllTextResult> {
  const win = await platform.getActiveWindow().catch(() => null);
  // The title is the page's to choose and the process name the app's: quoted, so neither can end its quotes or pose as
  // part of the result.
  const label = win ? `[${quoteScreenText(String(win.processName ?? ''))}] ${quoteScreenText(String(win.title ?? ''))}` : 'the focused window';
  if (isTerminalWindow(win)) {
    return { ok: false, window: label, text: `Refused: ${label} is a terminal — Ctrl+C there interrupts the running program. Read it with ocr or accessibility instead.` };
  }
  let text = await documentText(platform);
  if (!text.trim() && BROWSERS.test(String(win?.processName ?? '').trim())) {
    await new Promise(r => setTimeout(r, BROWSER_RETRY_MS));
    text = await documentText(platform);
  }
  if (text.trim()) return { ok: true, window: label, source: 'document', text };

  // No document text: the names and values in the window's tree, labelled as what they are. No key is ever pressed.
  const treeText = await accessibilityText(platform, win?.processId || undefined);
  if (!treeText) {
    return { ok: false, window: label, text: `Could not read text from ${label}: it has no document text, and its accessibility tree gave none (it is empty, or the read failed). No keys were pressed. Read it with ocr instead.` };
  }
  const partial = platform.lastTreeTruncated ? ' — PARTIAL (the walk stopped at its size or time limit)' : '';
  return { ok: true, window: label, source: 'accessibility',
    text: `(names only, not the document's text: the element names and values in the accessibility tree of ${label}${partial}. No keys were pressed. Use ocr for the content.)\n${treeText}` };
}
