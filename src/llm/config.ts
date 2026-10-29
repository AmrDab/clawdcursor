/**
 * llm-config.ts — Single config-resolution funnel for clawdcursor.
 *
 * Precedence ladder (first non-undefined value wins per field):
 *   CLI flags > project ./.clawdcursor-config.json > user ~/.clawdcursor/config.json
 *   > env vars (CLAWD_* canonical, OPENCLAW_* deprecated) > auto-detect via resolveApiConfig
 *   > DEFAULT_CONFIG
 *
 * Each field carries a `source` tag so doctor/status can report where each
 * value came from.
 *
 * OPENCLAW_* env vars are still read but emit a deprecation warning on first
 * read; CLAWD_* wins when both are set.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveApiConfig } from './credentials';
import { DEFAULT_CONFIG } from '../types';
import { getPackageRoot } from '../paths';

// ── Types ────────────────────────────────────────────────────────────────────

export type ConfigSource = 'cli' | 'project' | 'user' | 'env' | 'autodetect' | 'default';

export interface ResolvedConfig {
  // API / model
  apiKey: string;
  baseUrl: string | undefined;
  model: string;
  visionModel: string;
  visionApiKey: string | undefined;
  visionBaseUrl: string | undefined;
  textApiKey: string | undefined;
  textBaseUrl: string | undefined;
  provider: string | undefined;
  // Server
  port: number;
  // Behaviour flags
  debug: boolean;
  disableVision: boolean;
  // Source tracking
  source: {
    apiKey: ConfigSource;
    baseUrl: ConfigSource;
    model: ConfigSource;
    visionModel: ConfigSource;
    visionApiKey: ConfigSource;
    visionBaseUrl: ConfigSource;
    textApiKey: ConfigSource;
    textBaseUrl: ConfigSource;
    provider: ConfigSource;
    port: ConfigSource;
    debug: ConfigSource;
    disableVision: ConfigSource;
  };
}

export interface ResolveInput {
  /** Parsed CLI flags from commander (all optional). */
  cliFlags?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    textModel?: string;
    visionModel?: string;
    provider?: string;
    port?: number | string;
    debug?: boolean;
    noVision?: boolean;
  };
  /** Override the default project config path (./.clawdcursor-config.json). */
  projectConfigPath?: string;
  /** Override the default user config path (~/.clawdcursor/config.json). */
  userConfigPath?: string;
  /**
   * Inject a custom env map (useful for tests).
   * Defaults to process.env when absent.
   */
  envOverride?: Record<string, string | undefined>;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Whether we already warned about OPENCLAW_* → CLAWD_* migration this process. */
const _openClawWarnedFor = new Set<string>();

/**
 * Read a (possibly deprecated) pair of env var names.
 * canonical = CLAWD_FOO, legacy = OPENCLAW_FOO.
 * Returns the value and the source name (for warn dedup).
 */
function readEnvPair(
  canonical: string,
  legacy: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const canonicalVal = env[canonical];
  const legacyVal = env[legacy];

  if (canonicalVal && legacyVal) {
    // Both set — canonical wins; no deprecation warning needed because
    // the user is already migrating (has the new name set).
    return canonicalVal;
  }
  if (canonicalVal) {
    return canonicalVal;
  }
  if (legacyVal) {
    if (!_openClawWarnedFor.has(legacy)) {
      _openClawWarnedFor.add(legacy);

      console.warn(
        `[clawdcursor] Deprecation warning: env var ${legacy} is deprecated. ` +
        `Please rename it to ${canonical}. Support for ${legacy} will be removed in a future version.`
      );
    }
    return legacyVal;
  }
  return undefined;
}

/** Safely parse JSON from a file — returns null on any error (missing, bad JSON). */
function safeReadJson(filePath: string): Record<string, any> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Extract common fields from a stored config JSON (project or user). */
interface StoredConfigFields {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  visionModel?: string;
  visionApiKey?: string;
  visionBaseUrl?: string;
  textApiKey?: string;
  textBaseUrl?: string;
  provider?: string;
  port?: number;
  debug?: boolean;
  disableVision?: boolean;
}

/**
 * Model ids that no longer exist upstream (API returns 404), mapped to their
 * live replacement. Persisted configs OUTLIVE code defaults — auto-detect
 * writes the then-current id to disk, and per the precedence ladder that
 * saved value silently overrides any later code fix. Without this heal,
 * every install that ever saved a now-retired id keeps 404-ing after
 * upgrading (the agent runs fine on the text model, then dies on the first
 * turn that needs the retired one — which reads like a credits/auth failure).
 */
const RETIRED_MODEL_IDS: Record<string, string> = {
  'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
};

