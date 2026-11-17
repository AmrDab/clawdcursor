/**
 * The kinds of data `clipboard info` (macOS) lists that are TEXT: plain text in its encodings, and rich text (RTF, HTML) whose
 * text a restore keeps (its styling it does not). Anything else - an image, a file, a PDF, RTFD with attachments - cannot be
 * saved as the text pbpaste reads, so a paste that overwrites it loses it. dyn.* ids are system-made aliases, not content.
 */
const TEXT_CLIPBOARD_TYPES = new Set(['string', 'text', 'unicodetext', '«classutf8»', '«classut16»', '«classut8»', '«classrtf»', '«classhtml»']);

/** Does the output of osascript -e 'clipboard info' ("{{string, 5}, {«class PNGf», 912}}") list data that is not text? */
export function clipboardInfoHoldsNonText(info: string): boolean {
  const kinds = [...info.matchAll(/\{\s*(«[^»]*»|[^,{}«]+?)\s*,\s*\d+\s*\}/g)].map(m => m[1].replace(/\s+/g, '').toLowerCase());
  return kinds.some(k => !TEXT_CLIPBOARD_TYPES.has(k) && !k.startsWith('«classdyn.'));
}
