import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * OpenClaw-aware credential resolution.
 *
 * In skill mode, Clawd Cursor should reuse OpenClaw's configured providers/models
 * instead of inferring provider from key prefixes.
 */

export interface ResolvedApiConfig {
  provider?: string;
  apiKey: string;
  baseUrl?: string;
  textModel?: string;
  visionModel?: string;
  textApiKey?: string;
  textBaseUrl?: string;
  visionApiKey?: string;
  visionBaseUrl?: string;
  source: 'openclaw' | 'local';
}

interface ModelInfo {
  id: string;
  input: string[];
}

interface ProviderInfo {
  key: string;
  apiKey?: string;
  baseUrl?: string;
  models: ModelInfo[];
}


function normalizeProviderKey(key: string): string {
  const lower = key.toLowerCase().trim();
  if (!lower) return lower;
  return lower.split(':')[0];
}

function normalizeProvider(provider?: string): string | undefined {
  if (!provider) return undefined;
  const p = provider.trim().toLowerCase();
  return p.length > 0 ? p : undefined;
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

function inferProviderFromBaseUrl(baseUrl?: string): string | undefined {
  const url = (baseUrl || '').toLowerCase();
  if (!url) return undefined;
  if (url.includes('anthropic')) return 'anthropic';
  if (url.includes('moonshot') || url.includes('kimi')) return 'kimi';
  if (url.includes('11434') || url.includes('ollama')) return 'ollama';
  if (url.includes('openai')) return 'openai';
  if (url.includes('groq')) return 'groq';
  if (url.includes('together')) return 'together';
  if (url.includes('deepseek')) return 'deepseek';
  if (url.includes('nvidia') || url.includes('integrate.api')) return 'nvidia';
  if (url.includes('mistral')) return 'mistral';
  if (url.includes('fireworks')) return 'fireworks';
  // Unknown endpoint — still works, just no provider label
  return undefined;
}

function safeReadJson(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractApiKeyLike(value: any): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (isObject(value)) {
    return pick(
      value.apiKey,
      value.api_key,
      value.key,
      value.token,
      value.accessToken,
      value.access_token,
      value.access,
      value.oauthAccessToken,
      value.oauth_access_token,
      value.bearer,
      value.oauth?.accessToken,
      value.oauth?.access_token,
      value.oauth?.access,
    );
  }
  return undefined;
}

function extractBaseUrlLike(value: any): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return normalizeBaseUrl(value);
  if (isObject(value)) {
    return normalizeBaseUrl(pick(value.baseUrl, value.base_url, value.endpoint, value.url));
  }
  return undefined;
}

function normalizeModelEntry(model: any): ModelInfo | null {
  if (!model) return null;
  const id = typeof model === 'string'
    ? model
    : pick(model.id, model.model, model.modelId, model.name);
  if (!id) return null;

  const input = Array.isArray(model.input)
    ? model.input.map((x: any) => String(x).toLowerCase())
    : [];

  return { id, input };
}

function getOpenClawRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.openclaw'),
    path.join(home, '.openclaw-dev'),
  ];
}

function loadOpenClawProviderMap(): Record<string, ProviderInfo> {
  const providers: Record<string, ProviderInfo> = {};

  const ensureProvider = (key: string): ProviderInfo => {
    const normalizedKey = normalizeProviderKey(key);
    if (!providers[normalizedKey]) {
      providers[normalizedKey] = { key: normalizedKey, models: [] };
    }
    return providers[normalizedKey];
  };

  for (const root of getOpenClawRoots()) {
    const authCandidates = [
      path.join(root, 'agents', 'main', 'agent', 'auth-profiles.json'),
      path.join(root, 'agents', 'main', 'auth-profiles.json'),
    ];

    const configCandidates = [
      path.join(root, 'openclaw.json'),
      path.join(root, 'agents', 'main', 'openclaw.json'),
      path.join(root, 'agents', 'main', 'agent', 'openclaw.json'),
    ];

    for (const authPath of authCandidates) {
      const auth = safeReadJson(authPath);
      if (!auth) continue;

      const containers = [auth, auth.profiles, auth.providers, auth.authProfiles];
      for (const container of containers) {
        if (!isObject(container)) continue;
        for (const [key, value] of Object.entries(container)) {
          const entry = ensureProvider(key);
          const apiKey = extractApiKeyLike(value);
          const baseUrl = extractBaseUrlLike(value);
          if (apiKey) entry.apiKey = apiKey;
          if (baseUrl) entry.baseUrl = baseUrl;

          const maybeModels = isObject(value) ? (value.models || value.availableModels) : null;
          if (Array.isArray(maybeModels)) {
            for (const m of maybeModels) {
              const normalized = normalizeModelEntry(m);
              if (normalized) entry.models.push(normalized);
            }
          }
        }
      }
    }

    for (const configPath of configCandidates) {
      const cfg = safeReadJson(configPath);
      if (!cfg) continue;

      const providerBlocks = [
        cfg?.models?.providers,
        cfg?.providers,
      ];

      for (const block of providerBlocks) {
        if (!isObject(block)) continue;
        for (const [key, value] of Object.entries(block)) {
          const entry = ensureProvider(key);
          const apiKey = extractApiKeyLike(value);
          const baseUrl = extractBaseUrlLike(value);
          if (apiKey && !entry.apiKey) entry.apiKey = apiKey;
          if (baseUrl && !entry.baseUrl) entry.baseUrl = baseUrl;

          if (isObject(value) && Array.isArray(value.models)) {
            for (const m of value.models) {
              const normalized = normalizeModelEntry(m);
              if (normalized) entry.models.push(normalized);
            }
          }
        }
      }
    }
  }

  // De-duplicate models by id
  for (const entry of Object.values(providers)) {
    const seen = new Set<string>();
    entry.models = entry.models.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }

  return providers;
}

