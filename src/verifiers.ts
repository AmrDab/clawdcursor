/**
 * Verifiers — Ground-truth task completion verification.
 *
 * v0.7.0 redesign: LLM-as-primary-verifier.
 *
 * Instead of hardcoded regex patterns that silently pass on unrecognized tasks,
 * the text LLM reads the actual a11y tree state and makes a semantic judgment
 * about whether the task was FULLY completed. Evidence is required — vague
 * confirmations are rejected.
 *
 * Fast-path heuristics still run first for trivial checks (app open, clipboard),
 * but the LLM verifier is the authoritative fallback for anything semantic.
 *
 * Key design principles:
 *  - Default is UNCERTAIN, not PASS. Unrecognized tasks go to LLM, never auto-pass.
 *  - Error passthrough is FAIL, not PASS. Broken verifiers are never silent.
 *  - LLM must cite specific screen evidence to return PASS.
 *  - All verification attempts are logged in full detail for debugging.
 */

import { AccessibilityBridge } from './accessibility';
import type { PipelineConfig } from './providers';

export interface VerifyResult {
  pass: boolean;
  method: string;
  detail: string;
  confidence: number;         // 0-1
  evidence?: string;          // exact text/state cited as proof
  attemptLog: VerifyAttempt[]; // full audit trail of every check run
}

export interface VerifyAttempt {
  checkName: string;
  pass: boolean;
  confidence: number;
  detail: string;
  durationMs: number;
  error?: string;
}

export class TaskVerifier {
  private pipelineConfig: PipelineConfig | null = null;

  constructor(
    private a11y: AccessibilityBridge,
    pipelineConfig?: PipelineConfig,
  ) {
    this.pipelineConfig = pipelineConfig ?? null;
  }

  /**
   * Run all applicable verifiers for the given task.
   *
   * Strategy:
   * 1. Fast-path heuristics (zero LLM cost) for trivial cases.
   * 2. If no fast-path gave high-confidence result, run LLM verifier.
   * 3. Any failure from any check wins over passes.
   * 4. Full attempt log is always returned for logging.
   */
  async verify(task: string, readClipboard?: () => Promise<string>): Promise<VerifyResult> {
    const taskLower = task.toLowerCase();
    const attempts: VerifyAttempt[] = [];
    const fastResults: VerifyResult[] = [];

    // ── Fast-path heuristics ─────────────────────────────────────────────────

    // App-open check
    if (/^open\s/i.test(taskLower) && !/\band\b/i.test(taskLower)) {
      const r = await this.timed('app_open_check', () => this.verifyAppOpen(task));
      attempts.push(r.attempt);
      if (r.result.confidence >= 0.8) fastResults.push(r.result);
    }

    // Clipboard copy check
    if (/\bcopy\b/i.test(taskLower) && readClipboard) {
      const r = await this.timed('clipboard_check', () => this.verifyClipboardHasContent(readClipboard));
      attempts.push(r.attempt);
      if (r.result.confidence >= 0.8) fastResults.push(r.result);
    }

    // Browser navigation check
    if (/^(go to|navigate to|open|visit|browse)\s+https?:\/\//i.test(taskLower)) {
      const r = await this.timed('navigation_check', () => this.verifyNavigation(task));
      attempts.push(r.attempt);
      if (r.result.confidence >= 0.75) fastResults.push(r.result);
    }

    // If a fast-path check already failed with high confidence, short-circuit
    const highConfidenceFailure = fastResults.find(r => !r.pass && r.confidence >= 0.85);
    if (highConfidenceFailure) {
      return { ...highConfidenceFailure, attemptLog: attempts };
    }

    // If a fast-path check passed with high confidence AND task is simple, accept it
    const highConfidencePass = fastResults.find(r => r.pass && r.confidence >= 0.85);
    const isComplexTask = /\band\b|\bthen\b|,/i.test(taskLower);
    if (highConfidencePass && !isComplexTask) {
      return { ...highConfidencePass, attemptLog: attempts };
    }

    // ── LLM Verifier (semantic, evidence-based) ──────────────────────────────

    if (this.pipelineConfig?.layer2.enabled) {
      const r = await this.timed('llm_semantic_verify', () => this.verifyWithLLM(task));
      attempts.push(r.attempt);
      return { ...r.result, attemptLog: attempts };
    }

    // ── Fallback: no LLM available, read a11y tree and do best-effort check ──

    const r = await this.timed('a11y_fallback_check', () => this.verifyWithA11yOnly(task));
    attempts.push(r.attempt);
    return { ...r.result, attemptLog: attempts };
  }

