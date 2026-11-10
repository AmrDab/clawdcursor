/**
 * Find & Replace playbook.
 *
 * Ported from src/deterministic-flows.ts. The choreography:
 *   mod+h → type find → Tab → type replace → alt+a (replace all) → Escape.
 *
 * Most text editors (Word, VSCode, Notepad++ on Windows; mac equivalents)
 * expose this same shape. The `mod+h` shortcut is the cross-platform primary.
 */

import type { PlaybookArgs, PlaybookResult } from './index';

export async function findReplace(args: PlaybookArgs): Promise<PlaybookResult> {
  const { adapter, input } = args;
  const findText    = input.find ?? input.findText ?? '';
  const replaceText = input.replace ?? input.replaceText ?? '';
  const steps: PlaybookResult['steps'] = [];

  if (!findText) {
    return {
      success: false,
      text: 'find-replace: no `find` text provided',
      steps,
    };
  }

  // Windows / Linux editors only: mod+h opens Find & Replace there, and Alt+A is their Replace All accelerator. On
  // macOS mod+h is Cmd+H, which HIDES the app, and there is no common chord for the panel.
  if (adapter.platform === 'darwin') {
    return { success: false, text: 'find-replace: no common Find & Replace shortcut on macOS — use the app\'s Edit ▸ Find menu', steps };
  }

  // 1) Open the Find & Replace panel.
  await adapter.keyPress('mod+h');
  steps.push({ type: 'key', key: 'mod+h', description: 'open find & replace' });
  await sleep(300);

  // 2) Type the find term (panel focuses its Find field by default).
  await adapter.typeText(findText);
  steps.push({ type: 'type', description: `typed find: ${findText}` });

  // 3) Tab to the Replace field, type replacement.
  await adapter.keyPress('Tab');
  steps.push({ type: 'key', key: 'Tab', description: 'advance to Replace' });
  if (replaceText) {
    await adapter.typeText(replaceText);
    steps.push({ type: 'type', description: `typed replace: ${replaceText}` });
  }

  // 4) Alt+A (Replace All on most editors). Some editors use Enter or a button;
  // the verifier will catch if this missed.
  await adapter.keyPress('alt+a');
  steps.push({ type: 'key', key: 'alt+a', description: 'replace all' });
  await sleep(300);

  // 5) Dismiss the panel.
  await adapter.keyPress('Escape');
  steps.push({ type: 'key', key: 'Escape', description: 'close panel' });

  return {
    success: true,
    text: `find-replace: "${findText}" → "${replaceText}"`,
    steps,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
