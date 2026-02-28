/**
 * OpenClaw-aware credential resolution.
 *
 * In skill mode, Clawd Cursor should reuse the host OpenClaw agent config
 * (key/base URL/models) rather than inferring provider from key prefixes.
 */

export interface ResolvedApiConfig {
  provider?: 'anthropic' | 'openai' | 'ollama' | 'kimi';
  apiKey: string;
  baseUrl?: string;
  textModel?: string;
  visionModel?: string;
  source: 'openclaw' | 'local';
}

function normalizeProvider(provider?: string): ResolvedApiConfig['provider'] {
  if (!provider) return undefined;
  const p = provider.trim().toLowerCase();
  if (p === 'anthropic' || p === 'openai' || p === 'ollama' || p === 'kimi') return p;
  return undefined;
}

function normalizeBaseUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

function pick(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Resolve key + endpoint + models with OpenClaw-first precedence.
 */
export function resolveApiConfig(opts?: {
  apiKey?: string;
  provider?: string;
  baseUrl?: string;
  textModel?: string;
  visionModel?: string;
}): ResolvedApiConfig {
  const openClawKey = pick(
    process.env.OPENCLAW_AI_API_KEY,
    process.env.OPENCLAW_API_KEY,
    process.env.OPENCLAW_AGENT_API_KEY,
  ) || '';

  const openClawBaseUrl = normalizeBaseUrl(pick(
    process.env.OPENCLAW_BASE_URL,
    process.env.OPENCLAW_AI_BASE_URL,
    process.env.OPENCLAW_AGENT_BASE_URL,
  ));

  const openClawTextModel = pick(
    process.env.OPENCLAW_TEXT_MODEL,
    process.env.OPENCLAW_AI_TEXT_MODEL,
    process.env.OPENCLAW_MODEL,
  );

  const openClawVisionModel = pick(
    process.env.OPENCLAW_VISION_MODEL,
    process.env.OPENCLAW_AI_VISION_MODEL,
    process.env.OPENCLAW_MODEL,
  );

  const openClawProvider = normalizeProvider(pick(
    process.env.OPENCLAW_PROVIDER,
    process.env.OPENCLAW_AI_PROVIDER,
    process.env.OPENCLAW_AGENT_PROVIDER,
  ));

  if (openClawKey || openClawBaseUrl || openClawTextModel || openClawVisionModel || openClawProvider) {
    return {
      apiKey: openClawKey,
      provider: openClawProvider,
      baseUrl: openClawBaseUrl,
      textModel: openClawTextModel,
      visionModel: openClawVisionModel,
      source: 'openclaw',
    };
  }

  const explicitApiKey = opts?.apiKey || '';
  const localBaseUrl = normalizeBaseUrl(pick(opts?.baseUrl, process.env.AI_BASE_URL, process.env.OPENAI_BASE_URL));
  const localTextModel = pick(opts?.textModel, process.env.AI_TEXT_MODEL, process.env.AI_MODEL);
  const localVisionModel = pick(opts?.visionModel, process.env.AI_VISION_MODEL, process.env.AI_MODEL);

  if (explicitApiKey || localBaseUrl || localTextModel || localVisionModel || opts?.provider) {
    return {
      apiKey: explicitApiKey,
      provider: normalizeProvider(opts?.provider),
      baseUrl: localBaseUrl,
      textModel: localTextModel,
      visionModel: localVisionModel,
      source: 'local',
    };
  }

  const localApiKey = pick(
    process.env.AI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.KIMI_API_KEY,
    process.env.MOONSHOT_API_KEY,
  ) || '';

  return {
    apiKey: localApiKey,
    provider: normalizeProvider(opts?.provider),
    baseUrl: localBaseUrl,
    textModel: localTextModel,
    visionModel: localVisionModel,
    source: 'local',
  };
}
