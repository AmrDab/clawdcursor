/**
 * Screen geometry on macOS, read from NSScreen through osascript — the one
 * place that talks to NSScreen.
 *
 * Why list indexing and not `size of frame`: AppleScriptObjC bridges an NSRect
 * as a nested list {{x, y}, {width, height}}, not a record. Both `size of frame`
 * (-1728) and the possessive `frame()'s size's width` (-1700) throw on macOS 26.
 * The error used to be swallowed, so the logical width silently fell back to the
 * physical width, dpiRatio became 1 and every Retina click landed 2× off (#154).
 * `backingScaleFactor` is read alongside so a caller without Screen Recording
 * can still derive physical dimensions.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

export interface MainScreenInfo {
  /** Logical (point) size — the space the mouse driver uses on macOS. */
  logicalWidth: number;
  logicalHeight: number;
  /** Physical pixels per point: 2 on a Retina panel, 1 on a standard display. */
  backingScaleFactor: number;
}

/** Prints "logicalWidth,logicalHeight,backingScaleFactor", e.g. "2240,1260,2.0". */
export const MAIN_SCREEN_SCRIPT = [
  'use framework "AppKit"',
  "set s to current application's NSScreen's mainScreen()",
  "set f to s's frame()",
  "set sc to s's backingScaleFactor()",
  'return ((item 1 of item 2 of f) as integer as text) & "," & ((item 2 of item 2 of f) as integer as text) & "," & (sc as text)',
].join('\n');

type Exec = (cmd: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>;
const defaultExec: Exec = promisify(execFile) as unknown as Exec;
const OSASCRIPT_TIMEOUT_MS = 5_000;

/**
 * Parse "logicalW,logicalH,scale". Tolerates AppleScript's list coercion — `&`
 * between two numbers yields a list that prints as "2240, ,, 1260" — and a
 * missing scale (treated as 1×). Null when there is no usable size.
 */
export function parseMainScreenInfo(stdout: string): MainScreenInfo | null {
  const nums = (stdout.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (nums.length < 2) return null;
  const [logicalWidth, logicalHeight, scale] = nums;
  if (!(logicalWidth > 0) || !(logicalHeight > 0)) return null;
  return {
    logicalWidth: Math.round(logicalWidth),
    logicalHeight: Math.round(logicalHeight),
    backingScaleFactor: scale > 0 ? scale : 1,
  };
}

/** Main screen's logical size and backing scale; null when osascript fails (callers fall back). */
export async function readMainScreenInfo(exec: Exec = defaultExec): Promise<MainScreenInfo | null> {
  try {
    const { stdout } = await exec('osascript', ['-e', MAIN_SCREEN_SCRIPT], { timeout: OSASCRIPT_TIMEOUT_MS });
    return parseMainScreenInfo(String(stdout));
  } catch {
    return null;
  }
}

export interface DisplayRow {
  /** Position in NSScreen.screens — index 0 is the primary (menu-bar) screen. */
  index: number;
  /** Frame in points, as NSScreen reports it (origin bottom-left; negative for a screen left of / below the primary). */
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
  /** Physical pixels per point for THIS screen (mixed-DPI setups differ per screen). */
  backingScaleFactor: number;
}

/**
 * One line per screen: "index|x,y,w,h|primary|backingScaleFactor". NSScreen.screens
 * puts the primary screen at index 0, so no screen comparison is needed — the old
 * `(s as any) = primaryScreen` did not even compile (-2741).
 */
export const LIST_DISPLAYS_SCRIPT = [
  'use framework "AppKit"',
  'set output to ""',
  'set idx to 0',
  "repeat with s in (current application's NSScreen's screens())",
  "  set f to s's frame()",
  '  set isPrimary to (idx = 0)',
  `  set output to output & (idx as text) & "|" & ((item 1 of item 1 of f) as integer as text) & "," & ((item 2 of item 1 of f) as integer as text) & "," & ((item 1 of item 2 of f) as integer as text) & "," & ((item 2 of item 2 of f) as integer as text) & "|" & (isPrimary as text) & "|" & ((s's backingScaleFactor()) as text) & linefeed`,
  '  set idx to idx + 1',
  'end repeat',
  'return output',
].join('\n');

/** Parse LIST_DISPLAYS_SCRIPT output. Lines without a usable size are dropped. */
export function parseDisplayList(stdout: string): DisplayRow[] {
  return stdout.split('\n').map(l => l.trim()).filter(Boolean).flatMap((l, i) => {
    const [idx, bounds, primary, scale] = l.split('|');
    const [x, y, width, height] = (bounds ?? '').split(',').map(v => parseInt(v, 10));
    if (!(width > 0) || !(height > 0)) return [];
    const index = parseInt(idx, 10);
    const sc = parseFloat(scale ?? '');
    return [{
      index: Number.isFinite(index) ? index : i,
      x: x || 0,
      y: y || 0,
      width,
      height,
      primary: (primary ?? '').trim() === 'true',
      backingScaleFactor: sc > 0 ? sc : 1,
    }];
  });
}

/** Every screen, primary first; null when osascript fails or lists nothing (callers fall back to the main screen). */
export async function readDisplayList(exec: Exec = defaultExec): Promise<DisplayRow[] | null> {
  try {
    const { stdout } = await exec('osascript', ['-e', LIST_DISPLAYS_SCRIPT], { timeout: OSASCRIPT_TIMEOUT_MS });
    const rows = parseDisplayList(String(stdout));
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}
