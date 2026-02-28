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

import * as crypto from 'crypto';
import type { ClawdConfig, InputAction, ActionSequence, ScreenFrame } from './types';

import os from 'os';
const PLATFORM_HINT = os.platform() === 'darwin'
  ? 'macOS: menu bar TOP, Dock at bottom. Use Cmd (not Ctrl) for shortcuts. Spotlight: Cmd+Space.'
  : 'Win11: taskbar BOTTOM centered, system tray bottom-right.';

const SYSTEM_PROMPT = `You are Clawd Cursor, an AI desktop agent on ${os.platform() === 'darwin' ? 'macOS' : 'Windows 11'}.
Screen: {REAL_WIDTH}x{REAL_HEIGHT}. Screenshot: {LLM_WIDTH}x{LLM_HEIGHT} (scale {SCALE}x).
All coordinates in SCREENSHOT space — auto-scaled to real screen.

${PLATFORM_HINT}

Respond with ONLY valid JSON:
{"kind":"click","x":N,"y":N,"description":"..."}
{"kind":"double_click","x":N,"y":N,"description":"..."}
{"kind":"type","text":"...","description":"..."}
{"kind":"key_press","key":"Return|Super|ctrl+a|...","description":"..."}
{"kind":"drag","x":N,"y":N,"endX":N,"endY":N,"description":"..."}
{"kind":"sequence","description":"...","steps":[...]}
{"kind":"a11y_click","name":"...","controlType":"Button","description":"..."} (PREFERRED over coords)
{"kind":"a11y_set_value","name":"...","controlType":"Edit","value":"...","description":"..."}
{"kind":"a11y_focus","name":"...","controlType":"Edit","description":"..."}
{"kind":"done","description":"..."}
{"kind":"error","description":"..."}
{"kind":"wait","description":"...","waitMs":2000}

RULES:
1. Check if task already done → {"kind":"done"}
2. ONE JSON only. Use "sequence" for multi-step flows (forms)
3. NEVER repeat completed actions. Track progress
4. PREFER a11y_* actions over pixel coords when accessibility data available
5. Use sequences to batch predictable steps
6. PREFER keyboard shortcuts over mouse clicks — faster and resolution-independent:
   - Open app: Super → type name → Return (or Win+R → type exe → Return)
   - Save file: ctrl+s → type path → Return
   - New tab: ctrl+t → type URL → Return
   - Address bar: ctrl+l → type URL → Return
   - Close app: alt+F4
   - Switch app: alt+Tab
   - Select all: ctrl+a | Copy: ctrl+c | Paste: ctrl+v | Undo: ctrl+z
   - Find: ctrl+f | New file: ctrl+n | Print: ctrl+p
   - Calculator: type expression with keyboard (e.g. "1337*42=") instead of clicking buttons
   - File Explorer: Win+e | Desktop: Win+d | Run: Win+r
   - Focus existing window instead of re-launching apps
7. NEVER report success without verifying — check the screen/a11y tree to confirm the action worked`;

