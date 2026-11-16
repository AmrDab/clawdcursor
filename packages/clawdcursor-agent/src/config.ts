/** ~/.clawdcursor/agent.json: the test agent's default runner and model, and the API runners' settings (doctor --setup writes it). */
import * as fs from 'fs';
import * as path from 'path';

export const RUNNERS = ['claude', 'codex', 'anthropic', 'openai-compatible'] as const;
export type Runner = typeof RUNNERS[number];

/** An API key is stored in the file (only the owner can read it) or named by the environment variable that holds it. */
export interface ApiKeySource { apiKey?: string; apiKeyEnv?: string }
export interface AgentConfig {
  runner?: Runner;
  /** The default runner's model; unset = the CLI's own default. */
  model?: string;
  anthropic?: ApiKeySource & { model?: string };
  openaiCompatible?: ApiKeySource & { baseUrl?: string; model?: string };
}

export function configPath(dataDir: string): string {
  return path.join(dataDir, 'agent.json');
}

export function readConfig(dataDir: string): AgentConfig {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf8')) as AgentConfig;
    return c && typeof c === 'object' ? c : {};
  } catch { return {}; }
}

/** The key itself, from the file or from the named variable (`fallbackEnv` when neither is set). */
export function apiKeyOf(src: ApiKeySource | undefined, fallbackEnv: string | null, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (src?.apiKey) return src.apiKey;
  const name = src?.apiKeyEnv ?? fallbackEnv;
  return name ? env[name] || undefined : undefined;
}
