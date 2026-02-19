/**
 * AI Brain — sends screenshots to a vision LLM and gets back
 * structured actions (click here, type this, press that key).
 */

import type { ClawdConfig, InputAction, ScreenFrame, MouseAction, KeyboardAction } from './types';

const SYSTEM_PROMPT = `You are Clawd Cursor, an AI desktop agent controlling a Windows 11 computer via VNC.
The screen resolution is {WIDTH}x{HEIGHT}. You can see the screen and execute mouse/keyboard actions.

IMPORTANT - Windows 11 layout:
- The taskbar is at the BOTTOM of the screen, centered
- The Start button (Windows logo) is in the CENTER of the taskbar, NOT bottom-left
- Taskbar icons are centered by default
- The system tray (clock, icons) is on the bottom-RIGHT

When given a task, analyze the screenshot and respond with the NEXT SINGLE ACTION to take.
Respond with ONLY valid JSON, no other text:

For mouse actions:
{"kind": "click", "x": 500, "y": 300, "description": "Click the Chrome icon on taskbar"}
{"kind": "double_click", "x": 100, "y": 200, "description": "Open the file"}
{"kind": "right_click", "x": 500, "y": 300, "description": "Open context menu"}
{"kind": "scroll", "x": 500, "y": 300, "scrollDelta": -3, "description": "Scroll down"}

For keyboard actions:
{"kind": "type", "text": "hello world", "description": "Type search query"}
{"kind": "key_press", "key": "Return", "description": "Press Enter to submit"}
{"kind": "key_press", "key": "ctrl+a", "description": "Select all text"}
{"kind": "key_press", "key": "Super", "description": "Press Windows key"}

Special responses:
{"kind": "done", "description": "Task completed successfully"}
{"kind": "error", "description": "Cannot proceed because..."}
{"kind": "wait", "description": "Waiting for page to load", "waitMs": 2000}

Rules:
- ONE action per response, ONLY JSON
- BEFORE acting, check: is the task ALREADY COMPLETE? If yes, respond with {"kind":"done","description":"..."}
- Use exact pixel coordinates from the screenshot — coordinates correspond to ACTUAL screen pixels
- Be precise — aim for the CENTER of buttons/links/icons
- If you already performed the action in previous steps, the task is DONE — do not repeat it
- If the same action was tried before and didn't work, try a DIFFERENT approach
- The screenshot is the FULL screen at native resolution`;

export class AIBrain {
  private config: ClawdConfig;
  private conversationHistory: Array<{ role: string; content: any }> = [];
  private screenWidth: number = 0;
  private screenHeight: number = 0;

  constructor(config: ClawdConfig) {
    this.config = config;
  }

  setScreenSize(width: number, height: number) {
    this.screenWidth = width;
    this.screenHeight = height;
  }

  /**
   * Given a screenshot and task context, decide the next action.
   * Uses conversation history so AI remembers what it already tried.
   */
  async decideNextAction(
    screenshot: ScreenFrame,
    task: string,
    previousSteps: string[] = [],
  ): Promise<{
    action: InputAction | null;
    description: string;
    done: boolean;
    error?: string;
    waitMs?: number;
  }> {
    const base64Image = screenshot.buffer.toString('base64');
    const mediaType = screenshot.format === 'jpeg' ? 'image/jpeg' : 'image/png';

    // Build the user message with context
    let userMessage = `Task: ${task}\n`;
    if (previousSteps.length > 0) {
      const recent = previousSteps.slice(-5); // Only last 5 steps for context
      userMessage += `\nLast ${recent.length} steps:\n${recent.map((s, i) => `${previousSteps.length - recent.length + i + 1}. ${s}`).join('\n')}\n`;
    }
    userMessage += `\nWhat is the next action? Respond with ONLY JSON.`;

    const systemPrompt = SYSTEM_PROMPT
      .replace('{WIDTH}', String(this.screenWidth))
      .replace('{HEIGHT}', String(this.screenHeight));

    const response = await this.callVisionLLM(systemPrompt, userMessage, base64Image, mediaType);

    try {
      const jsonMatch = response.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        return { action: null, description: 'Failed to parse AI response', done: false, error: response };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (parsed.kind === 'done') {
        return { action: null, description: parsed.description, done: true };
      }

      if (parsed.kind === 'error') {
        return { action: null, description: parsed.description, done: false, error: parsed.description };
      }

      if (parsed.kind === 'wait') {
        return { action: null, description: parsed.description, done: false, waitMs: parsed.waitMs || 2000 };
      }

      const action = parsed as InputAction;
      return { action, description: parsed.description, done: false };
    } catch (err) {
      return { action: null, description: 'Failed to parse action', done: false, error: String(err) };
    }
  }

  private async callVisionLLM(
    systemPrompt: string,
    userMessage: string,
    base64Image: string,
    mediaType: string,
  ): Promise<string> {
    const { provider, apiKey, visionModel } = this.config.ai;

    if (provider === 'anthropic') {
      return this.callAnthropic(systemPrompt, userMessage, base64Image, mediaType, apiKey!, visionModel);
    } else if (provider === 'openai') {
      return this.callOpenAI(systemPrompt, userMessage, base64Image, mediaType, apiKey!, visionModel);
    }

    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  private async callAnthropic(
    systemPrompt: string,
    userMessage: string,
    base64Image: string,
    mediaType: string,
    apiKey: string,
    model: string,
  ): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        system: systemPrompt,
        messages: [
          {
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
          },
        ],
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
    userMessage: string,
    base64Image: string,
    mediaType: string,
    apiKey: string,
    model: string,
  ): Promise<string> {
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
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mediaType};base64,${base64Image}`,
                },
              },
              {
                type: 'text',
                text: userMessage,
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || '';
  }

  resetConversation(): void {
    this.conversationHistory = [];
  }
}