  // ── LLM Verifier ────────────────────────────────────────────────────────────

  private async verifyWithLLM(task: string): Promise<VerifyResult> {
    try {
      // Read the current a11y tree
      const activeWin = await this.a11y.getActiveWindow().catch(() => null);
      const screenContext = await this.a11y.getScreenContext(activeWin?.processId).catch(() => null);
      const focusedEl = await this.a11y.getFocusedElement().catch(() => null);

      const stateLines: string[] = [];
      if (activeWin) {
        stateLines.push(`Active window: "${activeWin.title}" (process: ${activeWin.processName})`);
      }
      if (focusedEl) {
        const val = focusedEl.value ? ` | value: "${focusedEl.value.substring(0, 200)}"` : '';
        stateLines.push(`Focused element: ${focusedEl.name || '(unnamed)'}${val}`);
      }
      if (screenContext) {
        // Include a trimmed version of the a11y tree — cap at 2000 chars to stay within token budget
        stateLines.push(`\nAccessibility tree (truncated):\n${screenContext.substring(0, 2000)}`);
      }

      const screenState = stateLines.length > 0
        ? stateLines.join('\n')
        : 'Screen state unavailable.';

      const prompt = `You are a strict task completion verifier. Your ONLY job is to determine if a desktop task was FULLY completed based on the current screen state.

TASK: "${task}"

CURRENT SCREEN STATE:
${screenState}

Answer in this exact JSON format:
{
  "verdict": "PASS" | "FAIL" | "UNCERTAIN",
  "evidence": "<specific text/element/value you can see that proves completion, or what is missing>",
  "confidence": <0.0-1.0>,
  "reasoning": "<one sentence explaining your verdict>"
}

STRICT RULES:
- PASS requires SPECIFIC evidence you can cite from the screen state above. "App is open" alone is NOT evidence for a task that requires writing, filling, or sending something.
- FAIL if the required outcome (text written, form filled, message sent, file saved) is not clearly visible in the state.
- UNCERTAIN if the screen state does not have enough information to judge — do NOT default to PASS.
- For writing tasks: the actual content must be visible in the accessibility tree value field.
- For send/submit tasks: the compose/form window must be GONE, not still open.
- Confidence below 0.6 = UNCERTAIN.`;

      const response = await this.callTextModel(prompt);

      let parsed: any;
      try {
        parsed = JSON.parse(response);
      } catch {
        // Try to extract JSON from response
        const match = response.match(/\{[\s\S]*\}/);
        if (match) {
          try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
        }
      }

      if (!parsed || !parsed.verdict) {
        return {
          pass: false,
          method: 'llm_semantic_verify',
          detail: `LLM returned unparseable response: ${response.substring(0, 100)}`,
          confidence: 0.1,
          attemptLog: [],
        };
      }

      const verdict = String(parsed.verdict).toUpperCase();
      const confidence = typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5;
      const evidence = String(parsed.evidence || '').substring(0, 300);
      const reasoning = String(parsed.reasoning || '').substring(0, 200);

      const pass = verdict === 'PASS' && confidence >= 0.65;
      const detail = `[${verdict}] ${reasoning} | evidence: ${evidence}`;

      return {
        pass,
        method: 'llm_semantic_verify',
        detail,
        confidence,
        evidence,
        attemptLog: [],
      };

    } catch (err) {
      // LLM call failed — do NOT silently pass. Return fail with error detail.
      return {
        pass: false,
        method: 'llm_semantic_verify',
        detail: `LLM verifier error: ${String(err).substring(0, 200)}`,
        confidence: 0.0,
        attemptLog: [],
      };
    }
  }

