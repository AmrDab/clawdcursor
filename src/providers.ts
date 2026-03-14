import { resolveApiConfig } from './credentials';

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
    textModel: '',  // auto-detected from available models by doctor
    visionModel: '', // auto-detected from available models by doctor
    openaiCompat: true,
    computerUse: false,
  },
  kimi: {
    name: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.cn/v1',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    textModel: 'moonshot-v1-8k',
    visionModel: 'moonshot-v1-8k',
    openaiCompat: true,
    computerUse: false,
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    textModel: 'llama-3.3-70b-versatile',
    visionModel: 'llama-3.2-90b-vision-preview',
    openaiCompat: true,
    computerUse: false,
  },
  together: {
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    textModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
    visionModel: 'meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo',
    openaiCompat: true,
    computerUse: false,
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    textModel: 'deepseek-chat',
    visionModel: 'deepseek-chat',
    openaiCompat: true,
    computerUse: false,
  },
  gemini: {
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    textModel: 'gemini-2.0-flash',
    visionModel: 'gemini-2.0-flash',
    openaiCompat: true,
    computerUse: false,
  },
  mistral: {
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    textModel: 'mistral-small-latest',
    visionModel: 'pixtral-large-latest',
    openaiCompat: true,
    computerUse: false,
  },
  xai: {
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    textModel: 'grok-3-mini',
    visionModel: 'grok-2-vision-1212',
    openaiCompat: true,
    computerUse: false,
  },
  generic: {
    name: 'OpenAI-Compatible',
    baseUrl: '', // set from config
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    textModel: '', // set from config
    visionModel: '', // set from config  
    openaiCompat: true,
    computerUse: false,
  },
};

/**
 * Auto-detect provider from API key format or explicit provider name.
 */
export function detectProvider(apiKey: string, explicitProvider?: string): string {
  if (explicitProvider) {
    // Accept ANY provider name — if it's in PROVIDERS use it, otherwise treat as generic
    if (PROVIDERS[explicitProvider]) return explicitProvider;
    return 'generic'; 
  }

  if (!apiKey) return 'ollama'; // No key = local mode
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('AIza')) return 'gemini';           // Google Gemini API keys start with AIza
  if (apiKey.startsWith('xai-')) return 'xai';             // xAI Grok
  if (apiKey.startsWith('sk-') && apiKey.length > 60) return 'kimi'; // Kimi keys are longer than OpenAI
  if (apiKey.startsWith('sk-')) return 'openai';
  if (apiKey.startsWith('gsk_')) return 'groq';

  return 'openai'; // Default fallback — most providers use OpenAI-compatible API
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
    apiKey?: string;
  };
  /** v0.8.0: OCR-first pipeline — enabled when OS OCR is available */
  ocrEnabled?: boolean;
  /** v0.8.0: Skill cache — learns from successful task completions */
  skillCacheEnabled?: boolean;
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
 * AI_API_KEY is a generic fallback; external config provider hints are preferred.
 */

