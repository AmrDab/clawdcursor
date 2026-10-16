/**
 * Read ALL text of the focused window exactly: select-all, copy, read the
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
import type { PlatformAdapter, WindowInfo } from './types';

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
 *  the accessibility tree (element names and values, when select-all/copy can't work). */
export interface CopyAllTextResult { ok: boolean; text: string; window?: string; source?: 'clipboard' | 'accessibility' }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** UWP / XAML app frames (Settings, Store apps): no select-all, so Ctrl+A/C copies nothing. */
const XAML_WINDOW_CLASSES = /^(ApplicationFrameWindow|Windows\.UI\.Core\.CoreWindow)$/;
/** Wall-clock budget for the copy to reach the clipboard. Each read can be a
 *  process spawn (~0.5 s on Windows), so polls are bounded by time, not count. */
const CLIPBOARD_WAIT_MS = 1500;

type CopyPlatform = Pick<PlatformAdapter, 'getActiveWindow' | 'keyPress' | 'readClipboard' | 'writeClipboard'>
  & Partial<Pick<PlatformAdapter, 'getUiTree'>>;

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
  return { ok: true, window: label, source: 'clipboard', text: copied };
}