function selectVisionProvider(providers: ProviderInfo[]): ProviderInfo | null {
  for (const p of providers) {
    if (p.models.some(m => m.input.includes('image') || m.input.includes('vision'))) {
      return p;
    }
  }
  return null;
}

function selectTextProvider(providers: ProviderInfo[]): ProviderInfo | null {
  const ollama = providers.find(p => p.key === 'ollama' && p.models.length > 0);
  if (ollama) return ollama;
  return providers.find(p => p.models.length > 0) || null;
}

function resolveFromOpenClawFiles(): ResolvedApiConfig | null {
  const providerMap = loadOpenClawProviderMap();
  const providerList = Object.values(providerMap).filter(p => !!(p.apiKey || p.baseUrl || p.models.length > 0));
  if (providerList.length === 0) return null;

  const visionProvider = selectVisionProvider(providerList);
  const textProvider = selectTextProvider(providerList);

  const selectedProvider = visionProvider || textProvider;
  if (!selectedProvider) return null;

  const visionModel = visionProvider?.models.find(m => m.input.includes('image') || m.input.includes('vision'))?.id
    || textProvider?.models[0]?.id;
  const textModel = textProvider?.models.find(m => !m.input.includes('image') && !m.input.includes('vision'))?.id
    || textProvider?.models[0]?.id;

  return {
    apiKey: visionProvider?.apiKey || selectedProvider.apiKey || textProvider?.apiKey || '',
    baseUrl: visionProvider?.baseUrl || selectedProvider.baseUrl || textProvider?.baseUrl,
    textModel,
    visionModel,
    textApiKey: textProvider?.apiKey,
    textBaseUrl: textProvider?.baseUrl,
    visionApiKey: visionProvider?.apiKey || selectedProvider.apiKey,
    visionBaseUrl: visionProvider?.baseUrl || selectedProvider.baseUrl,
    provider: normalizeProvider(selectedProvider.key) || inferProviderFromBaseUrl(selectedProvider.baseUrl),
    source: 'openclaw',
  };
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
  // Explicit CLI flags always win over auto-detection
  if (opts?.apiKey || opts?.provider || opts?.baseUrl) {
    const explicitApiKey = opts.apiKey || '';
    const explicitBaseUrl = normalizeBaseUrl(opts.baseUrl);
    const explicitTextModel = pick(opts.textModel);
    const explicitVisionModel = pick(opts.visionModel);
    return {
      apiKey: explicitApiKey,
      provider: normalizeProvider(opts.provider) || inferProviderFromBaseUrl(explicitBaseUrl),
      baseUrl: explicitBaseUrl,
      textModel: explicitTextModel,
      visionModel: explicitVisionModel,
      textApiKey: explicitApiKey,
      textBaseUrl: explicitBaseUrl,
      visionApiKey: explicitApiKey,
      visionBaseUrl: explicitBaseUrl,
      source: 'local',
    };
  }

  const fromFiles = resolveFromOpenClawFiles();
  if (fromFiles) {
    return fromFiles;
  }

  // Transitional fallback if OpenClaw explicitly injects runtime env vars.
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
  )) || inferProviderFromBaseUrl(openClawBaseUrl);

  if (openClawKey || openClawBaseUrl || openClawTextModel || openClawVisionModel || openClawProvider) {
    return {
      apiKey: openClawKey,
      provider: openClawProvider,
      baseUrl: openClawBaseUrl,
      textModel: openClawTextModel,
      visionModel: openClawVisionModel,
      textApiKey: openClawKey,
      textBaseUrl: openClawBaseUrl,
      visionApiKey: openClawKey,
      visionBaseUrl: openClawBaseUrl,
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
      provider: normalizeProvider(opts?.provider) || inferProviderFromBaseUrl(localBaseUrl),
      baseUrl: localBaseUrl,
      textModel: localTextModel,
      visionModel: localVisionModel,
      textApiKey: explicitApiKey,
      textBaseUrl: localBaseUrl,
      visionApiKey: explicitApiKey,
      visionBaseUrl: localBaseUrl,
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
    provider: inferProviderFromBaseUrl(localBaseUrl),
    baseUrl: localBaseUrl,
    textModel: localTextModel,
    visionModel: localVisionModel,
    textApiKey: localApiKey,
    textBaseUrl: localBaseUrl,
    visionApiKey: localApiKey,
    visionBaseUrl: localBaseUrl,
    source: 'local',
  };
}
