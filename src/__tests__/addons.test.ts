import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENT_ADDON, DOCTOR_ADDON, addonPath, addonVersion, doctorSetupStep, ensureAddons, installArgs, installCommandText, npmCli, type AddonDeps } from '../surface/addons';
import { VERSION } from '../version';

let dataDir: string;
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-addons-')); });
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

/** Put a package where `npm install --prefix` would, at `version`. */
function plant(pkg: string, version: string, base = path.join(dataDir, 'addons', 'node_modules')): void {
  const dir = path.join(base, pkg);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version, main: 'dist/index.js' }));
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'module.exports = {};');
}

/** npm mocked: records each call and, when told to, installs what it was asked for. */
function deps(o: { isTTY: boolean; answer?: boolean; installs?: boolean; npmExit?: number; env?: NodeJS.ProcessEnv }) {
  const lines: string[] = [];
  const asked: string[] = [];
  const npmCalls: string[][] = [];
  const d: Partial<AddonDeps> = {
    isTTY: o.isTTY, env: o.env ?? {}, dataDir,
    out: l => lines.push(l),
    ask: async q => { asked.push(q); return o.answer ?? false; },
    npm: async args => {
      npmCalls.push(args);
      if (o.installs !== false) for (const spec of args.filter(a => a.includes('@'))) { const [pkg, v] = spec.split('@'); plant(pkg, v); }
      return o.npmExit ?? 0;
    },
  };
  return { d, lines, asked, npmCalls, text: () => lines.join('\n') };
}

describe('add-on stub: ask, install, no terminal', () => {
  it('is ready at once when the add-on is installed at core\'s version: nothing asked, nothing run', async () => {
    plant(AGENT_ADDON, VERSION);
    const m = deps({ isTTY: true });
    expect(await ensureAddons([AGENT_ADDON], '`clawdcursor task`', { deps: m.d })).toBe('ready');
    expect(m.asked).toEqual([]);
    expect(m.npmCalls).toEqual([]);
  });

  it('with no terminal and no --yes: prints the exact install command, downloads nothing, fails', async () => {
    const m = deps({ isTTY: false });
    expect(await ensureAddons([AGENT_ADDON], '`clawdcursor task`', { deps: m.d })).toBe(1);
    expect(m.npmCalls).toEqual([]);
    expect(m.asked).toEqual([]);
    expect(m.text()).toContain(installCommandText([AGENT_ADDON], VERSION, dataDir));
    expect(m.text()).toContain(`${AGENT_ADDON}@${VERSION}`);
    expect(m.text()).toMatch(/from npm/);
  });

  it('in a terminal: says what is downloaded, asks y/N, and a no downloads nothing', async () => {
    const m = deps({ isTTY: true, answer: false });
    expect(await ensureAddons([AGENT_ADDON], '`clawdcursor task`', { deps: m.d })).toBe(1);
    expect(m.asked).toHaveLength(1);
    expect(m.asked[0]).toMatch(/\[y\/N\]/);
    expect(m.text()).toContain(`${AGENT_ADDON}@${VERSION}`);
    expect(m.npmCalls).toEqual([]);
  });

  it('a yes installs it into ~/.clawdcursor/addons at core\'s exact version', async () => {
    const m = deps({ isTTY: true, answer: true });
    expect(await ensureAddons([AGENT_ADDON], '`clawdcursor task`', { deps: m.d })).toBe('ready');
    expect(m.npmCalls).toEqual([installArgs([AGENT_ADDON], VERSION, dataDir)]);
    const args = m.npmCalls[0];
    expect(args.slice(0, 3)).toEqual(['install', '--prefix', path.join(dataDir, 'addons')]);
    expect(args[args.length - 1]).toBe(`${AGENT_ADDON}@${VERSION}`);
    expect(addonVersion(AGENT_ADDON, {}, dataDir)).toBe(VERSION);
  });

  it('--yes installs without asking, also with no terminal', async () => {
    const m = deps({ isTTY: false });
    expect(await ensureAddons([AGENT_ADDON], '`clawdcursor task`', { preApproved: true, deps: m.d })).toBe('ready');
    expect(m.asked).toEqual([]);
    expect(m.npmCalls).toHaveLength(1);
  });

  it('an add-on of another version is offered as an update the same way', async () => {
    plant(AGENT_ADDON, '0.0.1');
    const m = deps({ isTTY: true, answer: true });
    expect(await ensureAddons([AGENT_ADDON], '`clawdcursor task`', { deps: m.d })).toBe('ready');
    expect(m.text()).toContain(`${AGENT_ADDON} 0.0.1 is installed, but clawdcursor is ${VERSION}`);
    expect(m.asked[0]).toMatch(/^Update/);
    expect(m.npmCalls[0]).toContain(`${AGENT_ADDON}@${VERSION}`);
  });

  it('a failed npm install fails with the command to run by hand', async () => {
    const m = deps({ isTTY: true, answer: true, installs: false, npmExit: 1 });
    expect(await ensureAddons([AGENT_ADDON], '`clawdcursor task`', { deps: m.d })).toBe(1);
    expect(m.text()).toMatch(/npm install failed \(exit code 1\)/);
  });

  it('npm exiting 0 without the package there is still a failure', async () => {
    const m = deps({ isTTY: true, answer: true, installs: false });
    expect(await ensureAddons([AGENT_ADDON], '`clawdcursor task`', { deps: m.d })).toBe(1);
  });

  it('CLAWDCURSOR_ADDONS_DIR: loads the built workspace package, and never downloads', async () => {
    const ws = path.join(dataDir, 'packages');
    const env = { CLAWDCURSOR_ADDONS_DIR: ws };
    const missing = deps({ isTTY: true, answer: true, env });
    expect(await ensureAddons([AGENT_ADDON], '`clawdcursor task`', { deps: missing.d })).toBe(1);
    expect(missing.npmCalls).toEqual([]);
    expect(missing.asked).toEqual([]);
    expect(missing.text()).toMatch(/build:addons/);
    plant(AGENT_ADDON, VERSION, ws);
    expect(addonPath(AGENT_ADDON, env, dataDir)).toBe(path.join(ws, AGENT_ADDON));
    expect(await ensureAddons([AGENT_ADDON], '`clawdcursor task`', { deps: deps({ isTTY: false, env }).d })).toBe('ready');
  });

  it('a package that was never built (no main file) counts as not installed', () => {
    plant(AGENT_ADDON, VERSION);
    fs.rmSync(path.join(dataDir, 'addons', 'node_modules', AGENT_ADDON, 'dist'), { recursive: true });
    expect(addonVersion(AGENT_ADDON, {}, dataDir)).toBeNull();
  });

  it('runs npm\'s own JS with this Node: no .cmd launcher, no shell', () => {
    const cli = npmCli();
    if (cli) expect(cli).toMatch(/npm-cli\.js$/);
  });
});

