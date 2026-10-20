/**
 * Text the pause prompt itself shows: the message and its own labels. A `done_when` OCR condition that matches it would
 * be true the moment the prompt appears, so callers reject one.
 */
export function pausePromptText(message: string): string {
  return `The agent says: ${message} Resume End task Something else desktop control in progress`.toLowerCase();
}