const PROVIDER_ENV_VARS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  groq: ['GROQ_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
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
  const resolvedApi = resolveApiConfig();
  const genericKey = resolvedApi.apiKey || process.env.AI_API_KEY || '';
  const genericProviderHint = resolvedApi.provider || '';
  const isExternalSource = resolvedApi.source === 'external';

  // When credentials come from external config, load ALL provider keys from config files
  const externalProviderKeys: Record<string, { apiKey: string; baseUrl?: string }> = {};
  if (resolvedApi.source === 'external') {
    // resolveApiConfig only returns the "best" provider.
    // We need ALL of them for scanning. Read auth-profiles directly.
    try {
      const os = await import('os');
      const fs = await import('fs');
      const path = await import('path');
      const home = os.homedir();
      const roots = [path.join(home, '.openclaw'), path.join(home, '.openclaw-dev')];
      
      for (const root of roots) {
        // Read auth-profiles for API keys
        const authPaths = [
          path.join(root, 'agents', 'main', 'agent', 'auth-profiles.json'),
          path.join(root, 'agents', 'main', 'auth-profiles.json'),
        ];
        
        for (const authPath of authPaths) {
          try {
            if (!fs.existsSync(authPath)) continue;
            const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
            const profiles = auth?.profiles || auth;
            if (!profiles || typeof profiles !== 'object') continue;
            
            for (const [profileKey, profileValue] of Object.entries(profiles)) {
              const providerName = profileKey.split(':')[0].toLowerCase();
              const val = profileValue as any;
              const apiKey = val?.key || val?.apiKey || val?.api_key || '';
              if (!apiKey) continue;
              
              // Map external provider names to Clawd Cursor provider keys
              const providerMap: Record<string, string> = {
                'anthropic': 'anthropic',
                'openai': 'openai',
                'moonshot': 'kimi',
                'kimi': 'kimi',
                'groq': 'groq',
                'together': 'together',
                'deepseek': 'deepseek',
              };
              
              const clawdKey = providerMap[providerName];
              if (clawdKey && !externalProviderKeys[clawdKey]) {
                externalProviderKeys[clawdKey] = { apiKey };
              }
            }
          } catch { /* skip */ }
        }
        
        // Read openclaw.json for base URLs
        const configPaths = [
          path.join(root, 'openclaw.json'),
          path.join(root, 'agents', 'main', 'openclaw.json'),
        ];
        
        for (const configPath of configPaths) {
          try {
            if (!fs.existsSync(configPath)) continue;
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            const providers = cfg?.models?.providers || {};
            
            for (const [provName, provConfig] of Object.entries(providers)) {
              const pConfig = provConfig as any;
              const baseUrl = pConfig?.baseUrl;
              const providerMap: Record<string, string> = {
                'anthropic': 'anthropic',
                'openai': 'openai',
                'moonshot': 'kimi',
                'kimi': 'kimi',
                'groq': 'groq',
                'together': 'together',
                'deepseek': 'deepseek',
                'nvidia': 'nvidia',
                'ollama': 'ollama',
              };
              
              const clawdKey = providerMap[provName.toLowerCase()];
              if (clawdKey && externalProviderKeys[clawdKey] && baseUrl) {
                externalProviderKeys[clawdKey].baseUrl = baseUrl;
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* External config read failed, continue with existing logic */ }

    if (Object.keys(externalProviderKeys).length > 0) {
      console.log(`   🔗 External providers detected: ${Object.keys(externalProviderKeys).join(', ')}`);
    }
  }

  // ── Check key-based providers ─────────────────────────────────
  for (const providerKey of Object.keys(PROVIDER_ENV_VARS)) {
    const envVars = PROVIDER_ENV_VARS[providerKey];
    let key = '';

    if (genericProviderHint === providerKey && genericKey) {
      key = genericKey;
    } else if (isExternalSource && !genericProviderHint && providerKey === 'openai' && genericKey) {
      // External config may provide an OpenAI-compatible endpoint without a provider label.
      key = genericKey;
    }

    for (const envVar of envVars) {
      if (key) break;
      if (process.env[envVar]) {
        key = process.env[envVar]!;
        break;
      }
    }

    // External multi-provider keys
    if (!key && externalProviderKeys[providerKey]) {
      key = externalProviderKeys[providerKey].apiKey;
    }

    // For standalone AI_API_KEY, infer provider by key format as a best-effort fallback.
    if (!key && genericKey && !(isExternalSource && !genericProviderHint)) {
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

  // ── Create dynamic provider entries for unknown external providers ──────
  if (resolvedApi.source === 'external') {
    try {
      const os = await import('os');
      const fs = await import('fs');
      const path = await import('path');
      const home = os.homedir();
      const roots = [path.join(home, '.openclaw'), path.join(home, '.openclaw-dev')];
      
      for (const root of roots) {
        const configPaths = [
          path.join(root, 'openclaw.json'),
          path.join(root, 'agents', 'main', 'openclaw.json'),
        ];
        
        for (const configPath of configPaths) {
          try {
            if (!fs.existsSync(configPath)) continue;
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            const providers = cfg?.models?.providers || {};
            
            for (const [provName, provConfig] of Object.entries(providers)) {
              const providerNameLower = provName.toLowerCase();
              const pConfig = provConfig as any;
              const baseUrl = pConfig?.baseUrl;
              const models = pConfig?.models || {};
              
              // Skip providers we already handle
              const knownProvider = Object.values(PROVIDERS).some(p => 
                p.baseUrl === baseUrl || providerNameLower.includes(p.name.toLowerCase().split(' ')[0])
              );
              if (knownProvider) continue;
              if (!baseUrl) continue;
              
              // Find API key for this provider
              const authPaths = [
                path.join(root, 'agents', 'main', 'agent', 'auth-profiles.json'),
                path.join(root, 'agents', 'main', 'auth-profiles.json'),
              ];
              
              let apiKey = '';
              for (const authPath of authPaths) {
                try {
                  if (!fs.existsSync(authPath)) continue;
                  const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
                  const profiles = auth?.profiles || auth;
                  if (!profiles || typeof profiles !== 'object') continue;
                  
                  for (const [profileKey, profileValue] of Object.entries(profiles)) {
                    const profileProviderName = profileKey.split(':')[0].toLowerCase();
                    if (profileProviderName === providerNameLower) {
                      const val = profileValue as any;
                      apiKey = val?.key || val?.apiKey || val?.api_key || '';
                      break;
                    }
                  }
                  if (apiKey) break;
                } catch { /* skip */ }
              }
              
              if (!apiKey) continue;
              
              // Extract model names from external config
              const textModels = Object.keys(models).filter(m => 
                !m.toLowerCase().includes('vision') && 
                !m.toLowerCase().includes('dall-e') &&
                !m.toLowerCase().includes('tts')
              );
              const visionModels = Object.keys(models).filter(m => 
                m.toLowerCase().includes('vision') || 
                m.toLowerCase().includes('4o') ||
                m.toLowerCase().includes('claude')
              );
              
              const textModel = textModels[0] || Object.keys(models)[0] || '';
              const visionModel = visionModels[0] || textModel;
              
              if (!textModel) continue;
              
              // Create dynamic provider entry
              const dynamicProviderKey = providerNameLower.replace(/[^a-z0-9]/g, '');
              
              // Add to PROVIDERS map dynamically (but don't mutate the original)
              const dynamicProvider: ProviderProfile = {
                name: provName,
                baseUrl: baseUrl,
                authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
                textModel: textModel,
                visionModel: visionModel,
                openaiCompat: true, // Most providers are OpenAI-compatible except Anthropic
                computerUse: false,
              };
              
              // Don't add to PROVIDERS directly (immutable), but create scan result
              if (!results.find(r => r.key === dynamicProviderKey)) {
                results.push({
                  key: dynamicProviderKey,
                  name: provName,
                  available: true,
                  detail: `external config (${maskKey(apiKey)})`,
                  apiKey: apiKey,
                });
                
                // Store the dynamic provider for later use
                (PROVIDERS as any)[dynamicProviderKey] = dynamicProvider;
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* External dynamic provider creation failed, continue */ }
  }

  // Apply external base URLs to custom providers (e.g., moonshot uses api.moonshot.cn, not openai.com)
  for (const result of results) {
    if (externalProviderKeys[result.key]?.baseUrl && result.available) {
      // Store for later use in pipeline building
      (result as any).externalBaseUrl = externalProviderKeys[result.key].baseUrl;
    }
  }

  return results;
}

/** Text model preference: fastest/most-reliable first */
const TEXT_MODEL_PREFERENCE: string[] = ['ollama', 'groq', 'together', 'deepseek', 'anthropic', 'openai', 'kimi'];

/** Vision model preference: best vision capability first */
const VISION_MODEL_PREFERENCE: string[] = ['anthropic', 'openai', 'groq', 'together', 'kimi', 'deepseek', 'ollama'];

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
