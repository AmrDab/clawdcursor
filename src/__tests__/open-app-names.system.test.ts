/** The Windows app-name resolver against this machine's real PATH and Start menu (read-only). Unit side: open-app-names.test.ts. */
import { describe, it, expect } from 'vitest';
import { resolveInstalledWindowsApp, isAppShapedStartEntry } from '../platform/win-app-resolve';
import { LIVE } from './helpers/live';

describe('a name outside the alias table only ever starts an installed app', () => {
  it.runIf(process.platform === 'win32')('live (read-only): a program on PATH resolves to its full path, a Start-menu app to its app id, anything else to nothing', async () => {
    const notepad = await resolveInstalledWindowsApp('notepad');
    expect(notepad?.path ?? notepad?.appId).toBeTruthy();
    if (notepad?.path) expect(notepad.path).toMatch(/^[A-Za-z]:\\.+\.exe$/i);
    expect(await resolveInstalledWindowsApp('no-such-app-clawdcursor-test')).toBeNull();
    expect(await resolveInstalledWindowsApp('payload.exe')).toBeNull();
  }, 60_000);

  // Depends on the apps this machine has (Calculator is not on every Windows): CLAWD_LIVE_TESTS=1 only.
  it.runIf(process.platform === 'win32' && LIVE)('live (read-only): the apps people ask for still resolve, to something app-shaped; a prefix or a fragment does not', async () => {
    for (const name of ['notepad', 'Calculator', 'Microsoft Edge', 'calculator', 'MICROSOFT EDGE']) {
      const hit = await resolveInstalledWindowsApp(name);
      expect(hit, name).not.toBeNull();
      if (hit?.appId) expect(isAppShapedStartEntry(hit.appId, hit.target), name).toBe(true);
    }
    // A prefix of real entries, and a name that cannot exist. (Not "Uninstall" or "a": a machine may well have a
    // Start-menu entry called exactly that, and an exact name is allowed to resolve.)
    const noSuch = `zz-no-such-app-${Math.random().toString(36).slice(2, 12)}`;
    for (const name of ['Microsoft', noSuch]) {
      const hit = await resolveInstalledWindowsApp(name);
      expect(hit?.appId, name).toBeUndefined();   // only a real program of that name on PATH could answer
    }
    expect(await resolveInstalledWindowsApp(noSuch)).toBeNull();
  }, 120_000);
});
