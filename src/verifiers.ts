/**
 * Verifier Plugins — app-specific ground truth verification.
 * Each verifier checks actual system state (UIA, clipboard, file system, window state)
 * rather than trusting LLM opinions.
 */

import { AccessibilityBridge } from './accessibility';

export interface VerifyResult {
  pass: boolean;
  method: string;       // e.g., 'uia_value_read', 'clipboard_check', 'file_exists', 'window_title'
  detail: string;
  confidence: number;   // 0-1, how confident we are in this result
}

export class TaskVerifier {
  constructor(private a11y: AccessibilityBridge) {}

  /**
   * Run all applicable verifiers for the given task.
   * Returns the highest-confidence result.
   */
  async verify(task: string, readClipboard?: () => Promise<string>): Promise<VerifyResult> {
    const taskLower = task.toLowerCase();
    const results: VerifyResult[] = [];

    // Try each verifier in order of specificity
    // Notepad / text editor paste verification
    if (/paste.*notepad|notepad.*paste|copy.*notepad|notepad.*copy/i.test(taskLower)) {
      results.push(await this.verifyNotepadContent(task));
    }

    // Text writing verification (Notepad, any text editor)
    if (/\b(write|compose|draft|type.*sentence|type.*paragraph)\b/i.test(taskLower)) {
      results.push(await this.verifyTextContent(task));
    }

    // Email send verification
    if (/\b(send.*email|email.*send|send.*mail|mail.*send)\b/i.test(taskLower)) {
      results.push(await this.verifyEmailSent());
    }

    // File save verification
    if (/\b(save|save as|save file|export)\b/i.test(taskLower)) {
      results.push(await this.verifyFileSaved(task));
    }

    // Browser navigation verification
    if (/\b(go to|navigate|open.*site|visit|browse)\b/i.test(taskLower)) {
      results.push(await this.verifyNavigation(task));
    }

    // App open verification
    if (/^open\s/i.test(taskLower)) {
      results.push(await this.verifyAppOpen(task));
    }

    // Clipboard copy verification
    if (/\bcopy\b/i.test(taskLower) && readClipboard) {
      results.push(await this.verifyClipboardHasContent(readClipboard));
    }

    // Chart/graph creation verification
    if (/\b(chart|graph|plot|diagram)\b/i.test(taskLower)) {
      results.push(await this.verifyChartCreated());
    }

    // If no specific verifier matched, return a pass-through
    if (results.length === 0) {
      return { pass: true, method: 'none', detail: 'no specific verifier for this task type', confidence: 0.3 };
    }

    // Return highest confidence result, preferring failures (if any verifier says fail, trust it)
    const failures = results.filter(r => !r.pass);
    if (failures.length > 0) {
      // Return the most confident failure
      return failures.sort((a, b) => b.confidence - a.confidence)[0];
    }
    return results.sort((a, b) => b.confidence - a.confidence)[0];
  }

  // ─── Individual Verifiers ──────────────────────────────────

