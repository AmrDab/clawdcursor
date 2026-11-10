/**
 * Prompt-injection defense: screen content is wrapped in
 * `<untrusted-screen-content>` delimiters so a calling agent can treat
 * anything inside as data, never as instructions.
 *
 * THE one place the delimiter is written. A tool result never builds the tags by hand: text the screen, a page, a
 * document, the clipboard or another app controls goes through one of
 *   - wrapUntrustedScreenContent — free text (page text, OCR, a tree dump, the clipboard, a field's value);
 *   - quoteScreenText (result-codes.ts) — a short name inline (a window title, an element name, a URL);
 *   - screenJson — a JSON result whose strings come from the screen.
 * Each defuses the delimiter inside the text, so content can neither close a block early nor open a fake one.
 */

/** The delimiter as written, and anything a lenient reader could take for it: attributes, `/>`, no closing bracket. */
const DELIMITER = /<\s*(\/?)\s*untrusted-screen-content\s*>/gi;
const NEAR_MISS = /<(\s*\/?\s*untrusted-screen-content)([^>]*>)?/gi;

/**
 * The text with every spelling of the delimiter made inert (‹…›): it stays readable and can pair with nothing. The
 * exact tag keeps its shape; a near miss (`</untrusted-screen-content x>`, `<untrusted-screen-content/>`, a tag with no
 * `>`) loses both brackets, opening and closing tag alike, case-insensitively.
 */
export function defuseScreenDelimiters(text: string): string {
  return text
    .replace(DELIMITER, '‹$1untrusted-screen-content›')
    .replace(NEAR_MISS, (_m, tag: string, rest?: string) => `‹${tag}${rest ? `${rest.slice(0, -1)}›` : ''}`);
}

/**
 * Wrap screen content in explicit delimiters to make prompt-injection defense
 * auditable.
 */
export function wrapUntrustedScreenContent(text: string): string {
  // The content cannot close (or reopen) the block itself: a page or field that contains the delimiter would otherwise
  // end the "untrusted" part early and have what follows read as the tool's own words.
  return `<untrusted-screen-content>\n${defuseScreenDelimiters(String(text ?? ''))}\n</untrusted-screen-content>`;
}

/** JSON for a result whose string values come from the screen: JSON escapes quotes and newlines, this defuses the delimiter. */
export function screenJson(value: unknown, space?: number): string {
  return defuseScreenDelimiters(JSON.stringify(value, null, space) ?? 'null');
}

/**
 * Cut a result to `max` characters without leaving a block open: a cut that removes the closing delimiter would make
 * everything after it (the next step's line in a batch report) read as part of the untrusted block — or, to a reader
 * that gives up on the unclosed tag, make the block's content read as the tool's own words.
 */
export function clipScreenText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max).replace(/<\/?[a-z-]*$/i, '');   // never end inside a tag
  const open = (cut.match(/<untrusted-screen-content>/g) ?? []).length;
  const close = (cut.match(/<\/untrusted-screen-content>/g) ?? []).length;
  return open > close ? `${cut}…\n</untrusted-screen-content>` : cut;
}
