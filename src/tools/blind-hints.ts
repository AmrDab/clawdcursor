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
