/**
 * AI Brain — sends screenshots to a vision LLM and gets back
 * structured actions. Maintains conversation history so the AI
 * remembers what it saw and did.
 */

import type { ClawdConfig, InputAction, ActionSequence, ScreenFrame } from './types';

const SYSTEM_PROMPT = `You are Clawd Cursor, an AI desktop agent controlling a Windows 11 computer via VNC.
Screen resolution: {WIDTH}x{HEIGHT}. You see screenshots and execute mouse/keyboard actions.

WINDOWS 11 LAYOUT:
- Taskbar at BOTTOM, icons CENTERED (not left-aligned)
- Start button (Windows logo) is in the CENTER of the taskbar
- System tray (clock, icons) is bottom-RIGHT
- Default Chrome has tabs at top, address bar below tabs

RESPONSE FORMAT — respond with ONLY valid JSON, no other text:

SINGLE ACTION (most cases):
{"kind": "click", "x": 1280, "y": 1420, "description": "Click Start button in center of taskbar"}
{"kind": "double_click", "x": 100, "y": 200, "description": "Open file"}
{"kind": "type", "text": "hello", "description": "Type greeting"}
{"kind": "key_press", "key": "Return", "description": "Press Enter"}
{"kind": "key_press", "key": "Super", "description": "Press Windows key"}
{"kind": "key_press", "key": "ctrl+a", "description": "Select all"}

SEQUENCE (for predictable multi-step flows like filling forms):
{"kind": "sequence", "description": "Fill email form", "steps": [
  {"kind": "click", "x": 800, "y": 400, "description": "Click To field"},
  {"kind": "type", "text": "user@email.com", "description": "Type recipient"},
  {"kind": "key_press", "key": "Tab", "description": "Move to subject"},
  {"kind": "type", "text": "Subject line", "description": "Type subject"},
  {"kind": "key_press", "key": "Tab", "description": "Move to body"},
  {"kind": "type", "text": "Message body", "description": "Type message"}
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
3. EXACT pixel coordinates from the screenshot
4. NEVER repeat an action that was already performed in previous steps
5. If you typed text and it appeared, that step is DONE — move to the next part of the task
6. Track progress: if you've done steps A, B, C of a task, do step D next — don't restart
7. Use sequences for form-filling (To, Subject, Body) to avoid re-screenshotting between each field
8. PREFER accessibility actions (a11y_*) over pixel coordinates when the accessibility tree provides element info
9. Accessibility actions are faster and more reliable than clicking coordinates`;

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: any;
}

export class AIBrain {
  private config: ClawdConfig;
  private history: ConversationTurn[] = [];
  private screenWidth: number = 0;
  private screenHeight: number = 0;
  private maxHistoryTurns = 5; // Keep last 5 exchanges

  constructor(config: ClawdConfig) {
    this.config = config;
  }

  setScreenSize(width: number, height: number) {
    this.screenWidth = width;
    this.screenHeight = height;
  }

  async decideNextAction(
    screenshot: ScreenFrame,
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

    // Call the LLM with full conversation history
    const systemPrompt = SYSTEM_PROMPT
      .replace('{WIDTH}', String(this.screenWidth))
      .replace('{HEIGHT}', String(this.screenHeight));

    const response = await this.callLLM(systemPrompt);

    // Add assistant response to history
    this.history.push({
      role: 'assistant',
      content: [{ type: 'text', text: response }],
    });

    // Trim history to max turns (each turn = user + assistant = 2 entries)
    while (this.history.length > this.maxHistoryTurns * 2) {
      this.history.shift();
      this.history.shift();
    }

    // Parse response
    return this.parseResponse(response);
  }

  private parseResponse(response: string): {
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
          steps: parsed.steps || [],
          description: parsed.description || 'Multi-step sequence',
        };
        return { action: null, sequence: seq, description: seq.description, done: false };
      }

      // Single action
      const action = parsed as InputAction;
      return { action, sequence: null, description: parsed.description || 'Action', done: false };
    } catch (err) {
      return { action: null, sequence: null, description: 'Failed to parse action', done: false, error: `Parse error: ${err}\nRaw: ${response.substring(0, 200)}` };
    }
  }

  private async callLLM(systemPrompt: string): Promise<string> {
    const { provider, apiKey, visionModel } = this.config.ai;

    if (provider === 'anthropic') {
      return this.callAnthropic(systemPrompt, apiKey!, visionModel);
    } else if (provider === 'openai') {
      return this.callOpenAI(systemPrompt, apiKey!, visionModel);
    }

    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  private async callAnthropic(
    systemPrompt: string,
    apiKey: string,
    model: string,
  ): Promise<string> {
    // Convert history for Anthropic format
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
    // Convert history for OpenAI format
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
