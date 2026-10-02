/**
 * Shared LLM calling module — text AND vision.
 *
 * Text entry points:
 *   callTextLLM()       — accepts PipelineConfig (used by pipeline reasoners)
 *   callTextLLMDirect() — accepts explicit provider params (used by pipeline preprocessor)
 *
 * Vision entry points:
 *   callVisionLLM()       — accepts PipelineConfig
 *   callVisionLLMDirect() — accepts explicit provider params
 *
 * Image normalization: callers pass images in ANY format (OpenAI or Anthropic),
 * and the client auto-converts to the correct format for the target provider.
 */

import { supportsOpenAiJsonMode, PROVIDERS, type PipelineConfig } from './providers';
import { inferProviderFromBaseUrl } from './credentials';

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

// ─── Per-model param quirks ──────────────────────────────────────────────────
//
// Real LLM endpoints reject perfectly valid OpenAI-shape parameters when the
// underlying model has its own constraints. Examples observed in the wild:
//
//   - Kimi `kimi-k2.5` rejects any `temperature` other than `1` with HTTP 400
//     "invalid temperature: only 1 is allowed for this model".
//   - OpenAI `o1` / `o1-mini` reject `max_tokens` (require `max_completion_tokens`)
//     and reject `temperature` other than `1`.
//   - GPT-5 family (gpt-5-*) only accepts `temperature: 1`.
//
// Each rule is matched by a substring of the model id (case-insensitive) and
// describes ONE fix: rename a key, drop a key, or coerce a value. Multiple
// rules can apply to the same model. Adding a new model takes one line.
//
// Pattern-matching by model-id substring rather than provider name keeps this
// model-agnostic in shape — any provider that ships the same model id picks
// up the same quirks. New families: append a row.

interface ModelQuirk {
  /** Lowercase substring tested against the model id. */
  matches: string;
  /** Apply the quirk to the request body in place. */
  apply: (body: Record<string, unknown>) => void;
  /** One-line description for diagnostics / future maintainers. */
  reason: string;
}

const MODEL_QUIRKS: ModelQuirk[] = [
  {
    matches: 'kimi-k2',
    reason: 'Kimi k2 vision/text models require temperature: 1 (rejects 0 with HTTP 400).',
    apply: (b) => { if ('temperature' in b) b.temperature = 1; },
  },
  {
    matches: 'o1',
    reason: 'OpenAI o1 models reject max_tokens (use max_completion_tokens) and temperature != 1.',
    apply: (b) => {
      if ('max_tokens' in b && !('max_completion_tokens' in b)) {
        b.max_completion_tokens = b.max_tokens;
        delete b.max_tokens;
      }
      if ('temperature' in b && b.temperature !== 1) b.temperature = 1;
    },
  },
  {
    matches: 'o3',
    reason: 'OpenAI o3 family follows the same constraints as o1.',
    apply: (b) => {
      if ('max_tokens' in b && !('max_completion_tokens' in b)) {
        b.max_completion_tokens = b.max_tokens;
        delete b.max_tokens;
      }
      if ('temperature' in b && b.temperature !== 1) b.temperature = 1;
    },
  },
  {
    matches: 'gpt-5',
    reason: 'GPT-5 family only accepts temperature: 1.',
    apply: (b) => { if ('temperature' in b && b.temperature !== 1) b.temperature = 1; },
  },
];

/**
 * Apply any model-specific quirks to a request body in place.
 *
 * Lookup is by lowercase substring match on the model id. Every matching
 * quirk runs (multiple rules can apply to the same model). Safe to call
 * with any model id; unknown models pass through unchanged.
 */