function healRetiredModel(id: string | undefined): string | undefined {
  if (!id) return id;
  const replacement = RETIRED_MODEL_IDS[id];
  if (!replacement) return id;
  console.warn(
    `[clawdcursor] Saved config pins retired model "${id}" (API returns 404) — using "${replacement}" instead. ` +
    `Run \`clawdcursor doctor\` to refresh the saved config.`,
  );
  return replacement;
}

function parseStoredConfig(json: Record<string, any>): StoredConfigFields {
  // Support both flat (user config) and pipeline-nested (project config) shapes.
  const result: StoredConfigFields = {};

  // Flat fields (user config or explicit project overrides)
  if (typeof json.apiKey === 'string' && json.apiKey) result.apiKey = json.apiKey;
  if (typeof json.baseUrl === 'string' && json.baseUrl) result.baseUrl = json.baseUrl;
  if (typeof json.model === 'string' && json.model) result.model = json.model;
  if (typeof json.visionModel === 'string' && json.visionModel) result.visionModel = json.visionModel;
  if (typeof json.visionApiKey === 'string' && json.visionApiKey) result.visionApiKey = json.visionApiKey;
  if (typeof json.visionBaseUrl === 'string' && json.visionBaseUrl) result.visionBaseUrl = json.visionBaseUrl;
  if (typeof json.textApiKey === 'string' && json.textApiKey) result.textApiKey = json.textApiKey;
  if (typeof json.textBaseUrl === 'string' && json.textBaseUrl) result.textBaseUrl = json.textBaseUrl;
  if (typeof json.provider === 'string' && json.provider) result.provider = json.provider;
  if (typeof json.port === 'number') result.port = json.port;
  // Nested `{"server":{"port":N}}` — the ClawdConfig shape the port messages name.
  else if (typeof json.server?.port === 'number') result.port = json.server.port;
  if (typeof json.debug === 'boolean') result.debug = json.debug;
  if (typeof json.disableVision === 'boolean') result.disableVision = json.disableVision;

  // Pipeline-nested (project config from doctor) — read model/baseUrl from pipeline layers
  const pipeline = json.pipeline;
  if (pipeline && typeof pipeline === 'object') {
    const text = pipeline.textModel ?? pipeline.layer2;
    const vision = pipeline.visionModel ?? pipeline.layer3;
    if (text && typeof text === 'object') {
      if (!result.model && typeof text.model === 'string' && text.model) result.model = text.model;
      if (!result.textBaseUrl && typeof text.baseUrl === 'string' && text.baseUrl) result.textBaseUrl = text.baseUrl;
      if (!result.baseUrl && typeof text.baseUrl === 'string' && text.baseUrl) result.baseUrl = text.baseUrl;
    }
    if (vision && typeof vision === 'object') {
      if (!result.visionModel && typeof vision.model === 'string' && vision.model) result.visionModel = vision.model;
      if (!result.visionBaseUrl && typeof vision.baseUrl === 'string' && vision.baseUrl) result.visionBaseUrl = vision.baseUrl;
    }
  }

  // Heal AFTER both shapes are merged so flat and pipeline-nested ids get the
  // same treatment (in-memory only — the file is left alone; every load heals).
  result.model = healRetiredModel(result.model);
  result.visionModel = healRetiredModel(result.visionModel);

  return result;
}

// ── resolveConfig ─────────────────────────────────────────────────────────────

/**
 * Walk the canonical precedence ladder and return a fully-resolved config
 * with per-field source tags.
 *
 * Precedence:
 *   CLI flags > project ./.clawdcursor-config.json > user ~/.clawdcursor/config.json
 *   > env vars (CLAWD_* > OPENCLAW_*) > resolveApiConfig auto-detect > DEFAULT_CONFIG
 */
