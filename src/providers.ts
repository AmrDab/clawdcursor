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
    textModel: 'claude-haiku-4-5',
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

// ─── Multi-Provider Scanning ──────────────────────────────────────

/** Well-known vision-capable Ollama model name prefixes */
const OLLAMA_VISION_PREFIXES = [
  'llava', 'bakllava', 'llava-llama3', 'llava-phi3', 'moondream',
  'minicpm-v', 'cogvlm', 'yi-vl', 'obsidian',
];

/** Result of scanning a single provider */
export interface ProviderScanResult {
  key: string;
  name: string;
  available: boolean;
  /** For key-based providers: masked key.  For Ollama: 'reachable' or 'unreachable' */
  detail: string;
  /** API key to use (empty string for Ollama) */
  apiKey: string;
  /** Ollama-specific: list of discovered model ids */
  ollamaModels?: string[];
  /** Ollama-specific: which discovered models are vision-capable */
  ollamaVisionModels?: string[];
}

/** Result of testing a specific model */
export interface ModelTestResult {
  providerKey: string;
  model: string;
  role: 'text' | 'vision';
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/** Complete scan result */
export interface ScanResult {
  providers: ProviderScanResult[];
  modelTests: ModelTestResult[];
}

/**
 * Mask an API key for display: show first 8 chars + "..."
 */
function maskKey(key: string): string {
  if (key.length <= 12) return key.substring(0, 4) + '...';
  return key.substring(0, 8) + '...';
}

/**
 * Check if an Ollama model name is likely vision-capable.
 */
function isOllamaVisionModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return OLLAMA_VISION_PREFIXES.some(prefix => lower.startsWith(prefix));
}

/**
 * Env var names we check per provider key.
 * AI_API_KEY is a generic fallback — we try to detect its provider from format.
 */

function openClawEnvApiKey(): string {
  return (
    process.env.OPENCLAW_AI_API_KEY ||
    process.env.OPENCLAW_API_KEY ||
    process.env.OPENCLAW_AGENT_API_KEY ||
    ''
  );
}

function openClawEnvProvider(): string {
  return (
    (process.env.OPENCLAW_PROVIDER ||
    process.env.OPENCLAW_AI_PROVIDER ||
    process.env.OPENCLAW_AGENT_PROVIDER || '').toLowerCase()
  );
}

const PROVIDER_ENV_VARS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
};

/**
 * Scan ALL available AI providers in parallel.
 *
 * Returns which providers are available (have keys / are reachable),
 * discovered Ollama models, etc.
 */
