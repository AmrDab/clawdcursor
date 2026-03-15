/**
 * Safe JSON extraction from LLM responses.
 *
 * LLMs often return JSON wrapped in markdown fences, explanation text,
 * or multiple JSON fragments. The greedy regex /\{[\s\S]*\}/ can match
 * from the first { to the LAST }, capturing invalid JSON. This module
 * uses balanced-brace counting for reliable extraction.
 */

/**
 * Extract the first valid JSON object from a string.
 * Uses balanced-brace matching instead of greedy regex.
 */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.substring(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // Brace-matched but invalid JSON — keep scanning
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Extract the first valid JSON array from a string.
 */
export function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const candidate = text.substring(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
