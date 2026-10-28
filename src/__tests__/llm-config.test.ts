/**
 * Tests for the single config-resolution funnel (llm-config.ts).
 *
 * Each test group exercises one step of the precedence ladder:
 *   CLI > project > user > env > auto-detect > default
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveConfig, _clearDeprecationCache } from '../llm/config';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llm-config-test-'));
}

function writeJson(filePath: string, data: object): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _clearDeprecationCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  _clearDeprecationCache();
});

// ── 1. CLI > project precedence ───────────────────────────────────────────────

describe('precedence: CLI > project', () => {
  it('CLI apiKey wins over project apiKey', () => {
    const tmpDir = makeTmpDir();
    const projectPath = path.join(tmpDir, 'project.json');
    writeJson(projectPath, { apiKey: 'project-key-123' });

    const result = resolveConfig({
      cliFlags: { apiKey: 'cli-key-abc' },
      projectConfigPath: projectPath,
      userConfigPath: path.join(tmpDir, 'nonexistent-user.json'),
      envOverride: {},
    });

    expect(result.apiKey).toBe('cli-key-abc');
    expect(result.source.apiKey).toBe('cli');
  });

  it('CLI model wins over project model', () => {
    const tmpDir = makeTmpDir();
    const projectPath = path.join(tmpDir, 'project.json');
    writeJson(projectPath, {
      pipeline: {
        textModel: { model: 'project-text-model', baseUrl: 'http://project', enabled: true },
        visionModel: { model: 'project-vision-model', baseUrl: 'http://project', enabled: true },
      },
    });

    const result = resolveConfig({
      cliFlags: { textModel: 'cli-text-model', visionModel: 'cli-vision-model' },
      projectConfigPath: projectPath,
      userConfigPath: path.join(tmpDir, 'nonexistent-user.json'),
      envOverride: {},
    });

    expect(result.model).toBe('cli-text-model');
    expect(result.visionModel).toBe('cli-vision-model');
    expect(result.source.model).toBe('cli');
    expect(result.source.visionModel).toBe('cli');
  });

  it('CLI port wins over project port', () => {
    const tmpDir = makeTmpDir();
    const projectPath = path.join(tmpDir, 'project.json');
    writeJson(projectPath, { port: 9000 });

    const result = resolveConfig({
      cliFlags: { port: 4444 },
      projectConfigPath: projectPath,
      userConfigPath: path.join(tmpDir, 'nonexistent-user.json'),
      envOverride: {},
    });

    expect(result.port).toBe(4444);
    expect(result.source.port).toBe('cli');
  });
});

// ── 2. Project > user precedence ─────────────────────────────────────────────

describe('precedence: project > user', () => {
  it('project apiKey wins over user apiKey', () => {
    const tmpDir = makeTmpDir();
    const projectPath = path.join(tmpDir, 'project.json');
    const userPath = path.join(tmpDir, 'user.json');
    writeJson(projectPath, { apiKey: 'project-key-xyz' });
    writeJson(userPath, { apiKey: 'user-key-xyz' });

    const result = resolveConfig({
      projectConfigPath: projectPath,
      userConfigPath: userPath,
      envOverride: {},
    });

    expect(result.apiKey).toBe('project-key-xyz');
    expect(result.source.apiKey).toBe('project');
  });

  it('project model wins over user model', () => {
    const tmpDir = makeTmpDir();
    const projectPath = path.join(tmpDir, 'project.json');
    const userPath = path.join(tmpDir, 'user.json');
    writeJson(projectPath, {
      pipeline: {
        textModel: { model: 'project-model', baseUrl: 'http://project', enabled: true },
      },
    });
    writeJson(userPath, { model: 'user-model' });

    const result = resolveConfig({
      projectConfigPath: projectPath,
      userConfigPath: userPath,
      envOverride: {},
    });

    expect(result.model).toBe('project-model');
    expect(result.source.model).toBe('project');
  });

  it('project port wins over user port', () => {
    const tmpDir = makeTmpDir();
    const projectPath = path.join(tmpDir, 'project.json');
    const userPath = path.join(tmpDir, 'user.json');
    writeJson(projectPath, { port: 5555 });
    writeJson(userPath, { port: 6666 });

    const result = resolveConfig({
      projectConfigPath: projectPath,
      userConfigPath: userPath,
      envOverride: {},
    });

    expect(result.port).toBe(5555);
    expect(result.source.port).toBe('project');
  });
});

// ── 3. User > env precedence ──────────────────────────────────────────────────

describe('precedence: user > env', () => {
  it('user apiKey wins over env CLAWD_API_KEY', () => {
    const tmpDir = makeTmpDir();
    const userPath = path.join(tmpDir, 'user.json');
    writeJson(userPath, { apiKey: 'user-key-abc' });

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent-project.json'),
      userConfigPath: userPath,
      envOverride: { CLAWD_API_KEY: 'env-key-abc' },
    });

    expect(result.apiKey).toBe('user-key-abc');
    expect(result.source.apiKey).toBe('user');
  });

  it('user model wins over env CLAWD_TEXT_MODEL', () => {
    const tmpDir = makeTmpDir();
    const userPath = path.join(tmpDir, 'user.json');
    writeJson(userPath, { model: 'user-model-abc' });

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent-project.json'),
      userConfigPath: userPath,
      envOverride: { CLAWD_TEXT_MODEL: 'env-model' },
    });

    expect(result.model).toBe('user-model-abc');
    expect(result.source.model).toBe('user');
  });
});

// ── 4. OPENCLAW_DISABLE_VISION deprecation warning ───────────────────────────

describe('OPENCLAW_* deprecation warnings', () => {
  it('OPENCLAW_DISABLE_VISION=1 resolves disableVision: true AND emits a warning', () => {
    const tmpDir = makeTmpDir();

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: { OPENCLAW_DISABLE_VISION: '1' },
    });

    expect(result.disableVision).toBe(true);
    expect(result.source.disableVision).toBe('env');
    // Should have warned about deprecation
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('OPENCLAW_DISABLE_VISION')
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('CLAWD_DISABLE_VISION')
    );
  });

  it('CLAWD_DISABLE_VISION=1 resolves disableVision: true WITHOUT warning', () => {
    const tmpDir = makeTmpDir();

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: { CLAWD_DISABLE_VISION: '1' },
    });

    expect(result.disableVision).toBe(true);
    expect(result.source.disableVision).toBe('env');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('CLAWD_DISABLE_VISION wins when both CLAWD_* and OPENCLAW_* are set, no warning', () => {
    const tmpDir = makeTmpDir();

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: {
        CLAWD_DISABLE_VISION: '1',
        OPENCLAW_DISABLE_VISION: '0',
      },
    });

    expect(result.disableVision).toBe(true);
    // No deprecation warning because CLAWD_* was also set
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('both set to opposite values — CLAWD_* wins (canonical)', () => {
    const tmpDir = makeTmpDir();

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: {
        CLAWD_DISABLE_VISION: '0',
        OPENCLAW_DISABLE_VISION: '1',
      },
    });

    // CLAWD_DISABLE_VISION='0' → disableVision: false
    expect(result.disableVision).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('deprecation warning is only emitted once per var per process', () => {
    const tmpDir = makeTmpDir();

    // First call
    resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: { OPENCLAW_DISABLE_VISION: '1' },
    });
    // Second call — same var
    resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: { OPENCLAW_DISABLE_VISION: '1' },
    });

    // Should only warn once (dedup by var name)
    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: any[]) => c[0] && String(c[0]).includes('OPENCLAW_DISABLE_VISION')
    );
    expect(warnCalls).toHaveLength(1);
  });
});

// ── 5. Missing files are not errors ──────────────────────────────────────────

describe('missing config files are not errors', () => {
  it('missing project file falls through silently', () => {
    const tmpDir = makeTmpDir();

    expect(() => resolveConfig({
      projectConfigPath: path.join(tmpDir, 'does-not-exist.json'),
      userConfigPath: path.join(tmpDir, 'also-missing.json'),
      envOverride: {},
    })).not.toThrow();
  });

  it('missing user config file is not an error', () => {
    const tmpDir = makeTmpDir();

    expect(() => resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent-project.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent-user.json'),
      envOverride: {},
    })).not.toThrow();
  });

  it('falls back to default port when no config files exist', () => {
    const tmpDir = makeTmpDir();

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: {},
    });

    expect(result.port).toBe(3847); // DEFAULT_CONFIG.server.port
    expect(result.source.port).toBe('default');
  });

  // #293: the nested shape was ignored, so the daemon bound 3847 whatever the file said.
  it('reads the nested {"server":{"port":N}} shape', () => {
    const tmpDir = makeTmpDir();
    const userPath = path.join(tmpDir, 'user.json');
    writeJson(userPath, { server: { port: 4999 } });

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: userPath,
      envOverride: {},
    });

    expect(result.port).toBe(4999);
    expect(result.source.port).toBe('user');
  });

  it('reads the flat {"port":N} shape, and flat wins over nested in the same file', () => {
    const tmpDir = makeTmpDir();
    const projectPath = path.join(tmpDir, 'project.json');
    writeJson(projectPath, { port: 4100, server: { port: 4200 } });

    const result = resolveConfig({
      projectConfigPath: projectPath,
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: {},
    });

    expect(result.port).toBe(4100);
    expect(result.source.port).toBe('project');
  });

  it('a --port flag still wins over a config port', () => {
    const tmpDir = makeTmpDir();
    const userPath = path.join(tmpDir, 'user.json');
    writeJson(userPath, { server: { port: 4999 } });

    const result = resolveConfig({
      cliFlags: { port: '5001' },
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: userPath,
      envOverride: {},
    });

    expect(result.port).toBe(5001);
    expect(result.source.port).toBe('cli');
  });

  it('falls back to default debug=false when no source sets it', () => {
    const tmpDir = makeTmpDir();

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: {},
    });

    expect(result.debug).toBe(false);
    expect(result.source.debug).toBe('default');
  });
});

// ── 6. CLI --no-vision flag ───────────────────────────────────────────────────

describe('CLI --no-vision flag', () => {
  it('noVision: true resolves disableVision: true from CLI source', () => {
    const tmpDir = makeTmpDir();

    const result = resolveConfig({
      cliFlags: { noVision: true },
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: {},
    });

    expect(result.disableVision).toBe(true);
    expect(result.source.disableVision).toBe('cli');
  });

  it('noVision: false does not override project disableVision: true', () => {
    const tmpDir = makeTmpDir();
    const projectPath = path.join(tmpDir, 'project.json');
    writeJson(projectPath, { disableVision: true });

    // noVision: false means the flag wasn't passed — should not win
    const result = resolveConfig({
      cliFlags: { noVision: false },
      projectConfigPath: projectPath,
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: {},
    });

    // noVision: false means "not set" so project's true should win
    // But since false is a valid CLI value for noVision we check the source
    // Only true from CLI wins; false is treated as undefined (not passed)
    expect(result.disableVision).toBe(true);
    expect(result.source.disableVision).toBe('project');
  });
});

// ── 7. Source tracking ────────────────────────────────────────────────────────

describe('source tracking', () => {
  it('returns "project" source when value comes from project config', () => {
    const tmpDir = makeTmpDir();
    const projectPath = path.join(tmpDir, 'project.json');
    writeJson(projectPath, { apiKey: 'from-project', port: 7777 });

    const result = resolveConfig({
      projectConfigPath: projectPath,
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: {},
    });

    expect(result.source.apiKey).toBe('project');
    expect(result.source.port).toBe('project');
  });

  it('returns "user" source when value comes from user config', () => {
    const tmpDir = makeTmpDir();
    const userPath = path.join(tmpDir, 'user.json');
    writeJson(userPath, { debug: true });

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: userPath,
      envOverride: {},
    });

    expect(result.debug).toBe(true);
    expect(result.source.debug).toBe('user');
  });

  it('returns "env" source when value comes from env var', () => {
    const tmpDir = makeTmpDir();

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: { CLAWD_API_KEY: 'env-key-from-clawd' },
    });

    expect(result.apiKey).toBe('env-key-from-clawd');
    expect(result.source.apiKey).toBe('env');
  });

  it('returns "default" source when nothing else is set', () => {
    const tmpDir = makeTmpDir();

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: {},
    });

    expect(result.source.disableVision).toBe('default');
    expect(result.source.debug).toBe('default');
  });
});

// ── 8. User config file support ───────────────────────────────────────────────

describe('user config file support', () => {
  it('reads apiKey from user config when project does not set it', () => {
    const tmpDir = makeTmpDir();
    const userPath = path.join(tmpDir, 'user.json');
    writeJson(userPath, { apiKey: 'user-only-key' });

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: userPath,
      envOverride: {},
    });

    expect(result.apiKey).toBe('user-only-key');
    expect(result.source.apiKey).toBe('user');
  });

  it('reads visionModel from user config', () => {
    const tmpDir = makeTmpDir();
    const userPath = path.join(tmpDir, 'user.json');
    writeJson(userPath, { visionModel: 'user-vision-model' });

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: userPath,
      envOverride: {},
    });

    expect(result.visionModel).toBe('user-vision-model');
    expect(result.source.visionModel).toBe('user');
  });

  it('reads port from user config', () => {
    const tmpDir = makeTmpDir();
    const userPath = path.join(tmpDir, 'user.json');
    writeJson(userPath, { port: 8080 });

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: userPath,
      envOverride: {},
    });

    expect(result.port).toBe(8080);
    expect(result.source.port).toBe('user');
  });
});

// ── 9. CLAWD_* env vars (canonical, no warning) ───────────────────────────────

describe('CLAWD_* canonical env vars (no deprecation warnings)', () => {
  it('CLAWD_API_KEY is read without warning', () => {
    const tmpDir = makeTmpDir();

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: { CLAWD_API_KEY: 'clawd-key' },
    });

    expect(result.apiKey).toBe('clawd-key');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('CLAWD_TEXT_MODEL and CLAWD_VISION_MODEL are read without warning', () => {
    const tmpDir = makeTmpDir();

    const result = resolveConfig({
      projectConfigPath: path.join(tmpDir, 'nonexistent.json'),
      userConfigPath: path.join(tmpDir, 'nonexistent.json'),
      envOverride: {
        CLAWD_TEXT_MODEL: 'clawd-text',
        CLAWD_VISION_MODEL: 'clawd-vision',
      },
    });

    expect(result.model).toBe('clawd-text');
    expect(result.visionModel).toBe('clawd-vision');
    expect(console.warn).not.toHaveBeenCalled();
  });
});
