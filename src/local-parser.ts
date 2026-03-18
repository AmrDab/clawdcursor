/**
 * Local Task Parser — decomposes tasks using regex/pattern matching
 * instead of LLM calls. Fast, deterministic, zero dependencies.
 *
 * Returns null if the task can't be parsed (signals LLM fallback needed).
 */

export class LocalTaskParser {
  /**
   * Decompose a task string into an array of subtask strings.
   * Uses regex pattern matching to identify common action patterns.
   *
   * @param task - The natural language task to decompose
   * @returns Array of subtask strings, or null if parsing fails
   */
  decomposeTask(task: string): string[] | null {
    if (!task || typeof task !== 'string') {
      return null;
    }

    const trimmed = task.trim();
    if (trimmed.length === 0) {
      return null;
    }

    // First, try to split compound tasks on delimiters
    const parts = this.splitCompoundTask(trimmed);

    // Parse each part individually
    const subtasks: string[] = [];

    for (const part of parts) {
      const parsed = this.parseSingleTask(part.trim());
      if (parsed === null) {
        // If any part fails to parse, return null for LLM fallback
        return null;
      }
      subtasks.push(parsed);
    }

    return subtasks.length > 0 ? subtasks : null;
  }

  /**
   * Split a compound task on common delimiters: and, then, ,
   * Handles quoted text to avoid splitting inside quotes.
   */
  private splitCompoundTask(task: string): string[] {
    // Split on: ' and ', ' then ', ',' (with optional spaces)
    // But be careful not to split inside quoted text
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    const len = task.length;
    let i = 0;

    while (i < len) {
      const char = task[i];

      // Handle quote characters
      if ((char === '"' || char === "'") && !inQuotes) {
        inQuotes = true;
        quoteChar = char;
        current += char;
        i++;
        continue;
      }

      if (char === quoteChar && inQuotes) {
        inQuotes = false;
        quoteChar = '';
        current += char;
        i++;
        continue;
      }

      // If inside quotes, just accumulate
      if (inQuotes) {
        current += char;
        i++;
        continue;
      }

      // Check for delimiters
      const remaining = task.substring(i).toLowerCase();

      // Check for ' and ' (with spaces)
      if (remaining.startsWith(' and ') || remaining.startsWith(' then ')) {
        if (current.trim()) {
          parts.push(current.trim());
          current = '';
        }
        i += remaining.startsWith(' and ') ? 5 : 6;
        continue;
      }

      // Check for comma delimiter
      if (char === ',') {
        if (current.trim()) {
          parts.push(current.trim());
          current = '';
        }
        i++;
        continue;
      }

      // Regular character
      current += char;
      i++;
    }

    // Don't forget the last part
    if (current.trim()) {
      parts.push(current.trim());
    }

    return parts.length > 0 ? parts : [task];
  }

