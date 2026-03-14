/**
 * OCR Reasoner — Layer 2.5.
 *
 * Primary universal read layer. Takes a screenshot, runs OS-level OCR,
 * builds a structured UI snapshot string, feeds it to a cheap text LLM,
 * and executes the returned action. Loops until done or cannot_read.
 *
 * Coordinates are in REAL screen pixels (no scaleFactor conversion needed).
 * This is simpler and more accurate than the vision LLM coordinate path.
 *
 * Falls through to vision LLM (L3) only when OCR genuinely cannot parse
 * the UI (captchas, pure image content, etc.).
 */

import { OcrEngine, type OcrResult, type OcrElement } from './ocr-engine';
import { NativeDesktop } from './native-desktop';
import { AccessibilityBridge } from './accessibility';
import type { PipelineConfig } from './providers';
import type { StepResult } from './types';

const MAX_OCR_STEPS = 15;     // max actions before giving up
const SETTLE_MS     = 400;    // wait after action before re-OCR
const CANNOT_READ_RETRIES = 2; // retries before signaling vision fallback

// ─── Action types returned by the LLM ────────────────────────────────────────

export type OcrAction =
  | { action: 'click';       x: number; y: number; description: string }
  | { action: 'type';        text: string; description: string }
  | { action: 'key';         key: string; description: string }
  | { action: 'scroll';      x: number; y: number; direction: 'up' | 'down'; amount: number }
  | { action: 'wait';        ms: number; reason: string }
  | { action: 'done';        evidence: string }
  | { action: 'cannot_read'; reason: string };

// ─── Result from a single OcrReasoner run ────────────────────────────────────

export interface OcrReasonerResult {
  handled: boolean;
  success: boolean;
  description: string;
  steps: number;
  fallbackReason?: string;  // set when cannot_read — tells agent.ts to try vision LLM
  actionLog: Array<{ action: string; description: string }>;
}

// ─── System prompt for the text LLM ─────────────────────────────────────────

const SYSTEM_PROMPT = `You are a desktop automation agent. You receive a UI snapshot with OCR text elements (with pixel coordinates) and optionally an accessibility tree. Your job is to decide the SINGLE NEXT ACTION to accomplish the user's task.

COORDINATE SYSTEM: All coordinates are in REAL SCREEN PIXELS. Click coordinates should target the CENTER of the element you want to click.

RESPONSE FORMAT — respond with ONLY valid JSON, no markdown:
{"action":"click","x":150,"y":300,"description":"Click the Send button"}
{"action":"type","text":"Hello world","description":"Type greeting into the text field"}
{"action":"key","key":"ctrl+s","description":"Save the document"}
{"action":"scroll","x":640,"y":400,"direction":"down","amount":3,"description":"Scroll down to see more content"}
{"action":"wait","ms":1000,"reason":"Waiting for page to load"}
{"action":"done","evidence":"The email was sent — confirmation banner visible at top"}
{"action":"cannot_read","reason":"Screen contains a captcha image that OCR cannot parse"}

RULES:
1. Return exactly ONE action per response
2. Use OCR element coordinates — click at the CENTER of the target element (x + width/2, y + height/2)
3. Prefer keyboard shortcuts over mouse clicks when available
4. Say "done" ONLY when you have clear evidence the task is complete
5. Say "cannot_read" ONLY when the screen content is genuinely unreadable (images, captchas)
6. NEVER repeat the same failed action — try an alternative approach
7. If an accessibility tree is provided, use it for semantic context (button roles, field labels)`;

// ─── OcrReasoner class ──────────────────────────────────────────────────────

export class OcrReasoner {
  constructor(
    private ocr: OcrEngine,
    private desktop: NativeDesktop,
    private a11y: AccessibilityBridge,
    private pipelineConfig: PipelineConfig,
  ) {}

