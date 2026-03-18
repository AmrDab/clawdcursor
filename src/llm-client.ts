/**
 * Shared LLM text-calling module.
 *
 * Extracts the duplicated text-LLM logic from ai-brain, a11y-reasoner,
 * smart-interaction, and ocr-reasoner into a single implementation.
 *
 * Two entry points:
 *   callTextLLM()       — accepts PipelineConfig (used by reasoners)
 *   callTextLLMDirect() — accepts explicit provider params (used by AIBrain)
 */

import type { PipelineConfig } from './providers';

// ─── Public option types ──────────────────────────────────────────────────────

export interface TextLLMOptions {
  /** System prompt (used for single-turn, or ignored when `messages` is set) */
  system?: string;
  /** User message (used for single-turn, or ignored when `messages` is set) */
  user?: string;
  /** Full multi-turn messages array — overrides system/user when provided */
  messages?: Array<{ role: string; content: string }>;
  /** Force JSON response (OpenAI: response_format, Anthropic: prefill '{') */
  forceJson?: boolean;
  /** Max tokens to generate (default 500) */
  maxTokens?: number;
  /** Request timeout in milliseconds (default: none) */
  timeoutMs?: number;
  /** Number of retries with exponential backoff (default 0) */
  retries?: number;
}

export interface DirectLLMOptions extends TextLLMOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  isAnthropic: boolean;
}

// ─── Public entry points ──────────────────────────────────────────────────────

/**
 * Call a text LLM using PipelineConfig (used by reasoners).
 */
export async function callTextLLM(
  config: PipelineConfig,
  options: TextLLMOptions,
): Promise<string> {
  const { model, baseUrl } = config.layer2;
  const apiKey = config.apiKey || '';
  const isAnthropic = !config.provider.openaiCompat
    && !baseUrl.includes('localhost')
    && !baseUrl.includes('11434');
  const authHeaders = config.provider.authHeader(apiKey);

  return _callText({
    baseUrl,
    model,
    apiKey,
    isAnthropic,
    authHeaders,
    ...options,
  });
}

/**
 * Call a text LLM using explicit provider params (used by AIBrain).
 */
export async function callTextLLMDirect(opts: DirectLLMOptions): Promise<string> {
  const authHeaders: Record<string, string> = opts.isAnthropic
    ? { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' }
    : opts.apiKey
      ? { 'Authorization': `Bearer ${opts.apiKey}` }
      : {};

  return _callText({
    ...opts,
    authHeaders,
  });
}

// ─── Internal implementation ──────────────────────────────────────────────────

interface InternalCallOptions extends TextLLMOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  isAnthropic: boolean;
  authHeaders: Record<string, string>;
}

async function _callText(opts: InternalCallOptions): Promise<string> {
  const {
    baseUrl,
    model,
    apiKey: _apiKey,
    isAnthropic,
    authHeaders,
    system,
    user,
    messages: rawMessages,
    forceJson = false,
    maxTokens = 500,
    timeoutMs,
    retries = 0,
  } = opts;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (retries > 0) {
        console.log(`   🔗 LLM text call (attempt ${attempt + 1}): model=${model}`);
      }

      const result = isAnthropic
        ? await _callAnthropic({ baseUrl, model, authHeaders, system, user, rawMessages, forceJson, maxTokens, timeoutMs })
        : await _callOpenAI({ baseUrl, model, authHeaders, system, user, rawMessages, forceJson, maxTokens, timeoutMs });

      return result;
    } catch (err) {
      if (attempt < retries) {
        console.warn(`   ⚠️ LLM text call attempt ${attempt + 1} failed: ${err}`);
        const backoff = Math.min(1000 * Math.pow(2, attempt), 8000) + Math.random() * 1000;
        console.log(`   ⏳ Retrying in ${Math.round(backoff)}ms...`);
        await new Promise(r => setTimeout(r, backoff));
      } else {
        throw err;
      }
    }
  }

  // Unreachable — loop always returns or throws, but TypeScript needs this
  throw new Error('LLM text call failed after retries');
}

// ─── OpenAI-compatible path ───────────────────────────────────────────────────

async function _callOpenAI(p: {
  baseUrl: string;
  model: string;
  authHeaders: Record<string, string>;
  system?: string;
  user?: string;
  rawMessages?: Array<{ role: string; content: string }>;
  forceJson: boolean;
  maxTokens: number;
  timeoutMs?: number;
}): Promise<string> {
  // Build messages: either from rawMessages or from system+user
  let messages: Array<{ role: string; content: string }>;
  if (p.rawMessages && p.rawMessages.length > 0) {
    messages = p.rawMessages;
  } else {
    messages = [
      { role: 'system', content: p.system || '' },
      { role: 'user', content: p.user || '' },
    ];
  }

  const body: Record<string, unknown> = {
    model: p.model,
    messages,
    max_tokens: p.maxTokens,
  };
  // kimi-k2.5 and similar reasoning models only accept temperature=1 or omitted
  if (!p.model.startsWith('kimi-k2')) {
    body.temperature = 0;
  }
  if (p.forceJson) {
    body.response_format = { type: 'json_object' };
  }

  const fetchOpts: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...p.authHeaders },
    body: JSON.stringify(body),
  };
  if (p.timeoutMs) {
    fetchOpts.signal = AbortSignal.timeout(p.timeoutMs);
  }

  const response = await fetch(`${p.baseUrl}/chat/completions`, fetchOpts);
  const data = await response.json() as any;
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const msg = data.choices?.[0]?.message;
  // kimi-k2.5 and other reasoning models may return empty content with reasoning_content.
  // Fall back to reasoning_content when content is empty.
  return msg?.content || msg?.reasoning_content || '';
}

// ─── Anthropic Messages API path ──────────────────────────────────────────────

async function _callAnthropic(p: {
  baseUrl: string;
  model: string;
  authHeaders: Record<string, string>;
  system?: string;
  user?: string;
  rawMessages?: Array<{ role: string; content: string }>;
  forceJson: boolean;
  maxTokens: number;
  timeoutMs?: number;
}): Promise<string> {
  let systemPrompt: string;
  let messages: Array<{ role: string; content: string }>;

  if (p.rawMessages && p.rawMessages.length > 0) {
    // Multi-turn: extract system from first message if it's a system role
    if (p.rawMessages[0].role === 'system') {
      systemPrompt = p.rawMessages[0].content;
      messages = p.rawMessages.slice(1).map(m => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
      }));
    } else {
      systemPrompt = '';
      messages = p.rawMessages.map(m => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
      }));
    }
  } else {
    systemPrompt = p.system || '';
    messages = [{ role: 'user', content: p.user || '' }];
  }

  // forceJson: prefill '{' so Anthropic continues with valid JSON
  if (p.forceJson) {
    messages.push({ role: 'assistant', content: '{' });
  }

  const body: Record<string, unknown> = {
    model: p.model,
    max_tokens: p.maxTokens,
    system: systemPrompt,
    messages,
    temperature: 0,
  };

  const fetchOpts: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...p.authHeaders },
    body: JSON.stringify(body),
  };
  if (p.timeoutMs) {
    fetchOpts.signal = AbortSignal.timeout(p.timeoutMs);
  }

  const response = await fetch(`${p.baseUrl}/messages`, fetchOpts);
  const data = await response.json() as any;
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.content?.[0]?.text || '';

  // When forceJson, prepend the '{' back since the API only returns the continuation
  if (p.forceJson) {
    return text.startsWith('{') ? text : '{' + text;
  }
  return text;
}
