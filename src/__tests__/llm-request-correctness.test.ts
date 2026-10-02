/**
 * Request-level correctness across providers. Each case captures the request
 * actually sent over the wire.
 *
 *  1. Mixed-provider vision routing — protocol, key and endpoint must come from
 *     the SELECTED layer, not the main provider (callTextLLM already did this;
 *     callVisionLLM did not).
 *  2. Model quirks on the OpenAI paths — o1/o3/gpt-5 reject max_tokens and
 *     temperature != 1; every other request builder applied the quirk table,
 *     the two OpenAI ones did not.
 *  3. Chunk-safe SSE — one `data:` line split across two network reads used to
 *     be dropped, silently losing streamed tokens.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';
import { callVisionLLM, callVisionLLMDirect, callTextLLMDirect } from '../llm/client';
import { PROVIDERS, type PipelineConfig } from '../llm/providers';

type Captured = { url: string; headers: Record<string, string>; body: any };

/** Answer in BOTH wire shapes so either protocol path can parse it. */
function captureFetch(): Captured[] {
  const seen: Captured[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers?: any; body?: unknown }) => {
    seen.push({ url, headers: init.headers ?? {}, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return seen;
}

const ANTHROPIC = 'https://api.anthropic.com/v1';
const OPENAI = 'https://api.openai.com/v1';
const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
const visionOpts = { messages: [{ role: 'user', content: [img as any] }], maxTokens: 64 };

function pipeline(over: Partial<PipelineConfig> & Pick<PipelineConfig, 'provider' | 'providerKey' | 'apiKey'>): PipelineConfig {
  return {
    layer1: true,
    layer2: { enabled: true, model: 'text-model', baseUrl: OPENAI },
    layer3: { enabled: true, model: 'vision-model', baseUrl: OPENAI, computerUse: false },
    ...over,
  } as PipelineConfig;
}

describe('1. mixed-provider vision routing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('OpenAI-compatible main + Anthropic vision layer -> Anthropic wire format and key', async () => {
    const seen = captureFetch();
    await callVisionLLM(pipeline({
      provider: PROVIDERS.kimi, providerKey: 'kimi', apiKey: 'sk-main-kimi',
      layer3: { enabled: true, model: 'claude-sonnet-4-6', baseUrl: ANTHROPIC, computerUse: false, apiKey: 'sk-ant-vision' },
    }), visionOpts as any);

    expect(seen[0].url).toBe(`${ANTHROPIC}/messages`);
    expect(seen[0].headers['x-api-key']).toBe('sk-ant-vision');
    expect(seen[0].headers['Authorization']).toBeUndefined();
  });

  it('Anthropic main + OpenAI vision layer -> OpenAI wire format and Bearer key', async () => {
    const seen = captureFetch();
    await callVisionLLM(pipeline({
      provider: PROVIDERS.anthropic, providerKey: 'anthropic', apiKey: 'sk-ant-main',
      layer3: { enabled: true, model: 'gpt-4o', baseUrl: OPENAI, computerUse: false, apiKey: 'sk-openai-vision' },
    }), visionOpts as any);

    expect(seen[0].url).toBe(`${OPENAI}/chat/completions`);
    expect(seen[0].headers['Authorization']).toBe('Bearer sk-openai-vision');
    expect(seen[0].headers['x-api-key']).toBeUndefined();
  });

  it('vision layer disabled -> falls back to layer 2 WITH layer 2\'s own key', async () => {
    const seen = captureFetch();
    await callVisionLLM(pipeline({
      provider: PROVIDERS.openai, providerKey: 'openai', apiKey: 'sk-pipeline',
      layer2: { enabled: true, model: 'gpt-4o-mini', baseUrl: OPENAI, apiKey: 'sk-layer2-own' },
      layer3: { enabled: false, model: '', baseUrl: '', computerUse: false },
    }), visionOpts as any);

    expect(seen[0].headers['Authorization']).toBe('Bearer sk-layer2-own');
  });
});

describe('2. model quirks reach both OpenAI request paths', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('text path: o3 gets max_completion_tokens and temperature 1', async () => {
    const seen = captureFetch();
    await callTextLLMDirect({ baseUrl: OPENAI, model: 'o3-mini', apiKey: 'k', isAnthropic: false, user: 'hi', maxTokens: 100 });
    expect(seen[0].body).not.toHaveProperty('max_tokens');
    expect(seen[0].body.max_completion_tokens).toBe(100);
    if ('temperature' in seen[0].body) expect(seen[0].body.temperature).toBe(1);
  });

  it('vision path: o3 gets max_completion_tokens and temperature 1', async () => {
    const seen = captureFetch();
    await callVisionLLMDirect({ ...visionOpts, baseUrl: OPENAI, model: 'o3', apiKey: 'k', isAnthropic: false } as any);
    expect(seen[0].body).not.toHaveProperty('max_tokens');
    expect(seen[0].body.max_completion_tokens).toBe(64);
    if ('temperature' in seen[0].body) expect(seen[0].body.temperature).toBe(1);
  });

  it('a non-quirk model is left alone', async () => {
    const seen = captureFetch();
    await callTextLLMDirect({ baseUrl: OPENAI, model: 'gpt-4o-mini', apiKey: 'k', isAnthropic: false, user: 'hi', maxTokens: 100 });
    expect(seen[0].body.max_tokens).toBe(100);
    expect(seen[0].body).not.toHaveProperty('max_completion_tokens');
  });
});

describe('3. SSE parsing survives arbitrary chunk boundaries', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Serve `text` as an SSE stream cut into the given chunks. */
  function streamFetch(chunks: string[]) {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }));
  }

  const sse = [
    'event: content_block_delta\r\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello, "}}\r\n\r\n',
    'event: content_block_delta\r\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\r\n\r\n',
    'event: message_stop\r\n',
    'data: {"type":"message_stop"}\r\n\r\n',
  ].join('');

  it.each([
    ['one chunk', [sse]],
    ['split mid-JSON', [sse.slice(0, 70), sse.slice(70)]],
    ['split inside the event: line', [sse.slice(0, 9), sse.slice(9)]],
    ['one byte at a time', sse.split('')],
  ])('assembles the full text when delivered as %s', async (_label, chunks) => {
    streamFetch(chunks as string[]);
    const out = await callVisionLLMDirect({ ...visionOpts, baseUrl: ANTHROPIC, model: 'claude-sonnet-4-6', apiKey: 'k', isAnthropic: true, stream: true } as any);
    expect(out).toBe('Hello, world');
  });
});
