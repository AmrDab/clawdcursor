/**
 * Text the pause prompt itself shows: the message and its own labels. A `done_when` OCR condition that matches it would
 * be true the moment the prompt appears, so callers reject one.
 */
export function pausePromptText(message: string): string {
  return `The agent says: ${message} Resume End task Something else desktop control in progress`.toLowerCase();
}

/**
 * A `done_when` condition the prompt itself satisfies the moment it appears: its own text read by OCR, or one of its own
 * elements (its buttons, the reply box's Send) found by name — the agent's prompt must never answer its own pause.
 */
export function promptSatisfies(message: string, a: { type: string; value?: string; name?: string }): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const shown = norm(`${pausePromptText(message)} send`);
  const needle = a.type === 'ocr_contains' ? a.value
    : a.type === 'element_exists' || a.type === 'element_value_contains' ? a.name : undefined;
  return needle && norm(needle) && shown.includes(norm(needle)) ? needle : null;
}
