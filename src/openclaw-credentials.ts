/**
 * OpenClaw-aware credential resolution.
 *
 * In skill mode, Clawd Cursor should reuse the host OpenClaw agent's provider/key
 * rather than requiring a separate key entry.
 */

export interface ResolvedApiConfig {
  provider?: 'anthropic' | 'openai' | 'ollama' | 'kimi';
  apiKey: string;
  source: 'openclaw' | 'local';
}

function detectProviderFromKey(apiKey: string): 'anthropic' | 'openai' | 'kimi' | 'ollama' {
  if (!apiKey) return 'ollama';
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('sk-') && apiKey.length > 60) return 'kimi';
  if (apiKey.startsWith('sk-')) return 'openai';
  return 'openai';
}

function normalizeProvider(provider?: string): ResolvedApiConfig['provider'] {
  if (!provider) return undefined;
  const p = provider.trim().toLowerCase();
  if (p === 'anthropic' || p === 'openai' || p === 'ollama' || p === 'kimi') return p;
  return undefined;
}

/**
 * Resolve provider + key with OpenClaw-first precedence.
 */
export function resolveApiConfig(opts?: { apiKey?: string; provider?: string }): ResolvedApiConfig {
  const openClawKey =
    process.env.OPENCLAW_AI_API_KEY ||
    process.env.OPENCLAW_API_KEY ||
    process.env.OPENCLAW_AGENT_API_KEY ||
    '';

  const openClawProvider = normalizeProvider(
    process.env.OPENCLAW_PROVIDER ||
    process.env.OPENCLAW_AI_PROVIDER ||
    process.env.OPENCLAW_AGENT_PROVIDER,
  );

  if (openClawKey) {
    return {
      apiKey: openClawKey,
      provider: openClawProvider || detectProviderFromKey(openClawKey),
      source: 'openclaw',
    };
  }

  const explicitApiKey = opts?.apiKey || '';
  if (explicitApiKey) {
    return {
      apiKey: explicitApiKey,
      provider: normalizeProvider(opts?.provider) || detectProviderFromKey(explicitApiKey),
      source: 'local',
    };
  }

  const localApiKey =
    process.env.AI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.KIMI_API_KEY ||
    process.env.MOONSHOT_API_KEY ||
    '';

  return {
    apiKey: localApiKey,
    provider: normalizeProvider(opts?.provider) || detectProviderFromKey(localApiKey),
    source: 'local',
  };
}
