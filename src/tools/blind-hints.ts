/**
 * Shared wording for blind-first perception results, used by both tool
 * surfaces (System A registry tools and the projected agent-loop tools).
 */

/** a11y positions are SCREEN coordinates — clicked as image coords they land
 *  off-target on a scaled display, which made blind reads look unreliable. */
export const SCREEN_COORDS_NOTE = '(positions are screen coordinates — click them with space:"screen", or act by name)';

/** Next step when a blind read comes back thin (MCP agents), instead of a
 *  dead end that leaves screenshots as the only option. */
export const SPARSE_NEXT_STEP =
  '→ Little or no accessibility structure here (common for web pages and canvas apps). Next: ' +
  'copy_all_text for the exact page text · smart_click name:"…" to press a labelled control (OCR fallback) · ' +
  'ocr to read it · screenshot only if those fail. ' +
  'Electron/Chromium app? Restarting it with --force-renderer-accessibility exposes the whole page (required on Linux).';

/** The same advice for clawdcursor's internal agent loop, in its own tool names. */
export const SPARSE_NEXT_STEP_INTERNAL =
  '→ Little or no accessibility structure here (common for web pages and canvas apps). Next: ' +
  'read_text (OCR) to read it · screenshot only if that is not enough.';

/**
 * Next step when the thin read is of the browser clawdcursor is attached to
 * over CDP (#235): its page is readable through the browser tools right now,
 * and restarting clawdcursor's own browser is neither needed nor possible
 * for the agent.
 */
export function cdpBrowserNextStep(mode: 'dedicated' | 'attached'): string {
  return '→ This is the browser clawdcursor is attached to over CDP: read and act on its page with ' +
    'browser {action:"page_context"} (interactive elements) · browser {action:"read_text"} · browser {action:"click"} — ' +
    'they see the whole page, whatever the accessibility tree shows.' +
    (mode === 'dedicated'
      ? " It is clawdcursor's own browser: don't restart it — clawdcursor switches its accessibility on itself."
      : '');
}
