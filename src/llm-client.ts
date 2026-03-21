/**
 * Shared LLM calling module — text AND vision.
 *
 * Text entry points:
 *   callTextLLM()       — accepts PipelineConfig (used by reasoners)
 *   callTextLLMDirect() — accepts explicit provider params (used by AIBrain)
 *
 * Vision entry points:
 *   callVisionLLM()       — accepts PipelineConfig
 *   callVisionLLMDirect() — accepts explicit provider params
 *
 * Image normalization: callers pass images in ANY format (OpenAI or Anthropic),
 * and the client auto-converts to the correct format for the target provider.
 */

import { supportsOpenAiJsonMode, type PipelineConfig } from './providers';

// ═══════════════════════════════════════════════════════════════════════════════
// LLM Error Classes
// ═══════════════════════════════════════════════════════════════════════════════

export class LLMError extends Error { constructor(msg: string) { super(msg); this.name = 'LLMError'; } }
export class LLMAuthError extends LLMError { constructor(msg: string) { super(msg); this.name = 'LLMAuthError'; } }
export class LLMBillingError extends LLMError { constructor(msg: string) { super(msg); this.name = 'LLMBillingError'; } }
export class LLMRateLimitError extends LLMError { constructor(msg: string) { super(msg); this.name = 'LLMRateLimitError'; } }
export class LLMModelNotFoundError extends LLMError { constructor(msg: string) { super(msg); this.name = 'LLMModelNotFoundError'; } }
export class LLMServerError extends LLMError { constructor(msg: string) { super(msg); this.name = 'LLMServerError'; } }

/** Check HTTP status and throw typed LLM errors. */
function throwOnHttpError(status: number, model: string, errBody: string): void {
  if (status === 401) throw new LLMAuthError(`Authentication failed (401). Check your API key for ${model}.`);
  if (status === 402) throw new LLMBillingError(`Payment required (402). Your API credits may be exhausted for ${model}.`);
  if (status === 429) throw new LLMRateLimitError(`Rate limited (429). Try again shortly or switch providers.`);
  if (status === 404) throw new LLMModelNotFoundError(`Model not found (404). Check model name: ${model}.`);
  if (status >= 500) throw new LLMServerError(`Server error (${status}). Provider may be experiencing issues.`);
  throw new LLMError(`API error (${status}): ${errBody.substring(0, 200)}`);
}

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
  const authHeaders = { ...config.provider.authHeader(apiKey), ...(config.provider.extraHeaders || {}) };

  return _callText({
    baseUrl,
    model,
    apiKey,
    isAnthropic,
    authHeaders,
    providerProfile: config.provider,
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
  providerProfile?: PipelineConfig['provider'];
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

      const canUseJsonMode = supportsOpenAiJsonMode(opts.providerProfile);
      const result = isAnthropic
        ? await _callAnthropic({ baseUrl, model, authHeaders, system, user, rawMessages, forceJson, maxTokens, timeoutMs })
        : await _callOpenAI({ baseUrl, model, authHeaders, system, user, rawMessages, forceJson, maxTokens, timeoutMs, canUseJsonMode });

      return result;
    } catch (err) {
      // Don't retry auth/billing errors — they won't resolve on retry
      if (err instanceof LLMAuthError || err instanceof LLMBillingError) throw err;
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
  canUseJsonMode?: boolean;
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
  if (p.forceJson && p.canUseJsonMode !== false) {
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
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throwOnHttpError(response.status, p.model, errBody);
  }
  const data = await response.json() as any;
  if (data.error) throw new LLMError(data.error.message || JSON.stringify(data.error));
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
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throwOnHttpError(response.status, p.model, errBody);
  }
  const data = await response.json() as any;
  if (data.error) throw new LLMError(data.error.message || JSON.stringify(data.error));
  const text = data.content?.[0]?.text || '';

  // When forceJson, prepend the '{' back since the API only returns the continuation
  if (p.forceJson) {
    return text.startsWith('{') ? text : '{' + text;
  }
  return text;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Vision LLM — types and image normalization
// ═══════════════════════════════════════════════════════════════════════════════

/** Content block that can contain text or images in either OpenAI or Anthropic format. */
export type VisionContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface VisionLLMOptions {
  system?: string;
  /** Messages with mixed text/image content blocks */
  messages: Array<{ role: string; content: string | VisionContentBlock[] }>;
  /** Force JSON response */
  forceJson?: boolean;
  /** Anthropic JSON prefill (e.g. '{"x":' for coordinate responses) */
  jsonPrefill?: string;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  /** Use SSE streaming with early JSON return (Anthropic only) */
  stream?: boolean;
}

export interface DirectVisionLLMOptions extends VisionLLMOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  isAnthropic: boolean;
  providerProfile?: PipelineConfig['provider'];
}

/**
 * Normalize an image content block to the target provider format.
 * Callers can pass images in either OpenAI or Anthropic format.
 */
export function normalizeImageBlock(block: VisionContentBlock, isAnthropic: boolean): any {
  if (block.type === 'text') return block;

  if (isAnthropic) {
    // Target: Anthropic format
    if (block.type === 'image') return block; // already Anthropic
    // Convert OpenAI → Anthropic
    const url = (block as any).image_url?.url || '';
    const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return block;
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  } else {
    // Target: OpenAI format
    if (block.type === 'image_url') return block; // already OpenAI
    // Convert Anthropic → OpenAI
    const src = (block as any).source;
    if (!src?.data) return block;
    return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } };
  }
}

