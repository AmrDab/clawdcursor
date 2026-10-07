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

export function isTerminalWindow(win: Pick<WindowInfo, 'processName'> | null | undefined): boolean {
  return !!win && TERMINALS.test(String(win.processName ?? '').trim());
}

export interface CopyAllTextResult { ok: boolean; text: string; window?: string }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function copyAllText(
  platform: Pick<PlatformAdapter, 'getActiveWindow' | 'keyPress' | 'readClipboard' | 'writeClipboard'>,
): Promise<CopyAllTextResult> {
  const win = await platform.getActiveWindow().catch(() => null);
  const label = win ? `[${win.processName}] "${win.title}"` : 'the focused window';
  if (isTerminalWindow(win)) {
    return { ok: false, window: label, text: `Refused: ${label} is a terminal — Ctrl+C there interrupts the running program. Read it with ocr or accessibility instead.` };
  }

  const prior = await platform.readClipboard().catch(() => '');
  const sentinel = `⁣clawdcursor-copy-${Date.now()}`;
  let copied = '';
  try {
    await platform.writeClipboard(sentinel);
    await platform.keyPress('mod+a');
    await sleep(120);
    await platform.keyPress('mod+c');
    // Big pages take a moment to reach the clipboard.
    for (let i = 0; i < 15; i++) {
      await sleep(100);
      copied = await platform.readClipboard().catch(() => sentinel);
      if (copied !== sentinel) break;
    }
  } finally {
    await platform.writeClipboard(prior).catch(() => { /* best effort */ });
  }

  if (!copied || copied === sentinel) {
    return { ok: false, window: label, text: `Nothing was copied from ${label} (no selectable text, or the app blocks select-all / copy).` };
  }
  return { ok: true, window: label, text: copied };
}
