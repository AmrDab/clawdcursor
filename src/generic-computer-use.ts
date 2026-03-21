/**
 * Generic Computer Use — Universal L3 Vision Fallback
 *
 * Implements the same screenshot → action → screenshot loop as the
 * Anthropic Computer Use adapter, but using OpenAI function-calling
 * format so it works with ANY vision-capable provider:
 *   OpenAI (gpt-4o, gpt-4o-mini)
 *   Google Gemini (via OpenAI-compat endpoint)
 *   Groq (llama-3.2-90b-vision-preview)
 *   Together AI, DeepSeek, Ollama, and any OpenAI-compat provider
 *
 * The LLM is given one tool: `desktop_action` with a discriminated
 * union of action types. It calls the tool with a structured action,
 * we execute it, take another screenshot, and repeat.
 *
 * When the LLM returns { action: "done" } the loop ends.
 */

import os from 'os';
import { NativeDesktop } from './native-desktop';
import { AccessibilityBridge } from './accessibility';
import { SafetyLayer, } from './safety';
import { SafetyTier } from './types';
import { normalizeKeyCombo } from './keys';
import type { ClawdConfig, StepResult } from './types';
import { supportsOpenAiToolCalls, type PipelineConfig } from './providers';
import type { TaskLogger } from './task-logger';
import type { TaskVerifier } from './verifiers';

const MAX_ITERATIONS = 25;
const IS_MAC = os.platform() === 'darwin';
const LLM_TARGET_WIDTH = 1280;

// ── OpenAI function-calling tool definition ───────────────────────────────────

const DESKTOP_ACTION_TOOL = {
  type: 'function' as const,
  function: {
    name: 'desktop_action',
    description: 'Execute a desktop action (click, type, key press, scroll, screenshot, or done). Call this tool to interact with the desktop.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'click', 'double_click', 'right_click', 'type', 'key', 'scroll', 'move', 'drag', 'done', 'wait'],
          description: 'The action to perform.',
        },
        x: { type: 'number', description: 'X coordinate in screenshot space (0 to image width). Required for click/double_click/right_click/move/scroll/drag.' },
        y: { type: 'number', description: 'Y coordinate in screenshot space (0 to image height). Required for click/double_click/right_click/move/scroll/drag.' },
        end_x: { type: 'number', description: 'End X coordinate for drag action.' },
        end_y: { type: 'number', description: 'End Y coordinate for drag action.' },
        text: { type: 'string', description: 'Text to type. Required for action=type.' },
        key: { type: 'string', description: 'Key or combo to press (e.g. "Return", "ctrl+c", "alt+F4"). Required for action=key.' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction. Default: down.' },
        amount: { type: 'number', description: 'Scroll amount in ticks (1-10). Default: 3.' },
        reason: { type: 'string', description: 'For action=done: explain what was accomplished. For action=wait: why waiting.' },
        wait_ms: { type: 'number', description: 'For action=wait: milliseconds to wait (100-5000).' },
      },
      required: ['action'],
    },
  },
};

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a desktop automation agent. You control a computer by calling the desktop_action tool.

WORKFLOW:
1. Call desktop_action with action="screenshot" to see the current screen.
2. Based on what you see, call desktop_action with the appropriate action.
3. After each action that changes screen state (click, type, key), take another screenshot to verify.
4. When the task is complete, call desktop_action with action="done" and explain what you accomplished.

RULES:
- ALWAYS start with action="screenshot" to orient yourself.
- Take a screenshot after: opening apps, clicking buttons, typing text, navigating.
- Batch predictable actions WITHOUT screenshots in between (e.g. type then press Return).
- Coordinates are in screenshot-image space — I will scale them to the real screen for you.
- Use keyboard shortcuts when faster: ${IS_MAC ? 'Cmd+C copy, Cmd+V paste, Cmd+Space Spotlight, Cmd+Tab switch apps' : 'Ctrl+C copy, Ctrl+V paste, Win search, Alt+Tab switch apps'}.
- To open an app: press ${IS_MAC ? 'Cmd+Space' : 'the Windows key'}, type the app name, press Return.
- If an action doesn't work, try a different approach — don't repeat the exact same action.
- If the screen hasn't changed after an action, wait briefly and try again or use a different method.
- NEVER call done unless you can see clear evidence the task is complete in the screenshot.

