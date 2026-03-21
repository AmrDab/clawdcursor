import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callTextLLM, callVisionLLM } from '../llm-client';
import type { PipelineConfig } from '../providers';

const fetchMock = vi.fn();
(globalThis as any).fetch = fetchMock;

const baseProvider = {
  name: 'Test Provider',
  baseUrl: 'https://example.com/v1',
  authHeader: (key: string) => ({ Authorization: `Bearer ${key}` }),
  textModel: 'text-model',
  visionModel: 'vision-model',
  openaiCompat: true,
  computerUse: false,
};

function makeConfig(overrides: Partial<PipelineConfig['provider']> = {}): PipelineConfig {
  return {
    provider: { ...baseProvider, ...overrides },
    providerKey: 'test',
    apiKey: 'test-key',
    layer1: true,
    layer2: { enabled: true, model: 'text-model', baseUrl: 'https://example.com/v1' },
    layer3: { enabled: true, model: 'vision-model', baseUrl: 'https://example.com/v1', computerUse: false },
  };
}

describe('llm-client provider capability handling', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
  });

  it('omits response_format for providers that disable JSON mode on text calls', async () => {
    const config = makeConfig({ supportsJsonMode: false });
    await callTextLLM(config, { user: 'hello', forceJson: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toBeUndefined();
  });

  it('includes response_format for providers that allow JSON mode on vision calls', async () => {
    const config = makeConfig({ supportsJsonMode: true });
    await callVisionLLM(config, {
      forceJson: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});
