/**
 * Prompt-injection defense: screen content is wrapped in
 * `<untrusted-screen-content>` delimiters so a calling agent can treat
 * anything inside as data, never as instructions.
 */

/**
 * Wrap screen content in explicit delimiters to make prompt-injection defense
 * auditable.
 */
export function wrapUntrustedScreenContent(text: string): string {
  // The content cannot close (or reopen) the block itself: a page or field that contains the delimiter would otherwise
  // end the "untrusted" part early and have what follows read as the tool's own words.
  const safe = text.replace(/<(\/?)\s*untrusted-screen-content\s*>/gi, '‹$1untrusted-screen-content›');
  return `<untrusted-screen-content>\n${safe}\n</untrusted-screen-content>`;
}
