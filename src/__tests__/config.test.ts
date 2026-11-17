/**
 * Tests for config resolution (src/config.ts).
 * Precedence: CLI > project > user > env > default.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveConfig, _clearDeprecationCache } from '../config';

let tmp: string;
const none = () => path.join(tmp, 'nonexistent.json');

function writeJson(name: string, data: object): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

/** Resolve with both config files absent unless given, and an empty env unless given. */
function resolve(over: Parameters<typeof resolveConfig>[0] = {}) {
  return resolveConfig({
    projectConfigPath: none(),
    userConfigPath: none(),
    envOverride: {},
    ...over,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  _clearDeprecationCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  _clearDeprecationCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('port precedence', () => {
  it('CLI wins over project', () => {
    expect(resolve({ cliFlags: { port: 4444 }, projectConfigPath: writeJson('p.json', { port: 9000 }) }).port).toBe(4444);
  });

  it('project wins over user', () => {
    expect(resolve({
      projectConfigPath: writeJson('p.json', { port: 5555 }),
      userConfigPath: writeJson('u.json', { port: 6666 }),
    }).port).toBe(5555);
  });

  it('reads port from the user config', () => {
    expect(resolve({ userConfigPath: writeJson('u.json', { port: 8080 }) }).port).toBe(8080);
  });

  it('falls back to the default port when nothing sets it', () => {
    expect(resolve().port).toBe(3847);
  });

  // #293: the nested shape was ignored, so the daemon bound 3847 whatever the file said.
  it('reads the nested {"server":{"port":N}} shape', () => {
    expect(resolve({ userConfigPath: writeJson('u.json', { server: { port: 4999 } }) }).port).toBe(4999);
  });

  it('reads the flat {"port":N} shape, and flat wins over nested in the same file', () => {
    expect(resolve({ projectConfigPath: writeJson('p.json', { port: 4100, server: { port: 4200 } }) }).port).toBe(4100);
  });

  it('a --port flag still wins over a config port', () => {
    expect(resolve({ cliFlags: { port: '5001' }, userConfigPath: writeJson('u.json', { server: { port: 4999 } }) }).port).toBe(5001);
  });
});

describe('disableVision', () => {
  it('--no-vision resolves to true', () => {
    expect(resolve({ cliFlags: { noVision: true } }).disableVision).toBe(true);
  });

  it('noVision: false (flag not passed) does not override the project file', () => {
    expect(resolve({ cliFlags: { noVision: false }, projectConfigPath: writeJson('p.json', { disableVision: true }) }).disableVision).toBe(true);
  });

  it('project wins over user, user wins over env', () => {
    expect(resolve({
      projectConfigPath: writeJson('p.json', { disableVision: true }),
      userConfigPath: writeJson('u.json', { disableVision: false }),
    }).disableVision).toBe(true);
    expect(resolve({
      userConfigPath: writeJson('u.json', { disableVision: false }),
      envOverride: { CLAWD_DISABLE_VISION: '1' },
    }).disableVision).toBe(false);
  });

  it('CLAWD_DISABLE_VISION=1 resolves true without a warning', () => {
    expect(resolve({ envOverride: { CLAWD_DISABLE_VISION: '1' } }).disableVision).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('OPENCLAW_DISABLE_VISION=1 resolves true and warns about the rename', () => {
    expect(resolve({ envOverride: { OPENCLAW_DISABLE_VISION: '1' } }).disableVision).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('OPENCLAW_DISABLE_VISION'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('CLAWD_DISABLE_VISION'));
  });

  it('CLAWD_* wins over OPENCLAW_* when both are set, with no warning', () => {
    expect(resolve({ envOverride: { CLAWD_DISABLE_VISION: '0', OPENCLAW_DISABLE_VISION: '1' } }).disableVision).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns once per variable per process', () => {
    resolve({ envOverride: { OPENCLAW_DISABLE_VISION: '1' } });
    resolve({ envOverride: { OPENCLAW_DISABLE_VISION: '1' } });
    const calls = (console.warn as ReturnType<typeof vi.fn>).mock.calls.filter((c: any[]) => String(c[0]).includes('OPENCLAW_DISABLE_VISION'));
    expect(calls).toHaveLength(1);
  });
});

describe('unreadable config files', () => {
  it('missing files fall through silently', () => {
    expect(() => resolve()).not.toThrow();
  });

  it('a malformed file is ignored', () => {
    const p = path.join(tmp, 'bad.json');
    fs.writeFileSync(p, '{not json');
    expect(resolve({ projectConfigPath: p }).port).toBe(3847);
  });

  it('model and key fields left in an old config file are ignored', () => {
    const r = resolve({ userConfigPath: writeJson('u.json', { apiKey: 'k', model: 'm', provider: 'p', port: 7001 }) });
    expect(r).toEqual({ port: 7001, disableVision: false });
  });
});