describe('doctor\'s setup step', () => {
  it('after the diagnostics, with no terminal: says nothing, asks nothing', async () => {
    const m = deps({ isTTY: false });
    expect(await doctorSetupStep(false, m.d)).toBe(0);
    expect(m.lines).toEqual([]);
    expect(m.asked).toEqual([]);
  });

  it('when the test agent is already set up: one line, no question', async () => {
    fs.writeFileSync(path.join(dataDir, 'agent.json'), '{}');
    const m = deps({ isTTY: true });
    expect(await doctorSetupStep(false, m.d)).toBe(0);
    expect(m.asked).toEqual([]);
    expect(m.text()).toMatch(/doctor --setup/);
  });

  it('offers setup and names both downloads; a no downloads nothing', async () => {
    const m = deps({ isTTY: true, answer: false });
    expect(await doctorSetupStep(false, m.d)).toBe(0);
    expect(m.asked).toHaveLength(1);
    expect(m.asked[0]).toMatch(/Set up the test agent \(clawdcursor task\)\?/);
    expect(m.asked[0]).toContain(`${DOCTOR_ADDON}@${VERSION}`);
    expect(m.asked[0]).toContain(`${AGENT_ADDON}@${VERSION}`);
    expect(m.npmCalls).toEqual([]);
  });

  it('a yes to the offer covers the download it named: no second question', async () => {
    const m = deps({ isTTY: true, answer: true, installs: false, npmExit: 1 });
    await doctorSetupStep(false, m.d);
    expect(m.asked).toHaveLength(1);
    expect(m.npmCalls).toHaveLength(1);
    expect(m.npmCalls[0]).toEqual(expect.arrayContaining([`${DOCTOR_ADDON}@${VERSION}`, `${AGENT_ADDON}@${VERSION}`]));
  });

  it('doctor --setup with no terminal prints the install command and fails', async () => {
    const m = deps({ isTTY: false });
    expect(await doctorSetupStep(true, m.d)).toBe(1);
    expect(m.npmCalls).toEqual([]);
    expect(m.text()).toContain(installCommandText([DOCTOR_ADDON, AGENT_ADDON], VERSION, dataDir));
  });
});
