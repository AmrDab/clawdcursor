/**
 * AI Brain — sends screenshots to a vision LLM and gets back
 * structured actions. Maintains conversation history so the AI
 * remembers what it saw and did.
 *
 * v2: Task Decomposition + Smart Screenshot
 * - decomposeTask(): ONE LLM call to break task into subtasks
 * - decideNextAction(): now accepts resized screenshots with scale factor
 * - System prompt updated to tell AI about coordinate scaling
 */

import type { ClawdConfig, InputAction, ActionSequence, ScreenFrame } from './types';

const SYSTEM_PROMPT = `You are Clawd Cursor, an AI desktop agent controlling a Windows 11 computer via VNC.
Real screen resolution: {REAL_WIDTH}x{REAL_HEIGHT}. Screenshot shown at: {LLM_WIDTH}x{LLM_HEIGHT} (scale factor: {SCALE}x).

IMPORTANT: All coordinates you provide should be in the SCREENSHOT coordinate space ({LLM_WIDTH}x{LLM_HEIGHT}).
The system will automatically scale them to real screen coordinates.

WINDOWS 11 LAYOUT:
- Taskbar at BOTTOM, icons CENTERED (not left-aligned)
- Start button (Windows logo) is in the CENTER of the taskbar
- System tray (clock, icons) is bottom-RIGHT
- Default Chrome has tabs at top, address bar below tabs

RESPONSE FORMAT — respond with ONLY valid JSON, no other text:

SINGLE ACTION (most cases):
{"kind": "click", "x": 640, "y": 710, "description": "Click Start button in center of taskbar"}
{"kind": "double_click", "x": 100, "y": 200, "description": "Open file"}
{"kind": "type", "text": "hello", "description": "Type greeting"}
{"kind": "key_press", "key": "Return", "description": "Press Enter"}
{"kind": "key_press", "key": "Super", "description": "Press Windows key"}
{"kind": "key_press", "key": "ctrl+a", "description": "Select all"}

SEQUENCE (for predictable multi-step flows like filling forms):
{"kind": "sequence", "description": "Fill email form", "steps": [
  {"kind": "click", "x": 400, "y": 200, "description": "Click To field"},
  {"kind": "type", "text": "user@email.com", "description": "Type recipient"},
  {"kind": "key_press", "key": "Tab", "description": "Move to subject"}
]}

COMPLETION:
{"kind": "done", "description": "Task completed — email sent"}

ERROR:
{"kind": "error", "description": "Cannot proceed because X"}

ACCESSIBILITY ACTION (use when element name/ID is in the accessibility tree — PREFERRED over click coordinates):
{"kind": "a11y_click", "name": "Compose", "controlType": "Button", "description": "Click Compose button via accessibility"}
{"kind": "a11y_set_value", "name": "To", "controlType": "Edit", "value": "user@email.com", "description": "Set To field value"}
{"kind": "a11y_focus", "name": "Subject", "controlType": "Edit", "description": "Focus the Subject field"}

WAIT (for loading):
{"kind": "wait", "description": "Waiting for page to load", "waitMs": 2000}

CRITICAL RULES:
1. BEFORE acting, check: has the task ALREADY BEEN COMPLETED based on previous steps? If yes → done
2. ONE JSON response only. Use "sequence" for predictable multi-step flows
3. Coordinates should be in the SCREENSHOT space ({LLM_WIDTH}x{LLM_HEIGHT}), NOT real screen space
4. NEVER repeat an action that was already performed in previous steps
5. If you typed text and it appeared, that step is DONE — move to the next part of the task
6. Track progress: if you've done steps A, B, C of a task, do step D next — don't restart
7. Use sequences for form-filling to avoid re-screenshotting between each field
8. PREFER accessibility actions (a11y_*) over pixel coordinates when the accessibility tree provides element info
9. Accessibility actions are faster and more reliable than clicking coordinates`;

const DECOMPOSE_SYSTEM_PROMPT = `You decompose desktop tasks into simple sub-tasks.
Return ONLY a JSON array of strings. Each string is a simple, atomic action.

SUPPORTED COMMANDS (the action router parses these):
- "open [app]"          → launches via Start Menu
- "type [text]"         → types text (auto-prepares canvas apps like Paint)
- "click [element]"     → clicks UI element via accessibility
- "go to [url]"         → navigates browser to URL
- "press [key]"         → key press (enter, escape, ctrl+s, etc.)
- "focus [app/window]"  → brings window to front
- "close [app]"         → closes the app

Rules:
- Each sub-task = ONE atomic action
- Keep it minimal — the router handles app-specific preparation internally
- Do NOT manually add tool selection or canvas clicks for typing — "type" handles it
- Only use "click" for UI navigation (menus, dialogs, buttons)
- For URLs, always use "go to [url]" — not "type [url]" into the address bar
- For visual/spatial tasks (drawing, dragging, arranging) that need mouse coordinates,
  keep them as a SINGLE descriptive subtask — do NOT break them into click/type.
  These will be handled by AI vision, not the router.

Examples:
Task: "Open Paint and type hello world"
["open Paint", "type hello world"]

Task: "Open Paint and draw a stick figure"
["open Paint", "draw a stick figure on the canvas"]

Task: "Open Chrome and go to google.com"
["open Chrome", "go to google.com"]

Task: "Open Chrome, go to github.com, and search for clawd-cursor"
["open Chrome", "go to github.com", "click search", "type clawd-cursor", "press enter"]

Task: "Save the current document as PDF"
["click File menu", "click Save As", "click PDF", "click Save"]

Task: "Open Notepad and type hello"
["open Notepad", "type hello"]

Task: "Drag the file to the trash"
["drag the file to the trash"]

Task: "Type hello"
["type hello"]`;

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: any;
}