PLATFORM: ${IS_MAC ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'}`;

// ── Result types ──────────────────────────────────────────────────────────────

export interface GenericComputerUseResult {
  success: boolean;
  steps: StepResult[];
  llmCalls: number;
}

// ── Provider capability check ─────────────────────────────────────────────────

/**
 * Returns true if the given provider/model can be used for generic Computer Use.
 * Requires: OpenAI-compat API + a vision-capable model.
 */
export function isGenericComputerUseSupported(
  config: ClawdConfig,
  pipelineConfig?: PipelineConfig | null,
): boolean {
  // Anthropic has its own native CU — don't use generic for it
  if (config.ai.provider === 'anthropic' && !config.ai.visionBaseUrl) return false;
  if (pipelineConfig?.provider && !pipelineConfig.provider.openaiCompat) return false;
  if (pipelineConfig?.provider && !supportsOpenAiToolCalls(pipelineConfig.provider)) return false;

  // Need a vision model
  const visionModel = pipelineConfig?.layer3?.model || config.ai.visionModel;
  if (!visionModel) return false;

  // Need an API key
  const visionKey = pipelineConfig?.layer3?.apiKey || pipelineConfig?.apiKey || config.ai.visionApiKey || config.ai.apiKey;
  if (!visionKey) return false;

  return true;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class GenericComputerUse {
  private llmWidth = LLM_TARGET_WIDTH;
  private llmHeight = 720;
  private verifier: TaskVerifier | null = null;

  constructor(
    private config: ClawdConfig,
    private desktop: NativeDesktop,
    private a11y: AccessibilityBridge,
    private safety: SafetyLayer,
    private pipelineConfig?: PipelineConfig | null,
  ) {
    const size = this.desktop.getScreenSize();
    const scale = size.width > LLM_TARGET_WIDTH ? size.width / LLM_TARGET_WIDTH : 1;
    this.llmWidth = LLM_TARGET_WIDTH;
    this.llmHeight = Math.round(size.height / scale);
  }

  setVerifier(v: TaskVerifier) {
    this.verifier = v;
  }

  /**
   * Execute a subtask using the generic vision loop.
   */
  async executeSubtask(
    subtask: string,
    debugDir: string | null,
    subtaskIndex: number,
    priorSteps?: string[],
    logger?: TaskLogger,
  ): Promise<GenericComputerUseResult> {
    const steps: StepResult[] = [];
    let llmCalls = 0;

    // Build initial context message
    let userMessage = subtask;
    if (priorSteps && priorSteps.length > 0) {
      userMessage =
        `CONTEXT — These steps were already completed:\n` +
        priorSteps.map((s, i) => `${i + 1}. ${s}`).join('\n') +
        `\n\nThe relevant app may already be open. Start with a screenshot to orient yourself.\n\nYOUR TASK: ${subtask}`;
    }

    const messages: any[] = [{ role: 'user', content: userMessage }];
    const actionHistory: string[] = [];
    let consecutiveScreenshots = 0;

    console.log(`   🌐 Generic L3: "${subtask.substring(0, 80)}${subtask.length > 80 ? '...' : ''}"`);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if ((this.config as any)._aborted) break;

      // ── Call the vision LLM ───────────────────────────────────────────────
      llmCalls++;
      const response = await this.callVisionLLM(messages);

      if (response.error) {
        console.warn(`   ⚠️ Generic CU API error: ${response.error}`);
        steps.push({ action: 'error', description: `Vision LLM error: ${response.error}`, success: false, timestamp: Date.now() });
        break;
      }

      // Parse tool call from response
      const toolCall = this.extractToolCall(response);
      if (!toolCall) {
        // No tool call — LLM returned prose. Add it to context and ask again.
        const text = this.extractText(response);
        if (text) {
          messages.push({ role: 'assistant', content: text });
          messages.push({ role: 'user', content: 'Please use the desktop_action tool to perform the next action.' });
        } else {
          steps.push({ action: 'error', description: 'LLM returned no tool call and no text', success: false, timestamp: Date.now() });
          break;
        }
        continue;
      }

      const { action, args } = toolCall;

      // ── Handle tool call ─────────────────────────────────────────────────
      if (action === 'done') {
        const reason = args.reason || 'Task complete';
        console.log(`   ✅ Generic L3 done: ${reason}`);

        // Ground truth verification
        if (this.verifier) {
          const vResult = await this.verifier.verify(subtask, () => this.a11y.readClipboard()).catch(() => null);
          if (vResult && !vResult.pass && steps.length > 0) {
            console.log(`   🚫 Generic L3 blocked done — verifier: ${vResult.detail}`);
            // Feed the failure back to the LLM
            messages.push(this.buildAssistantToolMessage(response, toolCall.rawCall));
            messages.push(this.buildToolResult(toolCall.id, `VERIFICATION FAILED: ${vResult.detail}. The task is NOT complete. Continue working.`));
            continue;
          }
        }

        steps.push({ action: 'done', description: reason, success: true, timestamp: Date.now() });
        logger?.logStep({ layer: 3, actionType: 'done', result: 'success', llmReasoning: reason.substring(0, 200) });
        return { success: true, steps, llmCalls };
      }

      if (action === 'screenshot') {
        consecutiveScreenshots++;
        if (consecutiveScreenshots > 3) {
          // LLM is stuck in a screenshot loop
          messages.push(this.buildAssistantToolMessage(response, toolCall.rawCall));
          messages.push(this.buildToolResult(toolCall.id, 'You have taken multiple screenshots without acting. Based on what you see, take the next action now — do not take another screenshot yet.'));
          continue;
        }

        const screenshot = await this.desktop.captureForLLM();
        const a11yTree = await this.a11y.getScreenContext().catch(() => '') ?? '';
        const screenshotResult = this.buildScreenshotResult(screenshot, a11yTree);

        messages.push(this.buildAssistantToolMessage(response, toolCall.rawCall));
        messages.push(this.buildToolResult(toolCall.id, screenshotResult));

        if (debugDir) {
          require('fs').promises.writeFile(
            require('path').join(debugDir, `generic-cu-${subtaskIndex}-${i}.png`),
            screenshot.buffer,
          ).catch(() => {});
        }
        continue;
      }

      // Reset consecutive screenshot counter for any real action
      consecutiveScreenshots = 0;

      if (action === 'wait') {
        const waitMs = Math.min(Math.max(args.wait_ms ?? 1000, 100), 5000);
        await this.delay(waitMs);
        messages.push(this.buildAssistantToolMessage(response, toolCall.rawCall));
        messages.push(this.buildToolResult(toolCall.id, `Waited ${waitMs}ms.`));
        continue;
      }

      // ── Execute desktop action ────────────────────────────────────────────
      const scaleFactor = await this.getScaleFactor();
      const actionDesc = this.describeAction(action, args);
      actionHistory.push(actionDesc);

      // Safety check
      const safetyAction = this.buildSafetyAction(action, args, scaleFactor);
      const tier = safetyAction ? this.safety.classify(safetyAction, actionDesc) : SafetyTier.Auto;

      if (tier === SafetyTier.Confirm && this.safety.isBlocked(actionDesc)) {
        steps.push({ action: 'blocked', description: `Blocked: ${actionDesc}`, success: false, timestamp: Date.now() });
        messages.push(this.buildAssistantToolMessage(response, toolCall.rawCall));
        messages.push(this.buildToolResult(toolCall.id, `BLOCKED: This action is not allowed. Choose a different approach.`));
        continue;
      }

      // Execute
      let execResult: string;
      try {
        execResult = await this.executeAction(action, args, scaleFactor);
        steps.push({ action, description: actionDesc, success: true, timestamp: Date.now() });
        logger?.logStep({ layer: 3, actionType: action, result: 'success' });

        // Brief settle delay after state-changing actions
        if (['click', 'double_click', 'right_click', 'key'].includes(action)) {
          await this.delay(200);
        }
      } catch (err) {
        execResult = `Error: ${String(err).substring(0, 150)}`;
        steps.push({ action, description: `Failed: ${actionDesc} — ${execResult}`, success: false, timestamp: Date.now() });
      }

      messages.push(this.buildAssistantToolMessage(response, toolCall.rawCall));
      messages.push(this.buildToolResult(toolCall.id, execResult));
    }

    // Hit iteration limit
    console.log(`   ⚠️ Generic L3: iteration limit reached`);
    return { success: false, steps, llmCalls };
  }

  // ── Vision LLM call ───────────────────────────────────────────────────────

  private async callVisionLLM(messages: any[]): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const visionModel = this.pipelineConfig?.layer3?.model || this.config.ai.visionModel;
      const visionKey = this.pipelineConfig?.layer3?.apiKey || this.pipelineConfig?.apiKey || this.config.ai.visionApiKey || this.config.ai.apiKey;
      const visionBaseUrl = (
        this.pipelineConfig?.layer3?.baseUrl ||
        this.config.ai.visionBaseUrl ||
        this.config.ai.baseUrl ||
        'https://api.openai.com/v1'
      ).replace(/\/+$/, '');

      const response = await fetch(`${visionBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${visionKey}`,
          ...(this.pipelineConfig?.provider?.extraHeaders || {}),
        },
        body: JSON.stringify({
          model: visionModel,
          max_tokens: 1024,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...messages,
          ],
          tools: [DESKTOP_ACTION_TOOL],
          // Don't set tool_choice: 'required' — incompatible with providers
          // that have thinking/reasoning enabled (Kimi, Claude, etc.).
          // The system prompt instructs the model to always call the tool.
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const data = await response.json() as any;

      if (!response.ok) {
        const msg = data?.error?.message || `HTTP ${response.status}`;
        return { error: msg };
      }

      return data;
    } catch (err) {
      clearTimeout(timeout);
      return { error: String(err) };
    }
  }

  // ── Message building ──────────────────────────────────────────────────────

  private buildScreenshotResult(
    screenshot: { buffer: Buffer; llmWidth: number; llmHeight: number; scaleFactor: number },
    a11yTree: string,
  ): any {
    const base64 = screenshot.buffer.toString('base64');
    // Use low detail for models with small context windows (≤32K) to reduce image tokens
    const visionModel = this.pipelineConfig?.layer3?.model || this.config.ai.visionModel;
    const isSmallContext = visionModel.includes('32k') || visionModel.includes('8k');
    const content: any[] = [
      {
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${base64}`,
          ...(isSmallContext ? { detail: 'low' } : {}),
        },
      },
    ];
    if (a11yTree && a11yTree.trim()) {
      const treeLimit = isSmallContext ? 500 : 2000;
      content.push({
        type: 'text',
        text: `Screen: ${screenshot.llmWidth}×${screenshot.llmHeight} (scale ${screenshot.scaleFactor.toFixed(2)}x)\nAccessibility tree:\n${a11yTree.substring(0, treeLimit)}`,
      });
    } else {
      content.push({
        type: 'text',
        text: `Screen: ${screenshot.llmWidth}×${screenshot.llmHeight} (scale ${screenshot.scaleFactor.toFixed(2)}x). Coordinates are in screenshot space.`,
      });
    }
    return content;
  }

  private buildAssistantToolMessage(response: any, rawCall: any): any {
    const choice = response?.choices?.[0];
    const msg: any = {
      role: 'assistant',
      content: choice?.message?.content ?? null,
      tool_calls: [rawCall],
    };
    // Preserve reasoning_content for providers with thinking mode (Kimi, etc.)
    // Without this, the API rejects replayed messages with:
    // "thinking is enabled but reasoning_content is missing"
    if (choice?.message?.reasoning_content !== undefined) {
      msg.reasoning_content = choice.message.reasoning_content;
    }
    return msg;
  }

  private buildToolResult(toolCallId: string, result: any): any {
    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content: typeof result === 'string' ? result : JSON.stringify(result),
    };
  }

  // ── Tool call extraction ──────────────────────────────────────────────────

  private extractToolCall(response: any): { id: string; action: string; args: any; rawCall: any } | null {
    const choice = response?.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;
    if (!toolCalls || toolCalls.length === 0) return null;

    const call = toolCalls[0];
    if (call.function?.name !== 'desktop_action') return null;

    try {
      const args = JSON.parse(call.function.arguments || '{}');
      return { id: call.id, action: args.action, args, rawCall: call };
    } catch {
      return null;
    }
  }

  private extractText(response: any): string | null {
    return response?.choices?.[0]?.message?.content || null;
  }

  // ── Action execution ──────────────────────────────────────────────────────

  private async getScaleFactor(): Promise<number> {
    const size = this.desktop.getScreenSize();
    return size.width > LLM_TARGET_WIDTH ? size.width / LLM_TARGET_WIDTH : 1;
  }

  private scaleCoord(val: number, scale: number): number {
    return Math.round(val * scale);
  }

  private async executeAction(action: string, args: any, scale: number): Promise<string> {
    const x = args.x != null ? this.scaleCoord(args.x, scale) : 0;
    const y = args.y != null ? this.scaleCoord(args.y, scale) : 0;

    switch (action) {
      case 'click':
        await this.desktop.executeMouseAction({ kind: 'click', x, y });
        return `Clicked at (${args.x}, ${args.y})`;

      case 'double_click':
        await this.desktop.executeMouseAction({ kind: 'double_click', x, y });
        return `Double-clicked at (${args.x}, ${args.y})`;

      case 'right_click':
        await this.desktop.executeMouseAction({ kind: 'right_click', x, y });
        return `Right-clicked at (${args.x}, ${args.y})`;

      case 'move':
        await this.desktop.executeMouseAction({ kind: 'move', x, y });
        return `Moved mouse to (${args.x}, ${args.y})`;

      case 'scroll': {
        const direction = args.direction ?? 'down';
        const amount = Math.min(Math.max(args.amount ?? 3, 1), 10);
        const scrollDelta = direction === 'up' || direction === 'left' ? -amount : amount;
        await this.desktop.executeMouseAction({ kind: 'scroll', x, y, scrollDelta });
        return `Scrolled ${direction} ${amount} ticks at (${args.x}, ${args.y})`;
      }

      case 'drag': {
        const ex = args.end_x != null ? this.scaleCoord(args.end_x, scale) : x;
        const ey = args.end_y != null ? this.scaleCoord(args.end_y, scale) : y;
        await this.desktop.executeMouseAction({ kind: 'drag', x, y, endX: ex, endY: ey });
        return `Dragged from (${args.x}, ${args.y}) to (${args.end_x}, ${args.end_y})`;
      }

      case 'type':
        await this.desktop.executeKeyboardAction({ kind: 'type', text: args.text ?? '' });
        return `Typed "${(args.text ?? '').substring(0, 60)}${(args.text ?? '').length > 60 ? '...' : ''}"`;

      case 'key': {
        const combo = normalizeKeyCombo(args.key ?? '');
        await this.desktop.executeKeyboardAction({ kind: 'key_press', key: combo });
        return `Pressed key "${args.key}"`;
      }

      default:
        return `Unknown action: ${action}`;
    }
  }

  private buildSafetyAction(action: string, args: any, scale: number): any | null {
    const x = args.x != null ? this.scaleCoord(args.x, scale) : 0;
    const y = args.y != null ? this.scaleCoord(args.y, scale) : 0;
    if (action === 'type') return { kind: 'type', text: args.text ?? '' };
    if (action === 'click') return { kind: 'click', x, y };
    if (action === 'key') return { kind: 'key_press', key: args.key ?? '' };
    return null;
  }

  private describeAction(action: string, args: any): string {
    switch (action) {
      case 'click': return `Click at (${args.x}, ${args.y})`;
      case 'double_click': return `Double-click at (${args.x}, ${args.y})`;
      case 'right_click': return `Right-click at (${args.x}, ${args.y})`;
      case 'type': return `Type "${(args.text ?? '').substring(0, 60)}"`;
      case 'key': return `Key "${args.key}"`;
      case 'scroll': return `Scroll ${args.direction ?? 'down'} at (${args.x}, ${args.y})`;
      case 'drag': return `Drag (${args.x},${args.y})→(${args.end_x},${args.end_y})`;
      case 'wait': return `Wait ${args.wait_ms ?? 1000}ms`;
      default: return action;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