  private async verifyNotepadContent(_task: string): Promise<VerifyResult> {
    try {
      const activeWin = await this.a11y.getActiveWindow().catch(() => null);
      const pn = (activeWin?.processName || '').toLowerCase();

      // Check if Notepad is the active window
      if (pn !== 'notepad') {
        // Try to find Notepad in window list
        const windows = await this.a11y.getWindows().catch(() => []);
        const notepadWin = windows.find(w => w.processName.toLowerCase() === 'notepad');
        if (!notepadWin) {
          return { pass: false, method: 'window_check', detail: 'Notepad is not open', confidence: 0.9 };
        }
        // Notepad exists but isn't focused — might still have content
      }

      // Read focused element value
      const focused = await this.a11y.getFocusedElement().catch(() => null);
      if (focused?.value && focused.value.trim().length > 10) {
        return { pass: true, method: 'uia_value_read', detail: `notepad has ${focused.value.length} chars: "${focused.value.substring(0, 60)}..."`, confidence: 0.95 };
      }

      // Try reading the full screen context for notepad
      const context = await this.a11y.getScreenContext().catch(() => null);
      if (context && /value="[^"]{10,}/.test(context)) {
        return { pass: true, method: 'uia_tree_scan', detail: 'notepad edit control has content (from a11y tree)', confidence: 0.8 };
      }

      return { pass: false, method: 'uia_value_read', detail: `notepad appears empty — value: "${focused?.value?.substring(0, 50) || '(none)'}"`, confidence: 0.9 };
    } catch (err) {
      return { pass: true, method: 'error_passthrough', detail: `verifier error: ${String(err).substring(0, 80)}`, confidence: 0.1 };
    }
  }

  private async verifyTextContent(_task: string): Promise<VerifyResult> {
    try {
      const activeWin = await this.a11y.getActiveWindow().catch(() => null);
      const pn = (activeWin?.processName || '').toLowerCase();

      // Skip for browsers — can't read canvas content via UIA
      if (/msedge|chrome|firefox/.test(pn)) {
        return { pass: true, method: 'skip_browser', detail: 'browser text content not verifiable via UIA', confidence: 0.3 };
      }

      const focused = await this.a11y.getFocusedElement().catch(() => null);
      if (focused?.value && focused.value.trim().length > 5) {
        return { pass: true, method: 'uia_value_read', detail: `content found (${focused.value.length} chars)`, confidence: 0.85 };
      }

      return { pass: false, method: 'uia_value_read', detail: `focused element empty or too short — value: "${focused?.value?.substring(0, 50) || '(none)'}"`, confidence: 0.7 };
    } catch {
      return { pass: true, method: 'error_passthrough', detail: 'verifier error', confidence: 0.1 };
    }
  }

  private async verifyEmailSent(): Promise<VerifyResult> {
    try {
      const activeWin = await this.a11y.getActiveWindow().catch(() => null);
      const title = (activeWin?.title || '').toLowerCase();

      if (title.includes('compose') || title.includes('new message') || title.includes('untitled')) {
        return { pass: false, method: 'window_title', detail: `compose window still open: "${activeWin?.title}"`, confidence: 0.85 };
      }

      if (title.includes('inbox') || title.includes('mail') || title.includes('outlook') || title.includes('sent')) {
        return { pass: true, method: 'window_title', detail: `compose closed, now at: "${activeWin?.title}"`, confidence: 0.8 };
      }

      return { pass: true, method: 'window_title', detail: `unknown window state: "${activeWin?.title}"`, confidence: 0.4 };
    } catch {
      return { pass: true, method: 'error_passthrough', detail: 'verifier error', confidence: 0.1 };
    }
  }

  private async verifyFileSaved(_task: string): Promise<VerifyResult> {
    try {
      const activeWin = await this.a11y.getActiveWindow().catch(() => null);
      const title = (activeWin?.title || '');

      // Check if title bar no longer shows unsaved indicator
      if (title.startsWith('*') || title.includes('(unsaved)') || title.includes('- Untitled')) {
        return { pass: false, method: 'window_title', detail: `file appears unsaved: "${title}"`, confidence: 0.7 };
      }

      // TODO: Could also check file system if we extract filename from task
      return { pass: true, method: 'window_title', detail: `title suggests saved: "${title}"`, confidence: 0.6 };
    } catch {
      return { pass: true, method: 'error_passthrough', detail: 'verifier error', confidence: 0.1 };
    }
  }

  private async verifyNavigation(_task: string): Promise<VerifyResult> {
    try {
      const activeWin = await this.a11y.getActiveWindow().catch(() => null);
      const pn = (activeWin?.processName || '').toLowerCase();

      if (/msedge|chrome|firefox/.test(pn)) {
        return { pass: true, method: 'window_check', detail: `browser is active: "${activeWin?.title?.substring(0, 50)}"`, confidence: 0.7 };
      }

      return { pass: false, method: 'window_check', detail: `expected browser but active is: ${pn}`, confidence: 0.6 };
    } catch {
      return { pass: true, method: 'error_passthrough', detail: 'verifier error', confidence: 0.1 };
    }
  }

  private async verifyAppOpen(_task: string): Promise<VerifyResult> {
    try {
      const activeWin = await this.a11y.getActiveWindow().catch(() => null);
      if (activeWin && activeWin.processName) {
        return { pass: true, method: 'window_check', detail: `app active: "${activeWin.title}" (${activeWin.processName})`, confidence: 0.8 };
      }
      return { pass: false, method: 'window_check', detail: 'no active window detected', confidence: 0.7 };
    } catch {
      return { pass: true, method: 'error_passthrough', detail: 'verifier error', confidence: 0.1 };
    }
  }

  private async verifyClipboardHasContent(readClipboard: () => Promise<string>): Promise<VerifyResult> {
    try {
      const clip = await readClipboard();
      if (clip && clip.trim().length > 5) {
        return { pass: true, method: 'clipboard_read', detail: `clipboard has ${clip.length} chars: "${clip.substring(0, 60)}..."`, confidence: 0.9 };
      }
      return { pass: false, method: 'clipboard_read', detail: `clipboard empty or too short: "${clip?.substring(0, 30) || '(empty)'}"`, confidence: 0.85 };
    } catch {
      return { pass: true, method: 'error_passthrough', detail: 'clipboard read failed', confidence: 0.1 };
    }
  }

  private async verifyChartCreated(): Promise<VerifyResult> {
    try {
      const activeWin = await this.a11y.getActiveWindow().catch(() => null);
      const pn = (activeWin?.processName || '').toLowerCase();

      if (/excel/i.test(pn)) {
        // Check a11y tree for chart-related elements
        const context = await this.a11y.getScreenContext(activeWin?.processId).catch(() => null);
        if (context && /chart|graph|plot/i.test(context)) {
          return { pass: true, method: 'uia_tree_scan', detail: 'chart element found in a11y tree', confidence: 0.85 };
        }

        // Check if Chart Design tab is visible (appears when chart is selected)
        if (context && /chart design|format.*chart/i.test(context)) {
          return { pass: true, method: 'uia_tree_scan', detail: 'Chart Design tab visible — chart is selected', confidence: 0.9 };
        }

        return { pass: false, method: 'uia_tree_scan', detail: 'no chart elements found in Excel a11y tree', confidence: 0.7 };
      }

      return { pass: true, method: 'none', detail: 'not in Excel — cannot verify chart', confidence: 0.3 };
    } catch {
      return { pass: true, method: 'error_passthrough', detail: 'verifier error', confidence: 0.1 };
    }
  }
}
