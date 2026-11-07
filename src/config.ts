/**
 * config.ts — Config resolution for the daemon (port, debug, vision).
 *
 * Precedence ladder (first defined value wins per field):
 *   CLI flags > project ./.clawdcursor-config.json > user ~/.clawdcursor/config.json
 *   > env vars (CLAWD_* canonical, OPENCLAW_* deprecated) > DEFAULT_CONFIG
 *
 * OPENCLAW_* env vars are still read but emit a deprecation warning on first
 * read; CLAWD_* wins when both are set.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DEFAULT_CONFIG } from './types';
import { getPackageRoot } from './paths';

export interface ResolvedConfig {
  port: number;
  debug: boolean;
  disableVision: boolean;
}

export interface ResolveInput {
  /** Parsed CLI flags from commander (all optional). */
  cliFlags?: {
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

/** Whether we already warned about OPENCLAW_* → CLAWD_* migration this process. */
const _openClawWarnedFor = new Set<string>();

/** Read a (possibly deprecated) pair of env var names: canonical CLAWD_FOO, legacy OPENCLAW_FOO. */
function readEnvPair(
  canonical: string,
  legacy: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const canonicalVal = env[canonical];
  const legacyVal = env[legacy];

  // Both set — canonical wins; no warning, the user is already migrating.
  if (canonicalVal) return canonicalVal;
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
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface StoredConfigFields {
  port?: number;
  debug?: boolean;
  disableVision?: boolean;
}

function parseStoredConfig(json: Record<string, any>): StoredConfigFields {
  const result: StoredConfigFields = {};
  if (typeof json.port === 'number') result.port = json.port;
  // Nested `{"server":{"port":N}}` — the ClawdConfig shape the port messages name.
  else if (typeof json.server?.port === 'number') result.port = json.server.port;
  if (typeof json.debug === 'boolean') result.debug = json.debug;
  if (typeof json.disableVision === 'boolean') result.disableVision = json.disableVision;
  return result;
}

/** Walk the precedence ladder and return the resolved config. */
export function resolveConfig(input?: ResolveInput): ResolvedConfig {
  const env = input?.envOverride ?? (process.env as Record<string, string | undefined>);
  const cli = input?.cliFlags;
  const cliPort = cli?.port !== undefined ? Number(cli.port) : undefined;

  // Project config: package dir first (matches the historical lookup), then cwd.
  const projectConfigPath = input?.projectConfigPath
    ?? (() => {
      const pkgPath = path.resolve(getPackageRoot(), '.clawdcursor-config.json');
      if (fs.existsSync(pkgPath)) return pkgPath;
      return path.join(process.cwd(), '.clawdcursor-config.json');
    })();
  const projectJson = safeReadJson(projectConfigPath);
  const project = projectJson ? parseStoredConfig(projectJson) : {};

  const userConfigPath = input?.userConfigPath
    ?? path.join(os.homedir(), '.clawdcursor', 'config.json');
  const userJson = safeReadJson(userConfigPath);
  const user = userJson ? parseStoredConfig(userJson) : {};

  const envDisableVisionStr = readEnvPair('CLAWD_DISABLE_VISION', 'OPENCLAW_DISABLE_VISION', env);
  const envDisableVision = envDisableVisionStr !== undefined
    ? (envDisableVisionStr === '1' || envDisableVisionStr === 'true')
    : undefined;

  const first = <T>(...candidates: Array<T | undefined>): T | undefined =>
    candidates.find(v => v !== undefined && v !== null && (v as unknown) !== '');

  return {
    port: first<number>(
      cliPort !== undefined && !isNaN(cliPort) ? cliPort : undefined,
      project.port,
      user.port,
    ) ?? DEFAULT_CONFIG.server.port,
    debug: first<boolean>(cli?.debug, project.debug, user.debug) ?? false,
    // CLI only ever forces vision OFF; noVision:false must not override a config file.
    disableVision: first<boolean>(
      cli?.noVision === true ? true : undefined,
      project.disableVision,
      user.disableVision,
      envDisableVision,
    ) ?? false,
  };
}

/** Clear the per-process deprecation-warning dedup set. Useful in tests. */
export function _clearDeprecationCache(): void {
  _openClawWarnedFor.clear();
}