export class AIBrain {
  private config: ClawdConfig;
  private history: ConversationTurn[] = [];
  private screenWidth: number = 0;
  private screenHeight: number = 0;
  private maxHistoryTurns = 5;

  constructor(config: ClawdConfig) {
    this.config = config;
  }

  setScreenSize(width: number, height: number) {
    this.screenWidth = width;
    this.screenHeight = height;
  }

  /**
   * Decompose a complex task into simple sub-tasks via ONE LLM call.
   * This is a text-only call (no screenshot) — fast and cheap.
   */
  async decomposeTask(task: string): Promise<string[]> {
    try {
      const response = await this.callLLMText(DECOMPOSE_SYSTEM_PROMPT, `Task: "${task}"`);
      const match = response.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((s: any) => typeof s === 'string')) {
          return parsed;
        }
      }
      // If parsing failed, return the whole task as a single subtask
      console.warn(`⚠️ Failed to parse decomposition, using task as-is`);
      return [task];
    } catch (err) {
      console.warn(`⚠️ Decomposition failed (${err}), using task as-is`);
      return [task];
    }
  }

  /**
   * Ask the LLM what to do next, using a RESIZED screenshot.
   * Coordinates in the response are in LLM-image space and will be
   * scaled back to real screen coordinates by the caller.
   */
  async decideNextAction(
    screenshot: ScreenFrame & { scaleFactor?: number; llmWidth?: number; llmHeight?: number },
    task: string,
    previousSteps: string[] = [],
    accessibilityContext?: string,
  ): Promise<{
    action: InputAction | null;
    sequence: ActionSequence | null;
    description: string;
    done: boolean;
    error?: string;
    waitMs?: number;
  }> {
    const base64Image = screenshot.buffer.toString('base64');
    const mediaType = screenshot.format === 'jpeg' ? 'image/jpeg' : 'image/png';

    // Build user message
    let userMessage = `TASK: ${task}\n`;

    if (accessibilityContext) {
      userMessage += `\nACCESSIBILITY TREE (use element names/IDs for precise targeting):\n${accessibilityContext}\n`;
    }

    if (previousSteps.length > 0) {
      userMessage += `\nCOMPLETED STEPS (${previousSteps.length} so far):\n`;
      previousSteps.forEach((s, i) => {
        userMessage += `  ${i + 1}. ✅ ${s}\n`;
      });
      userMessage += `\nWhat is the NEXT step? If all steps are done, respond with {"kind":"done",...}`;
    } else {
      userMessage += `\nThis is the first step. What should I do first?`;
    }

    // Build the user turn with image
    const userTurn: ConversationTurn = {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Image,
          },
        },
        {
          type: 'text',
          text: userMessage,
        },
      ],
    };

    // Add to history
    this.history.push(userTurn);

    // Build system prompt with resolution info
    const llmWidth = screenshot.llmWidth || screenshot.width;
    const llmHeight = screenshot.llmHeight || screenshot.height;
    const scale = screenshot.scaleFactor || 1;

    const systemPrompt = SYSTEM_PROMPT
      .replace(/{REAL_WIDTH}/g, String(this.screenWidth))
      .replace(/{REAL_HEIGHT}/g, String(this.screenHeight))
      .replace(/{LLM_WIDTH}/g, String(llmWidth))
      .replace(/{LLM_HEIGHT}/g, String(llmHeight))
      .replace(/{SCALE}/g, scale.toFixed(2));

    const response = await this.callLLM(systemPrompt);

    // Add assistant response to history
    this.history.push({
      role: 'assistant',
      content: [{ type: 'text', text: response }],
    });

    // Trim history
    while (this.history.length > this.maxHistoryTurns * 2) {
      this.history.shift();
      this.history.shift();
    }

    // Parse and scale coordinates back to real screen space
    return this.parseResponse(response, scale);
  }

  private parseResponse(response: string, scaleFactor: number = 1): {
    action: InputAction | null;
    sequence: ActionSequence | null;
    description: string;
    done: boolean;
    error?: string;
    waitMs?: number;
  } {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { action: null, sequence: null, description: 'Failed to parse AI response', done: false, error: response };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (parsed.kind === 'done') {
        return { action: null, sequence: null, description: parsed.description || 'Task complete', done: true };
      }

      if (parsed.kind === 'error') {
        return { action: null, sequence: null, description: parsed.description, done: false, error: parsed.description };
      }

      if (parsed.kind === 'wait') {
        return { action: null, sequence: null, description: parsed.description, done: false, waitMs: parsed.waitMs || 2000 };
      }

      if (parsed.kind === 'sequence') {
        const seq: ActionSequence = {
          kind: 'sequence',
          steps: (parsed.steps || []).map((s: any) => this.scaleCoordinates(s, scaleFactor)),
          description: parsed.description || 'Multi-step sequence',
        };
        return { action: null, sequence: seq, description: seq.description, done: false };
      }

      // Single action — scale coordinates
      const action = this.scaleCoordinates(parsed, scaleFactor) as InputAction;
      return { action, sequence: null, description: parsed.description || 'Action', done: false };
    } catch (err) {
      return { action: null, sequence: null, description: 'Failed to parse action', done: false, error: `Parse error: ${err}\nRaw: ${response.substring(0, 200)}` };
    }
  }

  /**
   * Scale LLM coordinates back to real screen coordinates.
   */
  private scaleCoordinates(action: any, scaleFactor: number): any {
    if (scaleFactor === 1) return action;

    const scaled = { ...action };
    if (typeof scaled.x === 'number') scaled.x = Math.round(scaled.x * scaleFactor);
    if (typeof scaled.y === 'number') scaled.y = Math.round(scaled.y * scaleFactor);
    if (typeof scaled.endX === 'number') scaled.endX = Math.round(scaled.endX * scaleFactor);
    if (typeof scaled.endY === 'number') scaled.endY = Math.round(scaled.endY * scaleFactor);
    return scaled;
  }

  // ─── LLM Calls ────────────────────────────────────────────────────

  private async callLLM(systemPrompt: string): Promise<string> {
    const { provider, apiKey, visionModel } = this.config.ai;

    if (provider === 'anthropic') {
      return this.callAnthropic(systemPrompt, apiKey!, visionModel);
    } else if (provider === 'openai') {
      return this.callOpenAI(systemPrompt, apiKey!, visionModel);
    }

    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  /**
   * Text-only LLM call (no images). Used for task decomposition.
   */
  private async callLLMText(systemPrompt: string, userMessage: string): Promise<string> {
    const { provider, apiKey, model } = this.config.ai;

    const MAX_RETRIES = 2;

    if (provider === 'anthropic') {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          console.log(`   🔗 LLM text call (attempt ${attempt + 1}): model=${model}`);
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey!,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model,
              max_tokens: 512,
              system: systemPrompt,
              messages: [{ role: 'user', content: userMessage }],
            }),
          });

          const data = await response.json() as any;
          if (data.error) throw new Error(data.error.message || `Anthropic API error (${response.status})`);
          return data.content?.[0]?.text || '';
        } catch (err) {
          console.warn(`   ⚠️ LLM text call attempt ${attempt + 1} failed: ${err}`);
          if (attempt < MAX_RETRIES) {
            const backoff = 1000 * (attempt + 1);
            console.log(`   ⏳ Retrying in ${backoff}ms...`);
            await new Promise(r => setTimeout(r, backoff));
          } else {
            throw err;
          }
        }
      }
      throw new Error('LLM text call failed after retries');
    } else if (provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 512,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
      });

      const data = await response.json() as any;
      return data.choices?.[0]?.message?.content || '';
    }

    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  private async callAnthropic(
    systemPrompt: string,
    apiKey: string,
    model: string,
  ): Promise<string> {
    const messages = this.history.map(turn => ({
      role: turn.role,
      content: turn.content,
    }));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      }),
    });

    const data = await response.json() as any;
    if (data.error) {
      console.error('Anthropic API error:', data.error);
      throw new Error(data.error.message || 'Anthropic API error');
    }
    return data.content?.[0]?.text || '';
  }

  private async callOpenAI(
    systemPrompt: string,
    apiKey: string,
    model: string,
  ): Promise<string> {
    const messages: any[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const turn of this.history) {
      if (turn.role === 'user' && Array.isArray(turn.content)) {
        const content: any[] = [];
        for (const part of turn.content) {
          if (part.type === 'image') {
            content.push({
              type: 'image_url',
              image_url: {
                url: `data:${part.source.media_type};base64,${part.source.data}`,
              },
            });
          } else {
            content.push(part);
          }
        }
        messages.push({ role: 'user', content });
      } else if (turn.role === 'assistant') {
        const text = Array.isArray(turn.content)
          ? turn.content.map((c: any) => c.text || '').join('')
          : turn.content;
        messages.push({ role: 'assistant', content: text });
      }
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages,
      }),
    });

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || '';
  }

  resetConversation(): void {
    this.history = [];
  }
}
