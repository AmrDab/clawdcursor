/**
 * Settings come only from the environment, flags and ~/.clawdcursor; no environment variable swaps real readers
 * for doubles. Test doubles are installed by test code (tests/vitest.setup.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

afterEach(() => { vi.resetModules(); vi.doUnmock('../platform'); });

describe('no .env loading', () => {
  it('cli.ts does not import dotenv and package.json does not depend on it', () => {
    expect(read('src/surface/cli.ts')).not.toMatch(/dotenv/);
    const pkg = JSON.parse(read('package.json'));
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty('dotenv');
  });
});

describe('no VITEST switch in guard modules', () => {
  it.each(['src/core/control.ts', 'src/core/overlay-state.ts', 'src/platform/pointer-guard.ts'])('%s', (f) => {
    expect(read(f)).not.toMatch(/process\.env\.VITEST|NODE_ENV\s*===\s*'test'/);
  });

  it('a freshly imported control module reads the real platform even with VITEST set', async () => {
    expect(process.env.VITEST).toBeTruthy();
    vi.resetModules();
    vi.doMock('../platform', () => ({
      getPlatform: async () => ({
        getActiveWindow: async () => ({ processId: 4242, processName: 'real.exe', title: 't' }),
        listWindows: async () => [{ processId: 4242, processName: 'real.exe' }],
      }),
    }));
    const control = await import('../core/control');
    expect((await control.foregroundNow())?.processId).toBe(4242);
  });
});
