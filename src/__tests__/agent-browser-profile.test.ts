/**
 * #236: a fresh agent profile opened with a "Sign in to Chrome?" bubble that
 * took focus (and was one click from signing the automation profile in to the
 * user's Google account). The agent's OWN profile is seeded with sign-in
 * disallowed before launch; the user's browser is never touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => ({ home: '', spawned: [] as Array<{ exe: string; args: string[]; prefsAtSpawn: string | null }> }));

vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, homedir: () => h.home || real.homedir() };
});
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  spawn: (exe: string, args: string[]) => {
    const profile = args.find(a => a.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
    const prefs = path.join(profile, 'Default', 'Preferences');
    h.spawned.push({ exe, args, prefsAtSpawn: fs.existsSync(prefs) ? fs.readFileSync(prefs, 'utf8') : null });
    return { unref() { /* detached */ } };
  },
}));
vi.mock('playwright', () => ({
  chromium: { connectOverCDP: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) },
}));

import { CDPDriver, seedAgentProfile } from '../platform/cdp-driver';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-profile-'));
  h.home = '';
  h.spawned.length = 0;
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const readPrefs = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));

describe('seedAgentProfile', () => {
  it('a fresh profile gets Preferences with Chrome sign-in disallowed (now and on next startup)', () => {
    seedAgentProfile(tmp);
    // signin.allowed is recomputed from signin.allowed_on_next_startup at every
    // start (AccountConsistencyModeManager), so both are written.
    expect(readPrefs(tmp).signin).toEqual({ allowed: false, allowed_on_next_startup: false });
  });

  it('an existing profile keeps its other prefs; only the sign-in keys change', () => {
    fs.mkdirSync(path.join(tmp, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'Default', 'Preferences'),
      JSON.stringify({ browser: { window_placement: { maximized: true } }, signin: { allowed: true, other: 1 } }));
    seedAgentProfile(tmp);
    const p = readPrefs(tmp);
    expect(p.browser).toEqual({ window_placement: { maximized: true } });
    expect(p.signin).toEqual({ allowed: false, allowed_on_next_startup: false, other: 1 });
  });

  it('an unreadable Preferences file is left alone (Chrome would reset a clobbered one)', () => {
    fs.mkdirSync(path.join(tmp, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'Default', 'Preferences'), '{not json');
    seedAgentProfile(tmp);
    expect(fs.readFileSync(path.join(tmp, 'Default', 'Preferences'), 'utf8')).toBe('{not json');
  });
});

describe('dedicated launch', () => {
  it('seeds the agent profile BEFORE the browser starts, and only ~/.clawdcursor/cdp-profile', async () => {
    h.home = tmp;
    const exe = path.join(tmp, 'chrome.exe');
    fs.writeFileSync(exe, '');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    try {
      await new CDPDriver().ensureConnected({ launch: true, exePaths: [exe] });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(h.spawned).toHaveLength(1);
    const profile = path.join(tmp, '.clawdcursor', 'cdp-profile');
    expect(h.spawned[0].args).toContain(`--user-data-dir=${profile}`);
    expect(JSON.parse(h.spawned[0].prefsAtSpawn!).signin.allowed_on_next_startup).toBe(false);
  });
});