const DECOMPOSE_SYSTEM_PROMPT = `Decompose desktop tasks into executable sub-tasks. Return ONLY a JSON array of strings.

Allowed command patterns:
- "open [app or browser name]"
- "focus [app/window]"
- "go to [URL]"
- "click [element name]"
- "type [EXACT literal text]"
- "press [key]"
- "close [app/window]"

Reasoning rules:
- Think about what ANY app needs to complete the request: launch/focus, navigation, reach input area, enter exact content, submit/confirm.
- Use one concrete action per string, in the real order needed to execute.
- Prefer real, direct URLs (example format: "go to https://docs.google.com").
- "type" MUST contain the exact literal text to be typed, never an instruction about text.
- If the user asks to write/compose/create text, YOU must generate the final text and put that full text inside the "type" command.
- For web apps, include required clicks to reach an editable area before typing (for example start/new/blank buttons).
- If the user requests a specific browser, open that exact browser by name before navigation.
- Keep visual or ambiguous operations that require seeing the screen as a single descriptive subtask.
- Avoid over-decomposition: do not invent unnecessary steps.`;

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

  // ── Screenshot hash cache (Perf Opt #1) ──
  private lastScreenshotHash: string = '';
  private lastDecisionCache: {
    action: InputAction | null;
    sequence: ActionSequence | null;
    description: string;
    done: boolean;
    error?: string;
    waitMs?: number;
  } | null = null;

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
    // ── Perf Opt #1: Skip LLM call if screenshot unchanged ──
    // Sample 1KB evenly spaced from buffer for fast comparison (cheaper than full MD5)
    const sampleSize = Math.min(1024, screenshot.buffer.length);
    const step = Math.max(1, Math.floor(screenshot.buffer.length / sampleSize));
    const sample = Buffer.alloc(sampleSize);
    for (let i = 0; i < sampleSize; i++) {
      sample[i] = screenshot.buffer[i * step];
    }
    const hash = crypto.createHash('md5').update(sample).digest('hex');

    if (hash === this.lastScreenshotHash && this.lastDecisionCache && !this.lastDecisionCache.done) {
      console.log('   ⚡ Screenshot unchanged — using cached LLM decision');
      return this.lastDecisionCache;
    }
    this.lastScreenshotHash = hash;

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
    const result = this.parseResponse(response, scale);
    this.lastDecisionCache = result; // Cache for screenshot dedup
    return result;
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

  private static readonly BASE_URLS: Record<string, string> = {
    ollama: 'http://localhost:11434/v1',
    kimi: 'https://api.moonshot.cn/v1',
    openai: 'https://api.openai.com/v1',
  };

  private async callLLM(systemPrompt: string): Promise<string> {
    const { provider, apiKey, visionModel, baseUrl, visionApiKey, visionBaseUrl } = this.config.ai;
    const effectiveVisionKey = visionApiKey || apiKey || '';
    const effectiveVisionBaseUrl = visionBaseUrl || baseUrl;

    if (provider === 'anthropic' && !effectiveVisionBaseUrl) {
      return this.callAnthropic(systemPrompt, effectiveVisionKey, visionModel);
    }

    const resolvedBaseUrl = effectiveVisionBaseUrl || AIBrain.BASE_URLS[provider] || AIBrain.BASE_URLS['openai'];
    return this.callOpenAICompat(systemPrompt, effectiveVisionKey, visionModel, resolvedBaseUrl);
  }

  /**
   * Text-only LLM call (no images). Used for task decomposition.
   */
  private async callLLMText(systemPrompt: string, userMessage: string): Promise<string> {
    const { provider, apiKey, model, baseUrl, textApiKey, textBaseUrl } = this.config.ai;
    const effectiveTextKey = textApiKey || apiKey || '';
    const effectiveTextBaseUrl = textBaseUrl || baseUrl;

    const MAX_RETRIES = 2;

    if (provider === 'anthropic' && !effectiveTextBaseUrl) {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          console.log(`   🔗 LLM text call (attempt ${attempt + 1}): model=${model}`);
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': effectiveTextKey,
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
            const backoff = Math.min(1000 * Math.pow(2, attempt), 8000) + Math.random() * 1000;
            console.log(`   ⏳ Retrying in ${Math.round(backoff)}ms...`);
            await new Promise(r => setTimeout(r, backoff));
          } else {
            throw err;
          }
        }
      }
      throw new Error('LLM text call failed after retries');
    } else {
      const resolvedBaseUrl = effectiveTextBaseUrl || AIBrain.BASE_URLS[provider] || AIBrain.BASE_URLS['openai'];
      const response = await fetch(`${resolvedBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(effectiveTextKey ? { 'Authorization': `Bearer ${effectiveTextKey}` } : {}),
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
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      return data.choices?.[0]?.message?.content || '';
    }
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000); // 60s timeout

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
        stream: true,
        system: systemPrompt,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      clearTimeout(timeout);
      const data = await response.json() as any;
      console.error('Anthropic API error:', data.error);
      throw new Error(data.error?.message || `Anthropic API error (${response.status})`);
    }

    clearTimeout(timeout);

    // Stream response — collect text as it arrives
    let result = '';
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;
        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.text) {
            result += event.delta.text;
            // Early return: if we have a complete JSON object, stop waiting
            if (result.includes('}') && !result.includes('"steps"')) {
              try {
                const match = result.match(/\{[\s\S]*\}/);
                if (match) {
                  JSON.parse(match[0]); // validates it's complete JSON
                  reader.cancel();
                  return result;
                }
              } catch { /* incomplete JSON, keep reading */ }
            }
          }
        } catch { /* skip unparseable SSE lines */ }
      }
    }

    return result;
  }

 private getOSName(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows 11';
    case 'darwin':
      return 'MacOS';
    case 'linux':
      return 'Linux';
    default:
      return 'An Unknown OS';
  }
}



  private async callOpenAICompat(
    systemPrompt: string,
    apiKey: string,
    model: string,
    baseUrl: string = 'https://api.openai.com/v1',
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

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages,
      }),
    });

    const data = await response.json() as any;
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.choices?.[0]?.message?.content || '';
  }

  resetConversation(): void {
    this.history = [];
    this.lastScreenshotHash = '';
    this.lastDecisionCache = null;
  }
}
