/**
 * #412: `doctor` reads the latest version from the npm registry, as `clawdcursor update` does, and a pre-release ranks
 * below its final release. The registry is a fake; nothing is fetched.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../version', () => ({ VERSION: '2.3.0-rc.1' }));

import { compareVersions } from '../surface/installed-copies';
import { checkForUpdates } from '../surface/doctor';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('compareVersions', () => {
  it('ranks a pre-release below the same x.y.z, and above the release before it', () => {
    expect(compareVersions('2.3.0', '2.3.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('2.3.0-rc.1', '2.3.0')).toBeLessThan(0);
    expect(compareVersions('2.3.0-rc.1', '2.2.9')).toBeGreaterThan(0);
    expect(compareVersions('2.3.0-rc.1', '2.3.0-rc.1')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });
});

describe('doctor version check', () => {
  const registry = (version: string) => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version }) }));
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('reads npm, and says an update is available when the final release is out', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = registry('2.3.0');
    const results: any[] = [];
    expect(await checkForUpdates(results)).toBe('2.3.0');
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe('https://registry.npmjs.org/clawdcursor/latest');
    expect(results[0]).toMatchObject({ name: 'Version', ok: false });
  });

  it('is up to date when npm has nothing newer', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    registry('2.2.9');
    const results: any[] = [];
    await checkForUpdates(results);
    expect(results[0]).toMatchObject({ ok: true, detail: 'v2.3.0-rc.1 (latest)' });
  });
});