  /**
   * Parse a single (non-compound) task.
   * Returns the normalized subtask string, or null if unrecognized.
   */
  private parseSingleTask(task: string): string | null {
    const normalized = task.toLowerCase().trim();

    // Try each pattern in order of specificity

    // 1. Open / Launch / Start [app]
    const openMatch = normalized.match(/^(?:open|launch|start)\s+(\S.*)$/i);
    if (openMatch) {
      return `open ${openMatch[1].trim()}`;
    }

    // 2. Go to / Navigate to / Visit [url]
    const navigateMatch = normalized.match(/^(?:go\s+to|navigate\s+to|visit)\s+(\S.*)$/i);
    if (navigateMatch) {
      return `go to ${navigateMatch[1].trim()}`;
    }

    // 3. Close [app]
    const closeMatch = normalized.match(/^close\s+(\S.*)$/i);
    if (closeMatch) {
      return `close ${closeMatch[1].trim()}`;
    }

    // 4. Minimize [window/app]
    const minimizeMatch = normalized.match(/^minimize(?:\s+the)?\s*(\S.*)?$/i);
    if (minimizeMatch) {
      const target = minimizeMatch[1]?.trim();
      return target ? `minimize ${target}` : 'minimize window';
    }

    // 5. Maximize [window/app]
    const maximizeMatch = normalized.match(/^maximize(?:\s+the)?\s*(\S.*)?$/i);
    if (maximizeMatch) {
      const target = maximizeMatch[1]?.trim();
      return target ? `maximize ${target}` : 'maximize window';
    }

    // 6. Focus / Switch to [window]
    const focusMatch = normalized.match(/^(?:focus|switch\s+to)\s+(\S.*)$/i);
    if (focusMatch) {
      return `focus ${focusMatch[1].trim()}`;
    }

    // 7. Type / Enter [text] — literal keyboard input only
    // "write" excluded: implies creative composition needing LLM
    const typeMatch = normalized.match(/^(?:type|enter)\s+(\S.*)$/i);
    if (typeMatch) {
      const text = typeMatch[1].trim();
      // Remove surrounding quotes if present
      const cleanText = text.replace(/^["']([^"']+)["']$/, '$1');
      return `type ${cleanText}`;
    }

    // 8. Click [element]
    const clickMatch = normalized.match(/^click\s+(\S.*)$/i);
    if (clickMatch) {
      return `click ${clickMatch[1].trim()}`;
    }

    // 9. Press [button/key]
    const pressMatch = normalized.match(/^press\s+(\S.*)$/i);
    if (pressMatch) {
      return `press ${pressMatch[1].trim()}`;
    }

    // 10. Standalone shortcuts (copy, paste, undo, redo, save, select all)
    const shortcutPatterns = [
      { pattern: /^(?:copy|ctrl\+c|cmd\+c)$/i, result: 'copy' },
      { pattern: /^(?:paste|ctrl\+v|cmd\+v)$/i, result: 'paste' },
      { pattern: /^(?:cut|ctrl\+x|cmd\+x)$/i, result: 'cut' },
      { pattern: /^(?:undo|ctrl\+z|cmd\+z)$/i, result: 'undo' },
      { pattern: /^(?:redo|ctrl\+y|cmd\+y|ctrl\+shift\+z)$/i, result: 'redo' },
      { pattern: /^(?:save|ctrl\+s|cmd\+s)$/i, result: 'save' },
      { pattern: /^(?:select\s+all|ctrl\+a|cmd\+a)$/i, result: 'select all' },
      { pattern: /^(?:print|ctrl\+p|cmd\+p)$/i, result: 'print' },
      { pattern: /^(?:find|ctrl\+f|cmd\+f)$/i, result: 'find' },
      { pattern: /^(?:refresh|reload|f5|ctrl\+r|cmd\+r)$/i, result: 'refresh' },
      { pattern: /^(?:enter|return|press\s+enter|press\s+return)$/i, result: 'press enter' },
      { pattern: /^(?:escape|esc|press\s+escape|press\s+esc)$/i, result: 'press escape' },
      { pattern: /^(?:tab|press\s+tab)$/i, result: 'press tab' },
      { pattern: /^(?:space|spacebar|press\s+space)$/i, result: 'press space' },
      { pattern: /^(?:backspace|press\s+backspace)$/i, result: 'press backspace' },
      { pattern: /^(?:delete|press\s+delete|press\s+del)$/i, result: 'press delete' },
      { pattern: /^(?:up|up\s+arrow|press\s+up|press\s+up\s+arrow)$/i, result: 'press up' },
      { pattern: /^(?:down|down\s+arrow|press\s+down|press\s+down\s+arrow)$/i, result: 'press down' },
      { pattern: /^(?:left|left\s+arrow|press\s+left|press\s+left\s+arrow)$/i, result: 'press left' },
      { pattern: /^(?:right|right\s+arrow|press\s+right|press\s+right\s+arrow)$/i, result: 'press right' },
      { pattern: /^(?:home|press\s+home)$/i, result: 'press home' },
      { pattern: /^(?:end|press\s+end)$/i, result: 'press end' },
      { pattern: /^(?:page\s+up|press\s+page\s+up)$/i, result: 'press page up' },
      { pattern: /^(?:page\s+down|press\s+page\s+down)$/i, result: 'press page down' },
    ];

    for (const { pattern, result } of shortcutPatterns) {
      if (pattern.test(normalized)) {
        return result;
      }
    }

    // 11. Wait commands
    const waitMatch = normalized.match(/^wait(?:\s+for)?\s+(\d+)\s*(?:seconds?|ms|milliseconds?)?$/i);
    if (waitMatch) {
      return `wait ${waitMatch[1]}s`;
    }
    if (/^wait$/i.test(normalized)) {
      return 'wait';
    }

    // 12. Scroll commands
    const scrollWithAmountMatch = normalized.match(/^scroll\s+(up|down|left|right)(?:\s+by)?\s+(\d+)\s*(?:px|pixels?)?$/i);
    if (scrollWithAmountMatch) {
      return `scroll ${scrollWithAmountMatch[1]} ${scrollWithAmountMatch[2]}px`;
    }
    const scrollMatch = normalized.match(/^scroll\s+(up|down|left|right)$/i);
    if (scrollMatch) {
      return `scroll ${scrollMatch[1]}`;
    }

    // 13. Double-click [element]
    const doubleClickMatch = normalized.match(/^(?:double[- ]click|doubleclick)\s+(\S.*)$/i);
    if (doubleClickMatch) {
      return `double click ${doubleClickMatch[1].trim()}`;
    }

    // 14. Right-click [element]
    const rightClickMatch = normalized.match(/^(?:right[- ]click|rightclick)\s+(\S.*)$/i);
    if (rightClickMatch) {
      return `right click ${rightClickMatch[1].trim()}`;
    }

    // 15. Search for [query]
    const searchMatch = normalized.match(/^search\s+(?:for\s+)?(\S.*)$/i);
    if (searchMatch) {
      return `search for ${searchMatch[1].trim()}`;
    }

    // 16. "save [the] file as [filename] [on the desktop / in folder]"
    const saveAsMatch = task.match(/^save\s+(?:the\s+)?(?:file|document|it)\s+as\s+(.+)$/i);
    if (saveAsMatch) {
      return `save as ${saveAsMatch[1].trim()}`;
    }

    // 17. "type the sentence X" / "type the text X" / "type the word X"
    // Handles "type the sentence The quick brown fox..." which the basic type pattern misses
    const typeSentenceMatch = task.match(/^type\s+(?:the\s+)?(?:sentence|text|phrase|word|message|string)\s+(.+)$/i);
    if (typeSentenceMatch) {
      return `type ${typeSentenceMatch[1].trim()}`;
    }

    // If no pattern matched, return null (trigger LLM fallback)
    return null;
  }

  /**
   * Check if a task can be parsed locally without LLM fallback.
   * Useful for determining if fast-path parsing is available.
   */
  canParse(task: string): boolean {
    return this.decomposeTask(task) !== null;
  }
}