/** Normalize all content blocks in a message array for the target provider. */
function normalizeMessages(
  messages: Array<{ role: string; content: string | VisionContentBlock[] }>,
  isAnthropic: boolean,
): Array<{ role: string; content: any }> {
  return messages.map(msg => {
    if (typeof msg.content === 'string') return msg;
    return {
      role: msg.role,
      content: (msg.content as VisionContentBlock[]).map(b => normalizeImageBlock(b, isAnthropic)),
    };
  });
}

// ─── Vision LLM entry points ────────────────────────────────────────────────

/**
 * Call a vision LLM using PipelineConfig.
 * Uses layer3 config (vision model) with layer2 as fallback.
 */
export async function callVisionLLM(
  config: PipelineConfig,
  options: VisionLLMOptions,
): Promise<string> {
  const layer = config.layer3.enabled ? config.layer3 : config.layer2;
  const baseUrl = layer.baseUrl;
  const model = layer.model;
  const apiKey = config.apiKey || '';
  const isAnthropic = !config.provider.openaiCompat
    && !baseUrl.includes('localhost')
    && !baseUrl.includes('11434');

  return callVisionLLMDirect({ ...options, baseUrl, model, apiKey, isAnthropic, providerProfile: config.provider });
}

/**
 * Call a vision LLM with explicit provider params.
 */
export async function callVisionLLMDirect(opts: DirectVisionLLMOptions): Promise<string> {
  const authHeaders: Record<string, string> = opts.isAnthropic
    ? { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' }
    : opts.apiKey
      ? { 'Authorization': `Bearer ${opts.apiKey}` }
      : {};

  const { retries = 0 } = opts;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return opts.isAnthropic
        ? await _callVisionAnthropic({ ...opts, authHeaders })
        : await _callVisionOpenAI({ ...opts, authHeaders });
    } catch (err) {
      // Don't retry auth/billing errors
      if (err instanceof LLMAuthError || err instanceof LLMBillingError) throw err;
      if (attempt < retries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt), 8000) + Math.random() * 1000;
        await new Promise(r => setTimeout(r, backoff));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Vision LLM call failed after retries');
}

// ─── Vision: OpenAI-compatible path ──────────────────────────────────────────

async function _callVisionOpenAI(p: DirectVisionLLMOptions & { authHeaders: Record<string, string> }): Promise<string> {
  const messages = normalizeMessages(p.messages, false);

  const body: Record<string, unknown> = {
    model: p.model,
    messages,
    max_tokens: p.maxTokens || 1024,
  };
  if (!p.model.startsWith('kimi-k2')) {
    body.temperature = 0;
  }
  if (p.forceJson && supportsOpenAiJsonMode(p.providerProfile)) {
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
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throwOnHttpError(response.status, p.model, errBody);
  }
  const data = await response.json() as any;
  if (data.error) throw new LLMError(data.error.message || JSON.stringify(data.error));
  const msg = data.choices?.[0]?.message;
  return msg?.content || msg?.reasoning_content || '';
}

// ─── Vision: Anthropic Messages API path ─────────────────────────────────────

async function _callVisionAnthropic(p: DirectVisionLLMOptions & { authHeaders: Record<string, string> }): Promise<string> {
  const normalized = normalizeMessages(p.messages, true);

  // Extract system from first message if system role
  let systemPrompt = p.system || '';
  let messages: Array<{ role: string; content: any }>;
  if (normalized[0]?.role === 'system') {
    systemPrompt = typeof normalized[0].content === 'string' ? normalized[0].content : '';
    messages = normalized.slice(1);
  } else {
    messages = normalized;
  }

  // Fix role mapping (Anthropic doesn't have 'system' in messages)
  messages = messages.map(m => ({
    ...m,
    role: m.role === 'system' ? 'user' : m.role,
  }));

  // JSON forcing via assistant prefill
  if (p.forceJson || p.jsonPrefill) {
    const prefill = p.jsonPrefill || '{';
    messages.push({ role: 'assistant', content: prefill });
  }

  const body: Record<string, unknown> = {
    model: p.model,
    max_tokens: p.maxTokens || 1024,
    system: systemPrompt,
    messages,
    temperature: 0,
    ...(p.stream ? { stream: true } : {}),
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
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throwOnHttpError(response.status, p.model, errBody);
  }

  // Streaming path: read SSE events, return when complete JSON detected
  if (p.stream && response.body) {
    let accumulated = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') break;
          try {
            const event = JSON.parse(payload);
            const delta = event.delta?.text || '';
            accumulated += delta;
            // Early return: if we have a complete JSON object
            if (accumulated.includes('}') && !accumulated.includes('"steps"')) {
              try { JSON.parse(accumulated); reader.cancel(); return accumulated; } catch { /* not yet complete */ }
            }
          } catch { /* skip malformed SSE */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return accumulated;
  }

  // Non-streaming path
  const data = await response.json() as any;
  if (data.error) throw new LLMError(data.error.message || JSON.stringify(data.error));
  const text = data.content?.[0]?.text || '';

  if (p.forceJson || p.jsonPrefill) {
    const prefill = p.jsonPrefill || '{';
    return text.startsWith(prefill.charAt(0)) ? text : prefill + text;
  }
  return text;
}