export async function scanProviders(): Promise<ProviderScanResult[]> {
  const results: ProviderScanResult[] = [];

  // Collect the generic AI_API_KEY — we'll assign it to the matching provider later
  const genericKey = openClawEnvApiKey() || process.env.AI_API_KEY || '';

  // ── Check key-based providers ─────────────────────────────────
  for (const providerKey of ['anthropic', 'openai', 'kimi'] as const) {
    const envVars = PROVIDER_ENV_VARS[providerKey];
    let key = '';

    const openClawProvider = openClawEnvProvider();
    if (openClawProvider === providerKey && genericKey) {
      key = genericKey;
    }

    for (const envVar of envVars) {
      if (key) break;
      if (process.env[envVar]) {
        key = process.env[envVar]!;
        break;
      }
    }

    // Also consider AI_API_KEY if it matches this provider's format
    if (!key && genericKey) {
      const detected = detectProvider(genericKey);
      if (detected === providerKey) {
        key = genericKey;
      }
    }

    results.push({
      key: providerKey,
      name: PROVIDERS[providerKey].name,
      available: !!key,
      detail: key ? `key found (${maskKey(key)})` : 'no key',
      apiKey: key,
    });
  }

  // ── Check Ollama ──────────────────────────────────────────────
  const ollamaResult: ProviderScanResult = {
    key: 'ollama',
    name: PROVIDERS['ollama'].name,
    available: false,
    detail: 'not reachable',
    apiKey: '',
    ollamaModels: [],
    ollamaVisionModels: [],
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('http://localhost:11434/v1/models', {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json() as any;
      // /v1/models returns { data: [{ id: "model-name", ... }] }
      const models: string[] = (data.data || []).map((m: any) => m.id as string).filter(Boolean);
      const visionModels = models.filter(isOllamaVisionModel);

      ollamaResult.available = true;
      ollamaResult.ollamaModels = models;
      ollamaResult.ollamaVisionModels = visionModels;

      if (models.length > 0) {
        const modelList = models.slice(0, 5).join(', ') + (models.length > 5 ? `, +${models.length - 5} more` : '');
        ollamaResult.detail = `running (${modelList})`;
      } else {
        ollamaResult.detail = 'running (no models pulled)';
      }
    } else {
      ollamaResult.detail = `responded with HTTP ${res.status}`;
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      ollamaResult.detail = 'timeout (5s)';
    } else if (err.cause && (err.cause as any).code === 'ECONNREFUSED') {
      ollamaResult.detail = 'not installed / not running';
    } else if (err.message?.includes('ECONNREFUSED') || err.message?.includes('fetch failed')) {
      ollamaResult.detail = 'not installed / not running';
    } else {
      ollamaResult.detail = `error: ${err.message || err}`;
    }
  }

  results.push(ollamaResult);

  return results;
}

/** Text model preference: cheapest first */
const TEXT_MODEL_PREFERENCE: string[] = ['ollama', 'kimi', 'openai', 'anthropic'];

/** Vision model preference: best first */
const VISION_MODEL_PREFERENCE: string[] = ['anthropic', 'openai', 'kimi', 'ollama'];

/**
 * Given scan results and model test results, build the optimal mixed pipeline.
 */
export function buildMixedPipeline(
  scanResults: ProviderScanResult[],
  modelTests: ModelTestResult[],
): PipelineConfig {
  const workingText = modelTests.filter(t => t.role === 'text' && t.ok);
  const workingVision = modelTests.filter(t => t.role === 'vision' && t.ok);

  // Pick cheapest working text model
  let bestText: ModelTestResult | undefined;
  for (const pref of TEXT_MODEL_PREFERENCE) {
    const match = workingText.find(t => t.providerKey === pref);
    if (match) { bestText = match; break; }
  }

  // Pick best working vision model
  let bestVision: ModelTestResult | undefined;
  for (const pref of VISION_MODEL_PREFERENCE) {
    const match = workingVision.find(t => t.providerKey === pref);
    if (match) { bestVision = match; break; }
  }

  // Determine primary provider key (prefer vision provider for the "main" provider)
  const primaryKey = bestVision?.providerKey || bestText?.providerKey || 'ollama';
  const scanForPrimary = scanResults.find(s => s.key === primaryKey);
  const primaryProvider = PROVIDERS[primaryKey] || PROVIDERS['ollama'];
  const primaryApiKey = scanForPrimary?.apiKey || '';

  const textProviderKey = bestText?.providerKey || primaryKey;
  const textScan = scanResults.find(s => s.key === textProviderKey);
  const textProvider = PROVIDERS[textProviderKey] || PROVIDERS['ollama'];

  const visionProviderKey = bestVision?.providerKey || primaryKey;
  const visionProvider = PROVIDERS[visionProviderKey] || PROVIDERS['ollama'];

  return {
    provider: primaryProvider,
    providerKey: primaryKey,
    apiKey: primaryApiKey,
    layer1: true,
    layer2: {
      enabled: !!bestText,
      model: bestText?.model || textProvider.textModel,
      baseUrl: textProvider.baseUrl,
    },
    layer3: {
      enabled: !!bestVision,
      model: bestVision?.model || visionProvider.visionModel,
      baseUrl: visionProvider.baseUrl,
      computerUse: visionProvider.computerUse,
    },
  };
}
