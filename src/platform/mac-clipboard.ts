/**
 * The kinds of data `clipboard info` (macOS) lists that are TEXT: plain text in its encodings, and rich text (RTF, HTML) whose
 * text a restore keeps (its styling it does not). Anything else - an image, a file, a PDF, RTFD with attachments - cannot be
 * saved as the text pbpaste reads, so a paste that overwrites it loses it. dyn.* ids are system-made aliases, not content.
 */
const TEXT_CLIPBOARD_TYPES = new Set(['string', 'text', 'unicodetext', '«classutf8»', '«classut16»', '«classut8»', '«classrtf»', '«classhtml»',
  // The style runs that come with styled plain text (TextEdit): styling, like RTF's, not content.
  'scrapstyles', 'styledclipboardtext', '«classstyl»']);

/**
 * Does the output of osascript -e 'clipboard info' list data that is not text? osascript prints it as a flat list of kind,
 * size ("«class PNGf», 116278, «class utf8», 5, TIFF picture, 4198020"); the braced form ({{string, 5}}) is read too.
 */
export function clipboardInfoHoldsNonText(info: string): boolean {
  const kinds = [...info.replace(/[{}]/g, '').matchAll(/(«[^»]*»|[A-Za-z][A-Za-z .]*?)\s*,\s*\d+/g)]
    .map(m => m[1].replace(/\s+/g, '').toLowerCase());
  return kinds.some(k => !TEXT_CLIPBOARD_TYPES.has(k) && !k.startsWith('«classdyn.'));
}