export function applyModelQuirks(model: string, body: Record<string, unknown>): void {
  if (!model) return;
  const id = model.toLowerCase();
  for (const quirk of MODEL_QUIRKS) {
    if (id.includes(quirk.matches)) quirk.apply(body);
  }
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
  // Use per-layer API key if available (mixed pipelines use different keys per layer)
  const apiKey = config.layer2.apiKey || config.apiKey || '';
  // Determine API format from the layer's base URL, not the main provider.
  // Mixed pipelines (Kimi text + Anthropic vision) need different formats per layer.
  const isAnthropic = baseUrl.includes('anthropic.com')
    && !baseUrl.includes('localhost')
    && !baseUrl.includes('11434');
  // Build auth headers for the layer's provider (may differ from main provider)
  const layerProviderKey = inferProviderFromBaseUrl(baseUrl) || config.providerKey;
  const layerProvider = PROVIDERS[layerProviderKey] || config.provider;
  const authHeaders = { ...layerProvider.authHeader(apiKey), ...(layerProvider.extraHeaders || {}) };

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
 * Call a text LLM using explicit provider params (used by pipeline preprocessor).
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
        : await _callOpenAI({ baseUrl, model, authHeaders, system, user, rawMessages, forceJson, maxTokens, timeoutMs, canUseJsonMode, isReasoningModel: false }); // text calls always use temperature=0

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
  isReasoningModel?: boolean;
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
  // Reasoning models (kimi-k2.5, etc.) reject temperature=0 — omit it.
  // Uses declarative flag instead of hardcoded model name matching.
  if (!p.isReasoningModel) {
    body.temperature = 0;
  }
  if (p.forceJson && p.canUseJsonMode !== false) {
    body.response_format = { type: 'json_object' };
  }
  // Every other request path applied model quirks; the two OpenAI ones (this
  // and _callVisionOpenAI) did not — and those are exactly where the quirks
  // matter, since they exist for OpenAI's reasoning models (o1/o3/gpt-5),
  // which reject parameters like max_tokens and temperature with a 400.
  applyModelQuirks(p.model, body);

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
  applyModelQuirks(p.model, body);

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
  // Everything below is resolved from the SELECTED layer, mirroring
  // callTextLLM. This used to take the protocol and provider profile from the
  // MAIN provider, so a mixed pipeline sent the wrong wire format: a Kimi or
  // OpenAI primary with an Anthropic vision layer posted OpenAI-format JSON to
  // Anthropic's endpoint, and the reverse. And with layer 3 disabled it fell
  // back to the pipeline key instead of layer 2's own key.
  const apiKey = layer.apiKey || config.apiKey || '';
  const isAnthropic = baseUrl.includes('anthropic.com')
    && !baseUrl.includes('localhost')
    && !baseUrl.includes('11434');
  const layerProviderKey = inferProviderFromBaseUrl(baseUrl) || config.providerKey;
  const providerProfile = PROVIDERS[layerProviderKey] || config.provider;

  return callVisionLLMDirect({ ...options, baseUrl, model, apiKey, isAnthropic, providerProfile });
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
  // Reasoning models reject temperature=0 — use provider flag, not model name
  if (!p.providerProfile?.reasoningVisionModel) {
    body.temperature = 0;
  }
  if (p.forceJson && supportsOpenAiJsonMode(p.providerProfile)) {
    body.response_format = { type: 'json_object' };
  }
  applyModelQuirks(p.model, body); // see _callOpenAI

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
  applyModelQuirks(p.model, body);

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

  // Streaming path: read SSE events using event-type state machine
  if (p.stream && response.body) {
    let accumulated = '';
    let currentEventType = '';
    let messageComplete = false;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // Carry-over buffer. A network read is NOT a line: one `data:` line can
    // arrive split across two reads. This used to split each read on '\n' by
    // itself, so a split line became two fragments, both failed JSON.parse,
    // and both were swallowed by the catch below — silently dropping tokens
    // from the streamed text. Only COMPLETE lines are processed now; the
    // trailing partial line waits for the next read and is flushed at the end.
    let pending = '';
    const handleLine = (rawLine: string): void => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine; // SSE allows CRLF
      // Track SSE event type from "event:" lines
      if (line.startsWith('event:')) {
        currentEventType = line.slice(6).trim();
        return;
      }
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { messageComplete = true; return; }
      try {
        const event = JSON.parse(payload);
        if (currentEventType === 'content_block_delta') {
          const delta = event.delta?.text || '';
          accumulated += delta;
        } else if (currentEventType === 'content_block_stop' || currentEventType === 'message_stop') {
          messageComplete = true;
        }
      } catch { /* a genuinely malformed line, not a split one */ }
    };
    try {
      while (!messageComplete) {
        const { done, value } = await reader.read();
        if (done) {
          pending += decoder.decode(); // flush any bytes the decoder still holds
          if (pending) handleLine(pending);
          pending = '';
          break;
        }
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          handleLine(line);
          if (messageComplete) break;
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

// ═══════════════════════════════════════════════════════════════════════════════
// Tool-use LLM — native Anthropic `tool_use` + OpenAI `tool_calls`
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A tool the model can call. Mirrors Anthropic's `tools` schema and
 * OpenAI's `tools[].function` schema — both accept JSON-Schema input.
 */
export interface LLMTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/**
 * One structured tool call extracted from the model response. The agent
 * runs this and feeds the result back on the next turn as a
 * `tool_result` content block.
 */
export interface LLMToolCall {
  /** Provider-assigned ID, used to associate the subsequent tool_result block. */
  id: string;
  name: string;
  /** Already-parsed JSON args (never a JSON string). */
  args: Record<string, unknown>;
  /**
   * Set when the provider sent arguments that were not valid JSON. The call
   * must NOT be executed: `args` is then `{}`, and running a tool with empty
   * arguments is not the same action the model asked for. An empty window
   * selector, for one, deliberately targets the FOREGROUND window.
   */
  parseError?: string;
}

/** Content blocks the agent's assistant turn can produce. */
export type LLMAssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

/** Content blocks a user turn can carry. */
export type LLMUserBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
      >;
      is_error?: boolean;
    };

/** Conversation turn for the tool-use API. */
export interface LLMToolTurn {
  role: 'user' | 'assistant';
  content: string | LLMUserBlock[] | LLMAssistantBlock[];
}

export interface ToolUseResult {
  /** Free-text prose the model emitted alongside tool calls (if any). */
  text: string;
  /** Zero or more tool calls in the order the model emitted them. */
  toolCalls: LLMToolCall[];
  /** Provider reason the turn ended — `tool_use` / `end_turn` / `stop` / `length`. */
  stopReason: string;
  /** Raw assistant content — forward verbatim on the next turn as `{role:'assistant', content: raw}`. */
  raw: LLMAssistantBlock[];
}

export interface DirectToolUseOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  isAnthropic: boolean;
  system: string;
  tools: LLMTool[];
  messages: LLMToolTurn[];
  /** "auto" (default) | "any" | "none" | specific tool name */
  toolChoice?: 'auto' | 'any' | 'none' | { name: string };
  maxTokens?: number;
  timeoutMs?: number;
  /** External abort (user stop) — combined with the per-call timeout. */
  signal?: AbortSignal;
}

/**
 * Combine the per-call timeout with an external user-abort signal.
 * AbortSignal.any needs Node 20.3+; on older 20.x fall back to the timeout
 * alone (the agent loop still notices the abort at its next checkpoint).
 */
function combineSignals(timeoutMs?: number, external?: AbortSignal): AbortSignal | undefined {
  const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  if (timeout && external) {
    const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
    return any ? any.call(AbortSignal, [timeout, external]) : timeout;
  }
  return external ?? timeout;
}

/**
 * Invoke an LLM with a tool catalog. Prefers native tool_use (Anthropic)
 * or tool_calls (OpenAI) and falls back to JSON-in-prose parsing for
 * providers that lack native support (Ollama text-only models, etc.).
 *
 * The caller supplies the tool catalog + multi-turn messages; the function
 * returns a structured ToolUseResult with parsed tool calls. The agent runs
 * each tool and feeds results back as `tool_result` blocks on the next turn.
 */
export async function callLLMWithTools(opts: DirectToolUseOptions): Promise<ToolUseResult> {
  const authHeaders: Record<string, string> = opts.isAnthropic
    ? { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' }
    : opts.apiKey
      ? { 'Authorization': `Bearer ${opts.apiKey}` }
      : {};

  return opts.isAnthropic
    ? callAnthropicTools({ ...opts, authHeaders })
    : callOpenAITools({ ...opts, authHeaders });
}

// ─── Anthropic tool_use path ─────────────────────────────────────────────────

async function callAnthropicTools(
  p: DirectToolUseOptions & { authHeaders: Record<string, string> },
): Promise<ToolUseResult> {
  // Map our LLMTool shape directly onto Anthropic's `tools` schema.
  const tools = p.tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  // Normalize messages into Anthropic content-block format. We accept
  // both `image_url` (OpenAI) and `image` (Anthropic) and normalize image_url
  // to Anthropic's base64 variant.
  const messages = p.messages.map(turn => {
    if (typeof turn.content === 'string') {
      return { role: turn.role, content: turn.content };
    }
    const blocks = (turn.content as any[]).map(b => {
      if (b.type === 'image_url') {
        const url: string = b.image_url?.url || '';
        const m = url.match(/^data:(image\/\w+);base64,(.+)$/);
        if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
        return b;
      }
      return b;
    });
    return { role: turn.role, content: blocks };
  });

  // Anthropic tool_choice shapes: {type:'auto'} | {type:'any'} | {type:'tool', name}
  let toolChoice: unknown = undefined;
  if (p.toolChoice && p.toolChoice !== 'none') {
    toolChoice = typeof p.toolChoice === 'object'
      ? { type: 'tool', name: p.toolChoice.name }
      : { type: p.toolChoice };
  }

  const body: Record<string, unknown> = {
    model: p.model,
    max_tokens: p.maxTokens ?? 1024,
    system: p.system,
    messages,
    tools,
    temperature: 0,
  };
  if (toolChoice) body.tool_choice = toolChoice;
  applyModelQuirks(p.model, body);

  const fetchOpts: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...p.authHeaders },
    body: JSON.stringify(body),
  };
  const anthropicSignal = combineSignals(p.timeoutMs, p.signal);
  if (anthropicSignal) fetchOpts.signal = anthropicSignal;

  const response = await fetch(`${p.baseUrl}/messages`, fetchOpts);
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throwOnHttpError(response.status, p.model, errBody);
  }
  const data = await response.json() as any;
  if (data.error) throw new LLMError(data.error.message || JSON.stringify(data.error));

  const contentBlocks: any[] = Array.isArray(data.content) ? data.content : [];
  const raw: LLMAssistantBlock[] = [];
  const toolCalls: LLMToolCall[] = [];
  let prose = '';

  for (const block of contentBlocks) {
    if (block.type === 'text') {
      prose += block.text || '';
      raw.push({ type: 'text', text: block.text || '' });
    } else if (block.type === 'tool_use') {
      const input = (block.input ?? {}) as Record<string, unknown>;
      toolCalls.push({ id: String(block.id), name: String(block.name), args: input });
      raw.push({ type: 'tool_use', id: String(block.id), name: String(block.name), input });
    }
  }

  return {
    text: prose,
    toolCalls,
    stopReason: String(data.stop_reason || 'end_turn'),
    raw,
  };
}