  // ── A11y-only fallback (no LLM) ─────────────────────────────────────────────

  private async verifyWithA11yOnly(task: string): Promise<VerifyResult> {
    try {
      const activeWin = await this.a11y.getActiveWindow().catch(() => null);
      const focused = await this.a11y.getFocusedElement().catch(() => null);
      const taskLower = task.toLowerCase();

      // For writing tasks: require non-trivial content in focused element
      if (/\b(write|type|compose|draft|enter)\b/i.test(taskLower)) {
        if (focused?.value && focused.value.trim().length > 20) {
          return {
            pass: true,
            method: 'a11y_fallback',
            detail: `Focused element has ${focused.value.length} chars: "${focused.value.substring(0, 80)}..."`,
            confidence: 0.7,
            evidence: focused.value.substring(0, 80),
            attemptLog: [],
          };
        }
        return {
          pass: false,
          method: 'a11y_fallback',
          detail: `Writing task but focused element empty or short: "${focused?.value?.substring(0, 50) || '(none)'}"`,
          confidence: 0.75,
          attemptLog: [],
        };
      }

      // For send/submit tasks: check compose window is gone
      if (/\b(send|submit|click send|click submit)\b/i.test(taskLower)) {
        const title = (activeWin?.title || '').toLowerCase();
        if (/compose|new message|untitled|draft/i.test(title)) {
          return {
            pass: false,
            method: 'a11y_fallback',
            detail: `Compose window still open: "${activeWin?.title}"`,
            confidence: 0.85,
            attemptLog: [],
          };
        }
      }

      // General: return uncertain rather than pass — LLM unavailable
      return {
        pass: false,
        method: 'a11y_fallback',
        detail: `No LLM available for semantic verification. A11y state: window="${activeWin?.title || 'none'}", focused="${focused?.name || 'none'}". Marking uncertain/fail to avoid false positive.`,
        confidence: 0.4,
        attemptLog: [],
      };
    } catch (err) {
      return {
        pass: false,
        method: 'a11y_fallback_error',
        detail: `A11y fallback verifier error: ${String(err).substring(0, 200)}`,
        confidence: 0.0,
        attemptLog: [],
      };
    }
  }

  // ── Fast-path heuristics ────────────────────────────────────────────────────

  private async verifyAppOpen(_task: string): Promise<VerifyResult> {
    try {
      const activeWin = await this.a11y.getActiveWindow().catch(() => null);
      if (activeWin?.processName) {
        return {
          pass: true,
          method: 'app_open_check',
          detail: `Active window: "${activeWin.title}" (${activeWin.processName})`,
          confidence: 0.85,
          evidence: `${activeWin.processName} window open: "${activeWin.title}"`,
          attemptLog: [],
        };
      }
      return {
        pass: false,
        method: 'app_open_check',
        detail: 'No active window detected after open command',
        confidence: 0.8,
        attemptLog: [],
      };
    } catch (err) {
      return {
        pass: false,
        method: 'app_open_check_error',
        detail: `App open check error: ${String(err).substring(0, 100)}`,
        confidence: 0.0,
        attemptLog: [],
      };
    }
  }

  private async verifyClipboardHasContent(readClipboard: () => Promise<string>): Promise<VerifyResult> {
    try {
      const clip = await readClipboard();
      if (clip && clip.trim().length > 5) {
        return {
          pass: true,
          method: 'clipboard_check',
          detail: `Clipboard has ${clip.length} chars: "${clip.substring(0, 80)}..."`,
          confidence: 0.92,
          evidence: clip.substring(0, 80),
          attemptLog: [],
        };
      }
      return {
        pass: false,
        method: 'clipboard_check',
        detail: `Clipboard empty or too short: "${clip?.substring(0, 30) || '(empty)'}"`,
        confidence: 0.9,
        attemptLog: [],
      };
    } catch (err) {
      return {
        pass: false,
        method: 'clipboard_check_error',
        detail: `Clipboard read error: ${String(err).substring(0, 100)}`,
        confidence: 0.0,
        attemptLog: [],
      };
    }
  }

