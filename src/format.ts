/**
 * Terminal formatting utilities.
 *
 * Emoji gate: Windows terminals not in UTF-8 mode render emoji as garbled characters.
 * Detects capable terminals and provides ASCII fallbacks.
 */

/** Whether the current terminal can render emoji safely */
export const canEmoji = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.platform !== 'win32') return true;
  // Windows Terminal sets WT_SESSION
  if (process.env.WT_SESSION) return true;
  // VS Code integrated terminal
  if (process.env.TERM_PROGRAM === 'vscode') return true;
  // Check if console codepage is UTF-8
  try {
    const { execSync } = require('child_process');
    const cp = execSync('chcp', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return cp.includes('65001');
  } catch {
    return false;
  }
})();

/** Emoji with ASCII fallback for non-capable terminals */
export function e(emoji: string, fallback: string): string {
  return canEmoji ? emoji : fallback;
}