// ─── OpenAI tool_calls path ──────────────────────────────────────────────────

async function callOpenAITools(
  p: DirectToolUseOptions & { authHeaders: Record<string, string> },
): Promise<ToolUseResult> {
  // Map tools to OpenAI's tools[].function schema.
  const tools = p.tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  // Normalize messages into OpenAI chat format. OpenAI expects:
  //   { role:'system'|'user'|'assistant'|'tool', content, tool_calls?, tool_call_id? }
  // We keep it simple: one system message prepended, then caller's turns.
  const openaiMessages: any[] = [{ role: 'system', content: p.system }];

  for (const turn of p.messages) {
    if (typeof turn.content === 'string') {
      openaiMessages.push({ role: turn.role, content: turn.content });
      continue;
    }
    const blocks = turn.content as any[];

    if (turn.role === 'assistant') {
      // Assistant turn may contain text + tool_use blocks; OpenAI wants
      //   { role:'assistant', content?: string, tool_calls?: [...] }
      let text = '';
      const tcalls: any[] = [];
      for (const b of blocks) {
        if (b.type === 'text') text += b.text || '';
        else if (b.type === 'tool_use') {
          tcalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const msg: any = { role: 'assistant' };
      if (text) msg.content = text;
      if (tcalls.length) msg.tool_calls = tcalls;
      if (!text && !tcalls.length) msg.content = '';
      openaiMessages.push(msg);
      continue;
    }

    // User turn: tool_result blocks become separate `tool` messages; other
    // blocks are consolidated into one user content array.
    const userContent: any[] = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        // Emit a standalone `tool` role message BEFORE the rest of the user turn.
        //
        // Anthropic lets a tool_result carry images; the OpenAI wire format does
        // not (a `tool` message is text-only for most providers). This used to
        // keep only the text and DROP every image, so on every non-Anthropic
        // provider (OpenAI, Gemini, Mistral, xAI, Groq, Ollama, any
        // OpenAI-compatible endpoint) a screenshot reached the model as the bare
        // words "Screenshot captured" — and the agent then clicked at
        // coordinates the model had GUESSED. A silent wrong action.
        //
        // The images now ride in the user message emitted after this loop. That
        // position is valid: OpenAI requires every `tool` reply to directly
        // follow the assistant's tool_calls, and userContent only goes out once
        // all of them are emitted.
        //
        // A plain-string `content` (also legal in Anthropic's format) was being
        // dropped to '' as well; keep it.
        const parts: any[] = Array.isArray(b.content)
          ? b.content
          : typeof b.content === 'string'
            ? [{ type: 'text', text: b.content }]
            : [];
        const resultText = parts
          .map((c: any) => c.type === 'text' ? c.text : '')
          .filter(Boolean)
          .join('\n');
        const images = parts.filter((c: any) => c.type === 'image' && c.source?.data);
        openaiMessages.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: resultText || (images.length ? '(image attached in the next message)' : ''),
        });
        if (images.length) {
          userContent.push({ type: 'text', text: `Image output of tool call ${b.tool_use_id}:` });
          for (const img of images) {
            userContent.push({
              type: 'image_url',
              image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` },
            });
          }
        }
      } else if (b.type === 'text') {
        userContent.push({ type: 'text', text: b.text });
      } else if (b.type === 'image') {
        const url = `data:${b.source.media_type};base64,${b.source.data}`;
        userContent.push({ type: 'image_url', image_url: { url } });
      } else if (b.type === 'image_url') {
        userContent.push({ type: 'image_url', image_url: b.image_url });
      }
    }
    if (userContent.length === 1 && userContent[0].type === 'text') {
      openaiMessages.push({ role: 'user', content: userContent[0].text });
    } else if (userContent.length > 0) {
      openaiMessages.push({ role: 'user', content: userContent });
    }
  }

  // tool_choice mapping
  let toolChoice: unknown = 'auto';
  if (p.toolChoice === 'none') toolChoice = 'none';
  else if (p.toolChoice === 'any') toolChoice = 'required';
  else if (typeof p.toolChoice === 'object') {
    toolChoice = { type: 'function', function: { name: p.toolChoice.name } };
  }

  const body: Record<string, unknown> = {
    model: p.model,
    messages: openaiMessages,
    tools,
    tool_choice: toolChoice,
    max_tokens: p.maxTokens ?? 1024,
    temperature: 0,
  };
  applyModelQuirks(p.model, body);

  const fetchOpts: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...p.authHeaders },
    body: JSON.stringify(body),
  };
  const openaiSignal = combineSignals(p.timeoutMs, p.signal);
  if (openaiSignal) fetchOpts.signal = openaiSignal;

  const response = await fetch(`${p.baseUrl}/chat/completions`, fetchOpts);
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throwOnHttpError(response.status, p.model, errBody);
  }
  const data = await response.json() as any;
  if (data.error) throw new LLMError(data.error.message || JSON.stringify(data.error));

  const msg = data.choices?.[0]?.message ?? {};
  const stopReason = String(data.choices?.[0]?.finish_reason || 'stop');
  const text = typeof msg.content === 'string' ? msg.content : '';

  const raw: LLMAssistantBlock[] = [];
  const toolCalls: LLMToolCall[] = [];

  if (text) raw.push({ type: 'text', text });
  const tcalls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const tc of tcalls) {
    let args: Record<string, unknown> = {};
    let parseError: string | undefined;
    const rawArgs = tc.function?.arguments ?? '{}';
    try {
      args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs;
    } catch (e) {
      // Used to be swallowed, leaving `{}` — and the call then EXECUTED with
      // empty arguments, a different action from the one the model intended.
      parseError = `${(e as Error).message}; received: ${String(rawArgs).slice(0, 200)}`;
    }
    const id = String(tc.id || `call_${toolCalls.length}`);
    const name = String(tc.function?.name || '');
    if (!name) continue;
    toolCalls.push(parseError ? { id, name, args, parseError } : { id, name, args });
    raw.push({ type: 'tool_use', id, name, input: args });
  }

  // Fallback: some providers (Ollama, some local models) don't emit native
  // tool_calls even when `tools` is provided. If we got a prose response
  // that *looks* like a tool call, parse it out so the agent keeps moving.
  if (toolCalls.length === 0 && text) {
    const parsed = tryParseProseToolCall(text);
    if (parsed) {
      const id = `prose_${Date.now()}`;
      toolCalls.push({ id, name: parsed.name, args: parsed.args });
      raw.push({ type: 'tool_use', id, name: parsed.name, input: parsed.args });
    }
  }

  return { text, toolCalls, stopReason, raw };
}

/**
 * Fallback prose→tool-call parser for providers that don't emit native tool_calls.
 *
 * Recognizes three families:
 *
 *   1. **Prefix-style** (Kimi `moonshot-v1-*`, some DeepSeek / Qwen text models):
 *      `functions.<TOOL>:<id>$\n{ "arg": "value" }`
 *      The function NAME lives in the prefix; the JSON body is the args.
 *
 *   2. **Llama-style** (some Llama/Mistral fine-tunes):
 *      `<function=NAME>{...args JSON...}</function>`
 *      Or: `<|tool_call|>NAME\n{...}`
 *
 *   3. **JSON-only** (older Ollama, generic text fallbacks):
 *      A bare JSON object with `tool|name|action` + `args|input|parameters` keys.
 *
 * The parser tries each in order and returns the first match. Returns null
 * when nothing parses — the caller treats that as a legitimate text-only reply.
 *
 * Pattern-matched, NOT model-name-matched, so any provider that emits one
 * of these formats works without an explicit allowlist entry.
 */
export function tryParseProseToolCall(prose: string): { name: string; args: Record<string, unknown> } | null {
  // Strip code fences once up-front; every family below benefits.
  const cleaned = prose.replace(/```(?:json|tool|function)?\s*|```\s*$/g, '').trim();

  // ── Family 1: prefix-style — `functions.<NAME>(:<id>)?(separator)<JSON>` ──
  // The Kimi `moonshot-v1-*` shape. The model has shipped at least three
  // separator variants in the wild:
  //   functions.NAME:0$\n{...}              (original v0.8.8 era)
  //   functions.NAME:0->{...}               (current as of 2026-05)
  //   functions.NAME:0\n{...}               (no separator, just whitespace)
  // Plus an args wrapper variant: Kimi sometimes emits `{_{...real args...}}`
  // where `_` is a literal underscore "no-key" wrapper. We strip that by
  // letting `extractParseableJsonObject` walk past unparseable outer braces.
  const prefixMatch = cleaned.match(/(?:^|\n)\s*functions\.([A-Za-z_][\w]*)(?::\d+)?\s*(?:\$|->|=>)?\s*([\s\S]*)$/);
  if (prefixMatch) {
    const name = prefixMatch[1];
    const body = prefixMatch[2].trim();
    // Empty body — zero-arg call (e.g. `functions.read_screen:18` with nothing after).
    if (!body) return { name, args: {} };
    const args = extractParseableJsonObject(body);
    if (name && args !== null) {
      return { name, args };
    }
  }

  // ── Family 2a: Llama `<function=NAME>{...}</function>` ──
  const llamaMatch = cleaned.match(/<function=([A-Za-z_][\w]*)>([\s\S]*?)<\/function>/);
  if (llamaMatch) {
    const args = extractFirstJsonObject(llamaMatch[2]);
    if (args !== null) return { name: llamaMatch[1], args };
  }

  // ── Family 2b: `<|tool_call|>NAME\n{...}` ──
  const tagMatch = cleaned.match(/<\|tool_call|>\s*([A-Za-z_][\w]*)\s*([\s\S]*)$/);
  if (tagMatch) {
    const args = extractFirstJsonObject(tagMatch[2]);
    if (args !== null) return { name: tagMatch[1], args };
  }

  // ── Family 2c: Python-call syntax — `<NAME>(<key>: <value>, ...)` ──
  // Kimi `kimi-k2.5` (vision) emits this on every terminal action.
  // Examples observed in the wild:
  //   done(evidence: "Screenshot shows Outlook draft email")
  //   give_up(reason: "missing credentials")
  //   mouse_click(x: 100, y: 200)
  //   wait(seconds=2.5)
  // Both `:` and `=` are accepted as kwarg separators. Handles balanced
  // parens inside string literals so values like `"text (with parens)"` work.
  const pyMatch = cleaned.match(/^\s*([A-Za-z_]\w*)\s*\(/);
  if (pyMatch) {
    const start = cleaned.indexOf('(', cleaned.indexOf(pyMatch[1])) + 1;
    let depth = 1;
    let inStr = false;
    let strChar = '';
    let esc = false;
    let end = -1;
    for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (inStr) {
        if (c === strChar) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; strChar = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end !== -1) {
      const argsBody = cleaned.slice(start, end).trim();
      if (!argsBody) return { name: pyMatch[1], args: {} };
      // Coerce kwargs to JSON object literal: quote unquoted keys, normalise
      // `=` to `:`, normalise single-quoted strings to double-quoted.
      // Single-quote conversion is best-effort: it skips quotes inside
      // already-double-quoted strings to avoid corrupting them.
      let asJson = argsBody;
      // Convert single-quoted strings to double-quoted (only outside of
      // existing double-quoted regions).
      asJson = convertSingleQuotedStrings(asJson);
      // Quote unquoted keys before `:` or `=`, then normalise `=` to `:`.
      asJson = asJson.replace(/(^|[\s,{])([A-Za-z_]\w*)\s*[:=]/g, '$1"$2":');
      try {
        const parsed = JSON.parse('{' + asJson + '}');
        if (parsed && typeof parsed === 'object') {
          return { name: pyMatch[1], args: parsed as Record<string, unknown> };
        }
      } catch {
        // Coercion failed (unusual nesting, unparseable value). Fall back
        // to returning the call with empty args — the tool dispatcher will
        // surface a clean error so the model can retry with a different shape.
        return { name: pyMatch[1], args: {} };
      }
    }
  }

  // ── Family 3: JSON-only with self-describing keys ──
  const obj = extractFirstJsonObject(cleaned);
  if (obj && typeof obj === 'object') {
    // Treat shape {tool|name|action: "...", args|input|parameters: {...}} as a tool call.
    // Crucially: only accept this when there's an explicit args/input/parameters
    // object — otherwise a payload like {"name":"Outlook"} (which is the *value*
    // for an open_app call) gets mistaken for a call to a tool literally named
    // "Outlook". This was the v0.8.8 mis-parse.
    const explicitName = typeof (obj as any).tool === 'string' ? (obj as any).tool
      : typeof (obj as any).action === 'string' ? (obj as any).action
      : '';
    const argsObj = ((obj as any).args && typeof (obj as any).args === 'object') ? (obj as any).args
      : ((obj as any).input && typeof (obj as any).input === 'object') ? (obj as any).input
      : ((obj as any).parameters && typeof (obj as any).parameters === 'object') ? (obj as any).parameters
      : null;
    if (explicitName && argsObj !== null) {
      return { name: explicitName, args: argsObj as Record<string, unknown> };
    }
    // Legacy lenient fallback: {name: "...", ...} — only when there's an `args`
    // object peer, so we don't misread a parameter dictionary as a tool call.
    if (typeof (obj as any).name === 'string' && argsObj !== null) {
      return { name: (obj as any).name, args: argsObj as Record<string, unknown> };
    }
  }

  return null;
}

/**
 * Convert single-quoted string literals to double-quoted. Conservative:
 * only swaps `'` runs that aren't already inside a double-quoted span.
 * Used by the Python-call parser before JSON.parse — JSON only accepts
 * double quotes, but Kimi-style emissions sometimes mix the two.
 */
function convertSingleQuotedStrings(text: string): string {
  let out = '';
  let inDouble = false;
  let inSingle = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (!inSingle && c === '"') { inDouble = !inDouble; out += c; continue; }
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      out += '"'; // swap to double-quote
      continue;
    }
    // Inside a single-quoted string, escape any literal double-quotes so the
    // JSON parser sees a valid string body.
    if (inSingle && c === '"') { out += '\\"'; continue; }
    out += c;
  }
  return out;
}

/**
 * Extract the first balanced JSON object from a string. Returns the parsed
 * object on success, or null if no balanced object exists or it doesn't parse.
 * Handles strings with escapes correctly.
 */
function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Find the first PARSEABLE balanced JSON object in `text`.
 * Walks every `{` position and tries to JSON.parse the matching balanced
 * region. Returns the first one that parses successfully.
 *
 * This handles wrapper-style outputs like `{_{...real json...}}` that some
 * models (Kimi `moonshot-v1-*`) emit — the outer `{_{...}}` fails JSON.parse
 * because `_` isn't a valid key prefix, but the inner `{...}` parses cleanly.
 */
function extractParseableJsonObject(text: string): Record<string, unknown> | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = !inStr;
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = j + 1; break; }
      }
    }
    if (end === -1) continue;
    try {
      const parsed = JSON.parse(text.slice(i, end));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* try next position */ }
  }
  return null;
}