  /**
   * Run the OCR reasoning loop for a single task.
   * Returns when done, failed, or signals cannot_read for vision fallback.
   */
  async run(task: string, priorContext?: string[]): Promise<OcrReasonerResult> {
    const actionLog: Array<{ action: string; description: string }> = [];
    let cannotReadCount = 0;
    let stepCount = 0;

    // Build conversation history for context
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    for (let step = 0; step < MAX_OCR_STEPS; step++) {
      stepCount = step + 1;

      // 1. OCR the screen
      this.ocr.invalidateCache();
      const ocrResult = await this.ocr.recognizeScreen();

      // 2. Optionally read a11y tree for semantic context
      let a11ySnippet = '';
      try {
        const activeWin = await this.a11y.getActiveWindow().catch(() => null);
        if (activeWin) {
          const tree = await this.a11y.getScreenContext(activeWin.processId).catch(() => null);
          if (tree) {
            a11ySnippet = `\n=== A11Y TREE (${activeWin.processName}: ${activeWin.title}) ===\n${tree.substring(0, 2000)}`;
          }
        }
      } catch { /* non-fatal — OCR is the primary source */ }

      // 3. Build the UI snapshot string
      const snapshot = this.buildSnapshot(ocrResult, a11ySnippet, actionLog, task, priorContext);

      // 4. Ask the text LLM for the next action
      messages.push({ role: 'user', content: snapshot });

      let llmResponse: string;
      try {
        llmResponse = await this.callTextLLM(messages);
      } catch (err: any) {
        console.error(`   [OCR Reasoner] LLM call failed: ${err.message}`);
        return {
          handled: false,
          success: false,
          description: `LLM call failed: ${err.message}`,
          steps: stepCount,
          actionLog,
        };
      }

      messages.push({ role: 'assistant', content: llmResponse });

      // 5. Parse the action
      const action = this.parseAction(llmResponse);
      if (!action) {
        console.log(`   [OCR] Step ${stepCount}: Failed to parse LLM response`);
        actionLog.push({ action: 'parse_error', description: 'Could not parse LLM response' });
        continue;
      }

      // 6. Execute the action
      console.log(`   [OCR] Step ${stepCount}: ${action.action} — ${this.describeAction(action)}`);
      actionLog.push({ action: action.action, description: this.describeAction(action) });

      if (action.action === 'done') {
        return {
          handled: true,
          success: true,
          description: `OCR Reasoner completed: ${action.evidence}`,
          steps: stepCount,
          actionLog,
        };
      }

      if (action.action === 'cannot_read') {
        cannotReadCount++;
        if (cannotReadCount >= CANNOT_READ_RETRIES) {
          return {
            handled: false,
            success: false,
            description: `OCR cannot read UI: ${action.reason}`,
            steps: stepCount,
            fallbackReason: 'cannot_read',
            actionLog,
          };
        }
        // Retry — maybe the screen changed
        await new Promise(r => setTimeout(r, SETTLE_MS));
        continue;
      }

      try {
        await this.executeAction(action);
      } catch (err: any) {
        console.error(`   [OCR] Action failed: ${err.message}`);
        actionLog.push({ action: 'error', description: `Action failed: ${err.message}` });
      }

      // Wait for UI to settle
      await new Promise(r => setTimeout(r, SETTLE_MS));
    }

    // Exceeded max steps
    return {
      handled: false,
      success: false,
      description: `OCR Reasoner exhausted ${MAX_OCR_STEPS} steps without completing`,
      steps: stepCount,
      actionLog,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Build the UI snapshot string from OCR results + a11y tree.
   */
  private buildSnapshot(
    ocrResult: OcrResult,
    a11ySnippet: string,
    actionLog: Array<{ action: string; description: string }>,
    task: string,
    priorContext?: string[],
  ): string {
    // Group OCR elements by line for readability
    const lines = new Map<number, OcrElement[]>();
    for (const el of ocrResult.elements) {
      const lineEls = lines.get(el.line) ?? [];
      lineEls.push(el);
      lines.set(el.line, lineEls);
    }

    const ocrLines: string[] = [];
    for (const [_lineIdx, lineEls] of [...lines.entries()].sort((a, b) => a[0] - b[0])) {
      const parts = lineEls
        .sort((a, b) => a.x - b.x)
        .map(el => `(${el.x},${el.y},${el.width}x${el.height}) "${el.text}"`);
      ocrLines.push(parts.join(' | '));
    }

    const ocrText = ocrLines.length > 0
      ? ocrLines.join('\n')
      : '(no text detected — screen may be blank or contain only images)';

    // Build action history string
    const historyStr = actionLog.length > 0
      ? `\n=== ACTIONS TAKEN SO FAR ===\n${actionLog.map((a, i) => `${i + 1}. ${a.action}: ${a.description}`).join('\n')}`
      : '';

    // Prior context from earlier pipeline stages
    const contextStr = priorContext?.length
      ? `\n=== PRIOR CONTEXT ===\n${priorContext.join('\n')}`
      : '';

    return `=== TASK ===
${task}
${contextStr}
=== SCREEN SNAPSHOT (OCR — coordinates in real screen pixels) ===
${ocrText}
${a11ySnippet}
${historyStr}

What is the SINGLE NEXT ACTION to accomplish this task? Respond with JSON only.`;
  }

  /**
   * Call the text LLM (layer2 config — cheap model like Haiku/GPT-4o-mini).
   */
  private async callTextLLM(messages: Array<{ role: string; content: string }>): Promise<string> {
    const { model, baseUrl } = this.pipelineConfig.layer2;
    const apiKey = this.pipelineConfig.apiKey || '';

    // Use OpenAI-compatible chat completions API
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.pipelineConfig.provider.openaiCompat) {
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      // Anthropic — use their auth format
      const authHeaders = this.pipelineConfig.provider.authHeader(apiKey);
      Object.assign(headers, authHeaders);
    }

    // For Anthropic, use the Messages API format
    if (!this.pipelineConfig.provider.openaiCompat) {
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 500,
          system: messages[0].content,
          messages: messages.slice(1).map(m => ({
            role: m.role === 'system' ? 'user' : m.role,
            content: m.content,
          })),
          temperature: 0,
        }),
      });

      const data: any = await response.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      return data.content?.[0]?.text || '';
    }

    // OpenAI-compatible
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: 500,
      }),
    });

    const data: any = await response.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Parse an OcrAction from the LLM response string.
   */
  private parseAction(response: string): OcrAction | null {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.action) return null;

      return parsed as OcrAction;
    } catch {
      return null;
    }
  }

  /**
   * Execute a single OcrAction via NativeDesktop.
   * Coordinates are in real screen pixels — no scaling needed.
   */
  private async executeAction(action: OcrAction): Promise<void> {
    switch (action.action) {
      case 'click':
        await this.desktop.mouseClick(action.x, action.y);
        this.a11y.invalidateCache();
        this.ocr.invalidateCache();
        break;

      case 'type':
        // Use clipboard paste for reliability
        await this.a11y.writeClipboard(action.text);
        await new Promise(r => setTimeout(r, 50));
        await this.desktop.keyPress('ctrl+v');
        await new Promise(r => setTimeout(r, 100));
        this.a11y.invalidateCache();
        this.ocr.invalidateCache();
        break;

      case 'key':
        await this.desktop.keyPress(action.key);
        this.a11y.invalidateCache();
        this.ocr.invalidateCache();
        break;

      case 'scroll':
        const delta = action.direction === 'down' ? action.amount : -action.amount;
        await this.desktop.mouseScroll(action.x, action.y, delta);
        this.ocr.invalidateCache();
        break;

      case 'wait':
        await new Promise(r => setTimeout(r, action.ms));
        this.ocr.invalidateCache();
        break;

      case 'done':
      case 'cannot_read':
        // No execution needed — handled by caller
        break;
    }
  }

  /**
   * Human-readable description of an action.
   */
  private describeAction(action: OcrAction): string {
    switch (action.action) {
      case 'click': return `${action.description} at (${action.x},${action.y})`;
      case 'type': return `${action.description}: "${action.text.substring(0, 50)}"`;
      case 'key': return `${action.description}: ${action.key}`;
      case 'scroll': return `Scroll ${action.direction} ${action.amount} at (${action.x},${action.y})`;
      case 'wait': return `Wait ${action.ms}ms: ${action.reason}`;
      case 'done': return `Done: ${action.evidence}`;
      case 'cannot_read': return `Cannot read: ${action.reason}`;
    }
  }
}
