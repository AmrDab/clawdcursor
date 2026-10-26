/**
 * The Screen Recording check (#276) asks the screenshot helper. A Mac without a built helper (#244) has nothing to ask:
 * the check must let the capture through, not throw — a throw there broke every capture and latched OCR off.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-no-helper-'));
vi.mock('../paths', async (orig) => ({ ...(await orig<typeof import('../paths')>()), getPackageRoot: () => empty }));
vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, default: { ...real, homedir: () => empty }, homedir: () => empty };
});

const REAL = process.platform;
afterEach(() => { Object.defineProperty(process, 'platform', { value: REAL, configurable: true }); vi.resetModules(); });

describe('assertScreenRecordingGranted', () => {
  it('macOS with no helper built: nothing to ask, the capture goes ahead', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.resetModules();
    const { assertScreenRecordingGranted } = await import('../platform/native-helper');
    await expect(assertScreenRecordingGranted()).resolves.toBeUndefined();
  });

  it('not macOS: a no-op', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.resetModules();
    const { assertScreenRecordingGranted } = await import('../platform/native-helper');
    await expect(assertScreenRecordingGranted()).resolves.toBeUndefined();
  });
});
