/**
 * detectProvider must route modern OpenAI and OpenRouter keys correctly.
 *
 * A "long sk- key = Kimi" length heuristic ran before any prefix check, so
 * modern OpenAI keys (sk-proj-…, sk-svcacct-…, well over 100 chars) and
 * OpenRouter keys (sk-or-v1-…, ~73 chars) were classified as Kimi, sent to
 * Moonshot's endpoint, and failed with a 401 the user had no way to trace
 * back to the misdetection.
 */
import { describe, it, expect } from 'vitest';
import { detectProvider, PROVIDERS } from '../llm/providers';

describe('detectProvider — prefixed keys win over the length heuristic', () => {
  it.each([
    ['sk-proj-' + 'a'.repeat(150), 'openai'],
    ['sk-svcacct-' + 'a'.repeat(120), 'openai'],
    ['sk-admin-' + 'a'.repeat(90), 'openai'],
    ['sk-or-v1-' + 'a'.repeat(64), 'openrouter'],
  ])('%s… -> %s', (key, want) => {
    expect(detectProvider(key)).toBe(want);
  });

  it('a legacy short sk- key is still OpenAI', () => {
    expect(detectProvider('sk-' + 'a'.repeat(48))).toBe('openai');
  });

  it('a genuine long unprefixed sk- key still falls through to Kimi', () => {
    expect(detectProvider('sk-' + 'a'.repeat(70))).toBe('kimi');
  });

  it('Anthropic keys are untouched', () => {
    expect(detectProvider('sk-ant-' + 'a'.repeat(90))).toBe('anthropic');
  });

  it('openrouter is a real, fully-configured provider (not an empty generic)', () => {
    const p = PROVIDERS.openrouter;
    expect(p).toBeDefined();
    expect(p.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(p.textModel).toBeTruthy();
    expect(p.visionModel).toBeTruthy();
    expect(p.openaiCompat).toBe(true);
  });
});