export function resolveConfig(input?: ResolveInput): ResolvedConfig {
  const env = input?.envOverride ?? (process.env as Record<string, string | undefined>);

  // ── 1. Normalise CLI flags ──────────────────────────────────────────────────
  const cli = input?.cliFlags;
  const cliApiKey      = cli?.apiKey;
  const cliBaseUrl     = cli?.baseUrl;
  // commander uses --text-model for the text/reasoning model
  const cliModel       = cli?.textModel ?? cli?.model;
  const cliVisionModel = cli?.visionModel ?? cli?.model;
  const cliProvider    = cli?.provider;
  const cliPort        = cli?.port !== undefined ? Number(cli.port) : undefined;
  const cliDebug       = cli?.debug;
  const cliNoVision    = cli?.noVision;

  // ── 2. Load project config (./.clawdcursor-config.json) ────────────────────
  const projectConfigPath = input?.projectConfigPath
    ?? (() => {
      // Match loadPipelineConfig precedence: pkg dir first, then cwd
      const pkgPath = path.resolve(getPackageRoot(), '.clawdcursor-config.json');
      if (fs.existsSync(pkgPath)) return pkgPath;
      return path.join(process.cwd(), '.clawdcursor-config.json');
    })();
  const projectJson = safeReadJson(projectConfigPath);
  const project = projectJson ? parseStoredConfig(projectJson) : {};

  // ── 3. Load user config (~/.clawdcursor/config.json) ───────────────────────
  const userConfigPath = input?.userConfigPath
    ?? path.join(os.homedir(), '.clawdcursor', 'config.json');
  const userJson = safeReadJson(userConfigPath);
  const user = userJson ? parseStoredConfig(userJson) : {};

  // ── 4. Env vars — CLAWD_* canonical, OPENCLAW_* deprecated ────────────────
  const envApiKey      = readEnvPair('CLAWD_API_KEY',          'OPENCLAW_API_KEY',          env)
                      ?? readEnvPair('CLAWD_AI_API_KEY',       'OPENCLAW_AI_API_KEY',       env)
                      ?? readEnvPair('CLAWD_AGENT_API_KEY',    'OPENCLAW_AGENT_API_KEY',    env);
  const envBaseUrl     = readEnvPair('CLAWD_BASE_URL',         'OPENCLAW_BASE_URL',         env)
                      ?? readEnvPair('CLAWD_AI_BASE_URL',      'OPENCLAW_AI_BASE_URL',      env)
                      ?? readEnvPair('CLAWD_AGENT_BASE_URL',   'OPENCLAW_AGENT_BASE_URL',   env);
  const envModel       = readEnvPair('CLAWD_TEXT_MODEL',       'OPENCLAW_TEXT_MODEL',       env)
                      ?? readEnvPair('CLAWD_AI_TEXT_MODEL',    'OPENCLAW_AI_TEXT_MODEL',    env)
                      ?? readEnvPair('CLAWD_MODEL',            'OPENCLAW_MODEL',            env);
  const envVisionModel = readEnvPair('CLAWD_VISION_MODEL',     'OPENCLAW_VISION_MODEL',     env)
                      ?? readEnvPair('CLAWD_AI_VISION_MODEL',  'OPENCLAW_AI_VISION_MODEL',  env)
                      ?? readEnvPair('CLAWD_MODEL',            'OPENCLAW_MODEL',            env);
  const envProvider    = readEnvPair('CLAWD_PROVIDER',         'OPENCLAW_PROVIDER',         env)
                      ?? readEnvPair('CLAWD_AI_PROVIDER',      'OPENCLAW_AI_PROVIDER',      env)
                      ?? readEnvPair('CLAWD_AGENT_PROVIDER',   'OPENCLAW_AGENT_PROVIDER',   env);

  // Boolean env flags — CLAWD_* > OPENCLAW_*
  const envDisableVisionStr   = readEnvPair('CLAWD_DISABLE_VISION',   'OPENCLAW_DISABLE_VISION',   env);
  const envDisableVision   = envDisableVisionStr   !== undefined ? (envDisableVisionStr   === '1' || envDisableVisionStr   === 'true') : undefined;

  // ── 5. Auto-detect via resolveApiConfig ────────────────────────────────────
  // Only call when no higher-priority source supplied an apiKey / baseUrl.
  // We always call it because it also reads generic AI_API_KEY, ANTHROPIC_API_KEY, etc.
  const autoResolved = resolveApiConfig({
    apiKey:    cliApiKey,
    provider:  cliProvider,
    baseUrl:   cliBaseUrl,
    textModel: cliModel,
    visionModel: cliVisionModel,
  });

  // ── 6. Precedence-walk each field ─────────────────────────────────────────
  function firstDefined<T>(candidates: Array<[T | undefined, ConfigSource]>): [T, ConfigSource] {
    for (const [val, src] of candidates) {
      if (val !== undefined && val !== null && val !== '') {
        return [val, src];
      }
    }
    return candidates[candidates.length - 1] as [T, ConfigSource];
  }

  // apiKey
  const [apiKey, apiKeySrc] = firstDefined<string>([
    [cliApiKey,            'cli'],
    [project.apiKey,       'project'],
    [user.apiKey,          'user'],
    [envApiKey,            'env'],
    [autoResolved.apiKey,  'autodetect'],
    ['',                   'default'],
  ]);

  // baseUrl
  const [baseUrl, baseUrlSrc] = firstDefined<string | undefined>([
    [cliBaseUrl,            'cli'],
    [project.baseUrl,       'project'],
    [user.baseUrl,          'user'],
    [envBaseUrl,            'env'],
    [autoResolved.baseUrl,  'autodetect'],
    [undefined,             'default'],
  ]);

  // model (text model)
  const [model, modelSrc] = firstDefined<string>([
    [cliModel,               'cli'],
    [project.model,          'project'],
    [user.model,             'user'],
    [envModel,               'env'],
    [autoResolved.textModel, 'autodetect'],
    [DEFAULT_CONFIG.ai.model,'default'],
  ]);

  // visionModel
  const [visionModel, visionModelSrc] = firstDefined<string>([
    [cliVisionModel,               'cli'],
    [project.visionModel,          'project'],
    [user.visionModel,             'user'],
    [envVisionModel,               'env'],
    [autoResolved.visionModel,     'autodetect'],
    [DEFAULT_CONFIG.ai.visionModel,'default'],
  ]);

  // provider
  const [provider, providerSrc] = firstDefined<string | undefined>([
    [cliProvider,             'cli'],
    [project.provider,        'project'],
    [user.provider,           'user'],
    [envProvider,             'env'],
    [autoResolved.provider,   'autodetect'],
    [undefined,               'default'],
  ]);

  // visionApiKey
  const [visionApiKey, visionApiKeySrc] = firstDefined<string | undefined>([
    [cliApiKey,                    'cli'],
    [project.visionApiKey,         'project'],
    [user.visionApiKey,            'user'],
    [envApiKey,                    'env'],
    [autoResolved.visionApiKey,    'autodetect'],
    [undefined,                    'default'],
  ]);

  // visionBaseUrl
  const [visionBaseUrl, visionBaseUrlSrc] = firstDefined<string | undefined>([
    [cliBaseUrl,                   'cli'],
    [project.visionBaseUrl,        'project'],
    [user.visionBaseUrl,           'user'],
    [envBaseUrl,                   'env'],
    [autoResolved.visionBaseUrl,   'autodetect'],
    [undefined,                    'default'],
  ]);

  // textApiKey
  const [textApiKey, textApiKeySrc] = firstDefined<string | undefined>([
    [cliApiKey,                    'cli'],
    [project.textApiKey,           'project'],
    [user.textApiKey,              'user'],
    [envApiKey,                    'env'],
    [autoResolved.textApiKey,      'autodetect'],
    [undefined,                    'default'],
  ]);

  // textBaseUrl
  const [textBaseUrl, textBaseUrlSrc] = firstDefined<string | undefined>([
    [cliBaseUrl,                   'cli'],
    [project.textBaseUrl,          'project'],
    [user.textBaseUrl,             'user'],
    [envBaseUrl,                   'env'],
    [autoResolved.textBaseUrl,     'autodetect'],
    [undefined,                    'default'],
  ]);

  // port
  const [port, portSrc] = firstDefined<number>([
    [cliPort !== undefined && !isNaN(cliPort) ? cliPort : undefined, 'cli'],
    [project.port,                  'project'],
    [user.port,                     'user'],
    [DEFAULT_CONFIG.server.port,    'default'],
  ]);

  // debug
  const [debug, debugSrc] = firstDefined<boolean>([
    [cliDebug,         'cli'],
    [project.debug,    'project'],
    [user.debug,       'user'],
    [false,            'default'],
  ]);

  // disableVision — CLI --no-vision flag + env
  const [disableVision, disableVisionSrc] = firstDefined<boolean>([
    [cliNoVision === true ? true : undefined, 'cli'],
    [project.disableVision,   'project'],
    [user.disableVision,      'user'],
    [envDisableVision,        'env'],
    [false,                   'default'],
  ]);

  return {
    apiKey,
    baseUrl,
    model,
    visionModel,
    visionApiKey,
    visionBaseUrl,
    textApiKey,
    textBaseUrl,
    provider,
    port,
    debug,
    disableVision,
    source: {
      apiKey:          apiKeySrc,
      baseUrl:         baseUrlSrc,
      model:           modelSrc,
      visionModel:     visionModelSrc,
      visionApiKey:    visionApiKeySrc,
      visionBaseUrl:   visionBaseUrlSrc,
      textApiKey:      textApiKeySrc,
      textBaseUrl:     textBaseUrlSrc,
      provider:        providerSrc,
      port:            portSrc,
      debug:           debugSrc,
      disableVision:   disableVisionSrc,
    },
  };
}

/** Clear the per-process deprecation-warning dedup set. Useful in tests. */
export function _clearDeprecationCache(): void {
  _openClawWarnedFor.clear();
}
