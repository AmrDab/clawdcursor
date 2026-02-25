/**
 * Provider Model Map — auto-selects cheap/expensive models per provider.
 * Used by the doctor and the agent pipeline to route tasks optimally.
 */

export interface ProviderProfile {
  name: string;
  /** Base URL for API calls */
  baseUrl: string;
  /** Auth header format */
  authHeader: (key: string) => Record<string, string>;
  /** Cheap text-only model (Layer 2: accessibility reasoner) */
  textModel: string;
  /** Vision-capable model (Layer 3: screenshot fallback) */
  visionModel: string;
  /** Whether the API is OpenAI-compatible */
  openaiCompat: boolean;
  /** Extra headers needed */
  extraHeaders?: Record<string, string>;
  /** Whether this provider supports Computer Use tool */
  computerUse: boolean;
}

export const PROVIDERS: Record<string, ProviderProfile> = {
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    authHeader: (key) => ({
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }),
    textModel: 'claude-3-5-haiku-20241022',  // Claude 3.5 Haiku — fallback to claude-haiku-4-5 if not on your plan
    visionModel: 'claude-sonnet-4-20250514',
    openaiCompat: false,
    computerUse: true,
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    textModel: 'gpt-4o-mini',
    visionModel: 'gpt-4o',
    openaiCompat: true,
    computerUse: false,
  },
  ollama: {
    name: 'Ollama (Local)',
    baseUrl: 'http://localhost:11434/v1',
    authHeader: () => ({}),
    textModel: 'qwen2.5:7b',
    visionModel: 'qwen2.5:7b', // no vision model locally by default
    openaiCompat: true,
    computerUse: false,
  },
  kimi: {
    name: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.cn/v1',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    textModel: 'moonshot-v1-8k',
    visionModel: 'moonshot-v1-8k', // Kimi doesn't have a separate vision model
    openaiCompat: true,
    computerUse: false,
  },
};

/**
 * Auto-detect provider from API key format or explicit provider name.
 */
export function detectProvider(apiKey: string, explicitProvider?: string): string {
  if (explicitProvider && PROVIDERS[explicitProvider]) return explicitProvider;

  if (!apiKey) return 'ollama'; // No key = local mode
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('sk-') && apiKey.length > 60) return 'kimi'; // Kimi keys are longer than OpenAI
  if (apiKey.startsWith('sk-')) return 'openai';

  return 'openai'; // Default fallback
}

export interface PipelineConfig {
  /** Provider profile */
  provider: ProviderProfile;
  /** Provider key name */
  providerKey: string;
  /** API key */
  apiKey: string;
  /** Layer 1: Action router (always on) */
  layer1: true;
  /** Layer 2: Accessibility reasoner with text model */
  layer2: {
    enabled: boolean;
    model: string;
    baseUrl: string;
  };
  /** Layer 3: Screenshot + vision model */
  layer3: {
    enabled: boolean;
    model: string;
    baseUrl: string;
    computerUse: boolean;
  };
}

/**
 * Build the optimal pipeline config from test results.
 */
export function buildPipeline(
  providerKey: string,
  apiKey: string,
  textModelWorks: boolean,
  visionModelWorks: boolean,
  textModelOverride?: string,
  visionModelOverride?: string,
): PipelineConfig {
  const provider = PROVIDERS[providerKey] || PROVIDERS['ollama'];

  return {
    provider,
    providerKey,
    apiKey,
    layer1: true,
    layer2: {
      enabled: textModelWorks,
      model: textModelOverride || provider.textModel,
      baseUrl: provider.baseUrl,
    },
    layer3: {
      enabled: visionModelWorks,
      model: visionModelOverride || provider.visionModel,
      baseUrl: provider.baseUrl,
      computerUse: provider.computerUse,
    },
  };
}
