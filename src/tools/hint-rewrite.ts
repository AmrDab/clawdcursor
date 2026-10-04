/**
 * Tool results are rewritten so hints name tools that exist on the caller's
 * surface (see toCompactNames / toMcpNames). That rewrite must only touch
 * clawdcursor's own prose:
 *   - a JSON result is data and stays byte-identical — the compact rewrite
 *     inserts `{action:"…"}` with raw double quotes, which made every OCR
 *     result (its hint names smart_click / mouse_click) unparseable;
 *   - text inside <untrusted-screen-content> is what the screen, page, file
 *     or clipboard said — rewriting it would corrupt what the agent reads.
 */
const UNTRUSTED_BLOCK = /(<untrusted-screen-content>[\s\S]*?<\/untrusted-screen-content>)/;

export function rewriteOutsideData(text: string, rewrite: (prose: string) => string): string {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { JSON.parse(t); return text; } catch { /* not JSON — treat as prose */ }
  }
  return text
    .split(UNTRUSTED_BLOCK)
    .map((seg, i) => (i % 2 === 1 ? seg : rewrite(seg)))
    .join('');
}
