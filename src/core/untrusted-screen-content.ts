/**
 * Prompt-injection defense: screen content is wrapped in
 * `<untrusted-screen-content>` delimiters so a calling agent can treat
 * anything inside as data, never as instructions.
 *
 * THE one place the delimiter is written. A tool result never builds the tags by hand: text the screen, a page, a
 * document, the clipboard or another app controls goes through one of
 *   - wrapUntrustedScreenContent — free text (page text, OCR, a tree dump, the clipboard, a field's value);
 *   - quoteScreenText — a short name inline (a window title, an element name, a URL);
 *   - screenJson — a JSON result whose strings come from the screen.
 * Each defuses the delimiter inside the text, so content can neither close a block early nor open a fake one.
 */

const NAME = 'untrusted-screen-content';
const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029 || (c >= 0x2000 && c <= 0x200a) || c === 0x1680 || c === 0x202f || c === 0x205f || c === 0x3000;

/**
 * The text with every spelling of the delimiter made inert: it stays readable and can pair with nothing.
 *
 * Every `<` that starts the delimiter's name — after optional whitespace, an optional `/` and more whitespace, in any
 * case — becomes `‹`, whatever follows it: the exact tag, a tag with attributes, `/>`, no closing bracket, or another
 * tag nested inside it. The exact tag also gets `›` for its `>`, so it keeps its shape. Nothing is removed, so no new tag
 * can form from what is left, and a second pass changes nothing.
 *
 * One left-to-right scan, no regex: each character is looked at a bounded number of times, so a megabyte of unclosed
 * near-miss tags costs milliseconds (a regex with a greedy tail took seconds on 400 KB).
 */
export function defuseScreenDelimiters(text: string): string {
  let out = '';
  let last = 0;
  for (let i = text.indexOf('<'); i !== -1; i = text.indexOf('<', i + 1)) {
    let j = i + 1;
    while (isSpace(text.charCodeAt(j))) j++;
    if (text.charCodeAt(j) === 47 /* / */) { j++; while (isSpace(text.charCodeAt(j))) j++; }
    if ((text.charCodeAt(j) | 32) !== 117 /* u */ || text.slice(j, j + NAME.length).toLowerCase() !== NAME) continue;
    let k = j + NAME.length;
    while (isSpace(text.charCodeAt(k))) k++;
    out += `${text.slice(last, i)}‹`;
    if (text.charCodeAt(k) === 62 /* > */) { out += `${text.slice(i + 1, k)}›`; last = k + 1; } else { last = i + 1; }
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * Text the screen controls (a window title, an element name) must not steer the classification: a window titled "the screen
 * is locked" would turn any miss into SCREEN_LOCKED. Producers quote such text with quoteScreenText (or put it in an
 * <untrusted-screen-content> block); the classifier (result-codes.ts) reads the result with quoted spans, `key='value'`
 * spans and untrusted blocks blanked out, so only clawdcursor's own words are matched.
 */
export function quoteScreenText(s: string): string {
  // The block delimiters are defused too: a name carrying a closing delimiter would otherwise pair with a real block.
  const defused = defuseScreenDelimiters(String(s ?? ''));
  return `"${defused.replace(/["\r\n]+/g, "'")}"`;
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
