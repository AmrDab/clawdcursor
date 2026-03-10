import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveApiConfig } from '../src/credentials';

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

describe.sequential('credential resolution', () => {
  const originalCwd = process.cwd();
  const originalHome = os.homedir();

  let tempRoot: string;
  let tempHome: string;
  let tempCwd: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-credentials-'));
    tempHome = path.join(tempRoot, 'home');
    tempCwd = path.join(tempRoot, 'project');
    fs.mkdirSync(tempHome, { recursive: true });
    fs.mkdirSync(tempCwd, { recursive: true });

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.chdir(tempCwd);

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENCLAW_AI_API_KEY;
    delete process.env.AI_API_KEY;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('resolves ${ENV_VAR} placeholders from openclaw.json env block', () => {
    writeJson(path.join(tempHome, '.openclaw', 'openclaw.json'), {
      env: {
        MOONSHOT_API_KEY: 'moonshot-real-key',
      },
      models: {
        providers: {
          moonshot: {
            apiKey: '${MOONSHOT_API_KEY}',
            baseUrl: 'https://api.moonshot.ai/v1',
            models: [{ id: 'moonshot-v1-vision', input: ['image'] }],
          },
        },
      },
    });

    const resolved = resolveApiConfig();
    expect(resolved.source).toBe('external');
    expect(resolved.apiKey).toBe('moonshot-real-key');
    expect(resolved.baseUrl).toBe('https://api.moonshot.ai/v1');
    expect(resolved.visionApiKey).toBe('moonshot-real-key');
    expect(resolved.visionBaseUrl).toBe('https://api.moonshot.ai/v1');
  });

  it('prefers doctor-configured provider from .clawd-config.json', () => {
    writeJson(path.join(tempHome, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json'), {
      anthropic: {
        apiKey: 'anthropic-auth-profile-key',
        baseUrl: 'https://api.anthropic.com/v1',
        models: [{ id: 'claude-sonnet-4-5', input: ['text', 'image'] }],
      },
    });

    writeJson(path.join(tempHome, '.openclaw', 'openclaw.json'), {
      env: {
        MOONSHOT_API_KEY: 'moonshot-real-key',
      },
      models: {
        providers: {
          moonshot: {
            apiKey: '${MOONSHOT_API_KEY}',
            baseUrl: 'https://api.moonshot.ai/v1',
            models: [{ id: 'moonshot-v1-vision', input: ['image'] }],
          },
          anthropic: {
            apiKey: 'anthropic-live-key',
            baseUrl: 'https://api.anthropic.com/v1',
            models: [{ id: 'claude-sonnet-4-5', input: ['text'] }],
          },
        },
      },
    });

    writeJson(path.join(tempCwd, '.clawd-config.json'), {
      provider: 'anthropic',
    });

    const resolved = resolveApiConfig();
    expect(resolved.source).toBe('external');
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.apiKey).toBe('anthropic-auth-profile-key');
    expect(resolved.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(resolved.textApiKey).toBe('anthropic-auth-profile-key');
    expect(resolved.textBaseUrl).toBe('https://api.anthropic.com/v1');
  });

  it('prefers vision-capable provider from auth-profiles when no doctor config exists', () => {
    writeJson(path.join(tempHome, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json'), {
      anthropic: {
        apiKey: 'anthropic-auth-profile-key',
        baseUrl: 'https://api.anthropic.com/v1',
        models: [{ id: 'claude-sonnet-4-5', input: ['text', 'image'] }],
      },
    });

    writeJson(path.join(tempHome, '.openclaw', 'openclaw.json'), {
      env: {
        MOONSHOT_API_KEY: 'moonshot-real-key',
      },
      models: {
        providers: {
          moonshot: {
            apiKey: '${MOONSHOT_API_KEY}',
            baseUrl: 'https://api.moonshot.ai/v1',
            models: [{ id: 'moonshot-v1-text', input: ['text'] }],
          },
        },
      },
    });

    const resolved = resolveApiConfig();
    expect(resolved.source).toBe('external');
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.apiKey).toBe('anthropic-auth-profile-key');
    expect(resolved.baseUrl).toBe('https://api.anthropic.com/v1');
  });

  it('falls back to env keys when openclaw provider key is unresolved', () => {
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';

    writeJson(path.join(tempHome, '.openclaw', 'openclaw.json'), {
      models: {
        providers: {
          moonshot: {
            apiKey: '${MOONSHOT_API_KEY}',
            baseUrl: 'https://api.moonshot.ai/v1',
            models: [{ id: 'moonshot-v1', input: ['text'] }],
          },
        },
      },
    });

    const resolved = resolveApiConfig();
    expect(resolved.source).toBe('local');
    expect(resolved.apiKey).toBe('env-anthropic-key');
  });

  it('supports provider-scoped env keys for arbitrary providers', () => {
    process.env.MY_CUSTOM_PROVIDER_API_KEY = 'custom-provider-key';

    writeJson(path.join(tempCwd, '.clawd-config.json'), {
      provider: 'my-custom-provider',
    });

    const resolved = resolveApiConfig();
    expect(resolved.source).toBe('local');
    expect(resolved.apiKey).toBe('custom-provider-key');
    expect(resolved.textApiKey).toBe('custom-provider-key');
    expect(resolved.visionApiKey).toBe('custom-provider-key');
  });

  it('returns local empty config when nothing is configured (fresh install)', () => {
    const resolved = resolveApiConfig();
    expect(resolved.source).toBe('local');
    expect(resolved.apiKey).toBe('');
  });
});
