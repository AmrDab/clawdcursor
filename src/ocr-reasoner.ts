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
import { AccessibilityBridge, type UIElement } from './accessibility';
import { callTextLLM } from './llm-client';
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

OCR ELEMENT FORMAT: Elements have [ID] prefixes — you can reference them by ID. Format:
  [ID] (x,y,wxh) "text"             — standard element
  [ID] (x,y,wxh,conf:0.85) "text"   — elements with conf:<value> show OCR confidence (lower = less certain)
  [ID] (x,y,wxh,Button) "text"      — elements tagged with control types (Button, Edit, CheckBox, etc.) are interactive UI elements identified from the accessibility tree

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
7. If an accessibility tree is provided, use it for semantic context (button roles, field labels)
8. Elements with control type tags (Button, Edit, etc.) are clickable/interactive — prefer clicking these over plain text`;

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
      console.log(`   [OCR] Scan: ${ocrResult.elements.length} elements in ${ocrResult.durationMs}ms, top: "${ocrResult.elements[0]?.text || 'none'}"`);

      // 2. Optionally read a11y tree for semantic context
      let a11ySnippet = '';
      let a11yElements: UIElement[] = [];
      try {
        const activeWin = await this.a11y.getActiveWindow().catch(() => null);
        if (activeWin) {
          // Get text tree for LLM context
          const tree = await this.a11y.getScreenContext(activeWin.processId).catch(() => null);
          if (tree) {
            a11ySnippet = `\n=== A11Y TREE (${activeWin.processName}: ${activeWin.title}) ===\n${tree.substring(0, 2000)}`;
          }
          // Get structured elements for OCR-a11y cross-reference
          const elements = await this.a11y.findElement({ processId: activeWin.processId }).catch(() => []);
          a11yElements = (Array.isArray(elements) ? elements : []).map(el => ({
            name: el.name || '',
            automationId: el.automationId || '',
            controlType: el.controlType || '',
            className: el.className || '',
            bounds: el.bounds || { x: 0, y: 0, width: 0, height: 0 },
          }));
        }
      } catch { /* non-fatal — OCR is the primary source */ }

      // 3. Build the UI snapshot string
      const snapshot = this.buildSnapshot(ocrResult, a11ySnippet, a11yElements, actionLog, task, priorContext);

      // 4. Ask the text LLM for the next action
      messages.push({ role: 'user', content: snapshot });

      let llmResponse: string;
      try {
        llmResponse = await this.callOcrLLM(messages);
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

      console.log(`   [OCR] LLM response: ${llmResponse.substring(0, 200)}`);
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
    a11yElements: UIElement[],
    actionLog: Array<{ action: string; description: string }>,
    task: string,
    priorContext?: string[],
  ): string {
    // Group OCR elements by line for readability, assign sequential element IDs
    let elementId = 0;
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
        .map(el => {
          const id = elementId++;
          const conf = el.confidence < 1.0 ? `,conf:${el.confidence.toFixed(2)}` : '';
          // Find matching a11y element by bounding box overlap
          const a11yMatch = this.findA11yMatch(el, a11yElements);
          const typeTag = a11yMatch ? `,${a11yMatch}` : '';
          return `[${id}] (${el.x},${el.y},${el.width}x${el.height}${conf}${typeTag}) "${el.text}"`;
        });
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
   * Find an a11y element whose bounding box overlaps with an OCR element's center.
   * Returns a short control type name (e.g. "Button") or null if no match / not useful.
   */
  private findA11yMatch(el: OcrElement, a11yElements: UIElement[]): string | null {
    const elCx = el.x + el.width / 2;
    const elCy = el.y + el.height / 2;

    for (const a11y of a11yElements) {
      const b = a11y.bounds;
      if (elCx >= b.x && elCx <= b.x + b.width && elCy >= b.y && elCy <= b.y + b.height) {
        // Extract short type name: "ControlType.Button" -> "Button"
        const shortType = a11y.controlType.replace('ControlType.', '');
        // Skip generic types that don't add useful info
        if (shortType !== 'Text' && shortType !== 'Pane' && shortType !== 'Custom') {
          return shortType;
        }
      }
    }
    return null;
  }

  /**
   * Call the text LLM (layer2 config — cheap model like Haiku/GPT-4o-mini).
   * Uses shared llm-client with multi-turn message support.
   */
  private async callOcrLLM(messages: Array<{ role: string; content: string }>): Promise<string> {
    return callTextLLM(this.pipelineConfig, {
      messages,
      timeoutMs: 15000,
    });
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