  private async verifyNavigation(task: string): Promise<VerifyResult> {
    try {
      const urlMatch = task.match(/https?:\/\/[^\s]+/i);
      const expectedDomain = urlMatch
        ? new URL(urlMatch[0]).hostname.replace(/^www\./, '')
        : null;

      const activeWin = await this.a11y.getActiveWindow().catch(() => null);
      const title = (activeWin?.title || '').toLowerCase();
      const pn = (activeWin?.processName || '').toLowerCase();

      if (!/msedge|chrome|firefox/i.test(pn)) {
        return {
          pass: false,
          method: 'navigation_check',
          detail: `Expected browser but active process is: ${activeWin?.processName || 'none'}`,
          confidence: 0.8,
          attemptLog: [],
        };
      }

      if (expectedDomain && title.includes(expectedDomain.replace('.com', '').replace('.org', ''))) {
        return {
          pass: true,
          method: 'navigation_check',
          detail: `Browser title matches expected domain "${expectedDomain}": "${activeWin?.title}"`,
          confidence: 0.85,
          evidence: `title: "${activeWin?.title}"`,
          attemptLog: [],
        };
      }

      return {
        pass: true,
        method: 'navigation_check',
        detail: `Browser is active: "${activeWin?.title}" — domain match not confirmed`,
        confidence: 0.6,
        attemptLog: [],
      };
    } catch (err) {
      return {
        pass: false,
        method: 'navigation_check_error',
        detail: `Navigation check error: ${String(err).substring(0, 100)}`,
        confidence: 0.0,
        attemptLog: [],
      };
    }
  }

  // ── LLM call ────────────────────────────────────────────────────────────────

  private async callTextModel(prompt: string): Promise<string> {
    if (!this.pipelineConfig) throw new Error('No pipeline config');

    const { model, baseUrl } = this.pipelineConfig.layer2;
    const apiKey = this.pipelineConfig.apiKey;
    const provider = this.pipelineConfig.provider;

    if (provider.openaiCompat || baseUrl.includes('localhost') || baseUrl.includes('11434')) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...provider.authHeader(apiKey) },
        body: JSON.stringify({
          model,
          max_tokens: 300,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json() as any;
      if (data.error) throw new Error(data.error.message ?? JSON.stringify(data.error));
      return data.choices?.[0]?.message?.content ?? '';
    } else {
      // Anthropic
      const res = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...provider.authHeader(apiKey) },
        body: JSON.stringify({
          model,
          max_tokens: 300,
          messages: [
            { role: 'user', content: prompt },
            { role: 'assistant', content: '{' },
          ],
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json() as any;
      if (data.error) throw new Error(data.error.message ?? JSON.stringify(data.error));
      const text = data.content?.[0]?.text ?? '';
      return text.startsWith('{') ? text : '{' + text;
    }
  }

  // ── Timing wrapper ───────────────────────────────────────────────────────────

  private async timed(
    checkName: string,
    fn: () => Promise<VerifyResult>,
  ): Promise<{ result: VerifyResult; attempt: VerifyAttempt }> {
    const t0 = Date.now();
    let result: VerifyResult;
    let error: string | undefined;
    try {
      result = await fn();
    } catch (err) {
      error = String(err).substring(0, 200);
      result = {
        pass: false,
        method: checkName + '_error',
        detail: `Unexpected error in ${checkName}: ${error}`,
        confidence: 0.0,
        attemptLog: [],
      };
    }
    return {
      result,
      attempt: {
        checkName,
        pass: result.pass,
        confidence: result.confidence,
        detail: result.detail,
        durationMs: Date.now() - t0,
        ...(error && { error }),
      },
    };
  }
}
