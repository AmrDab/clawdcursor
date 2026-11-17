/**
 * Optional developer add-ons, downloaded on demand and only after asking:
 *   clawdcursor-agent   `clawdcursor task` (a test agent with clawdcursor as its only tool) and `clawdcursor logs`
 *   clawdcursor-doctor  `clawdcursor doctor --setup` (sets that test agent up)
 * They live in ~/.clawdcursor/addons (npm install --prefix there) and must be the same version as core: a different
 * one is offered as an update the same way. Nothing is downloaded without a yes (or --yes); with no terminal to ask in,
 * the exact install command is printed and the command fails.
 *
 * For development, CLAWDCURSOR_ADDONS_DIR names a directory that holds the packages themselves (this repo's packages/,
 * built): they are loaded from there and nothing is installed.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { DATA_DIR, getPackageRoot } from '../paths';
import { VERSION } from '../version';
import { hasConsent } from './onboarding';

export const AGENT_ADDON = 'clawdcursor-agent';
export const DOCTOR_ADDON = 'clawdcursor-doctor';

/** What core hands an add-on. */
export interface CoreContext { coreVersion: string; coreEntry: string; node: string; dataDir: string }

interface TaskResult { exitCode: number }
interface AgentAddon {
  runTask(opts: { task: string; with?: string; model?: string; granular?: boolean }, ctx: CoreContext): Promise<TaskResult>;
  runLogs(opts: Record<string, unknown>, ctx: CoreContext): Promise<number>;
}
interface DoctorAddon { runSetup(ctx: CoreContext & { agent: AgentAddon; hasConsent(): boolean }): Promise<number> }

export function installDir(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'addons');
}

/** Where `pkg` is loaded from: the dev directory when CLAWDCURSOR_ADDONS_DIR is set, else the install directory. */
export function addonPath(pkg: string, env: NodeJS.ProcessEnv = process.env, dataDir: string = DATA_DIR): string {
  return env.CLAWDCURSOR_ADDONS_DIR ? path.join(path.resolve(env.CLAWDCURSOR_ADDONS_DIR), pkg) : path.join(installDir(dataDir), 'node_modules', pkg);
}

/** The installed version of `pkg`, or null when it is not there (or has not been built, in the dev directory). */
export function addonVersion(pkg: string, env: NodeJS.ProcessEnv = process.env, dataDir: string = DATA_DIR): string | null {
  const dir = addonPath(pkg, env, dataDir);
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string; main?: string };
    if (pj.name !== pkg || typeof pj.version !== 'string') return null;
    return fs.existsSync(path.join(dir, pj.main ?? 'index.js')) ? pj.version : null;
  } catch { return null; }
}

/** The npm command that installs the add-ons at core's version (printed as typed; run without a shell). */
export function installArgs(pkgs: string[], version: string, dataDir: string = DATA_DIR): string[] {
  return ['install', '--prefix', installDir(dataDir), '--no-audit', '--no-fund', '--save-exact', ...pkgs.map(p => `${p}@${version}`)];
}
export function installCommandText(pkgs: string[], version: string, dataDir: string = DATA_DIR): string {
  return `npm ${installArgs(pkgs, version, dataDir).map(a => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ')}`;
}

/** npm's own CLI script next to this Node (Windows: node_modules\npm; elsewhere ../lib/node_modules/npm), run with this Node. */
export function npmCli(node: string = process.execPath, platform: string = process.platform): string | null {
  const dir = path.dirname(node);
  const candidates = platform === 'win32'
    ? [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  return candidates.find(c => fs.existsSync(c)) ?? null;
}

export interface AddonDeps {
  isTTY: boolean;
  ask(question: string): Promise<boolean>;
  /** Run npm with these arguments; resolves with its exit code. */
  npm(args: string[]): Promise<number>;
  out(line: string): void;
  env: NodeJS.ProcessEnv;
  dataDir: string;
}

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); }));
}

function runNpm(args: string[]): Promise<number> {
  const cli = npmCli();
  return new Promise(resolve => {
    // npm is a .cmd launcher on Windows, which cannot be started without a shell: its own JS file is run with this Node.
    const child = cli ? spawn(process.execPath, [cli, ...args], { stdio: 'inherit', shell: false })
      : process.platform === 'win32' ? null : spawn('npm', args, { stdio: 'inherit', shell: false });
    if (!child) return resolve(127);
    child.once('error', () => resolve(127));
    child.once('close', code => resolve(code ?? 1));
  });
}

export const DEFAULT_DEPS: AddonDeps = {
  isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  ask: askYesNo,
  npm: runNpm,
  out: line => process.stdout.write(`${line}\n`),
  env: process.env,
  dataDir: DATA_DIR,
};

/**
 * Make sure `pkgs` are installed at `version`. `what` names the command that needs them. `preApproved`: the person
 * already said yes to a question that named the download (doctor's offer), or passed --yes.
 * Resolves 'ready', or an exit code to fail with.
 */
export async function ensureAddons(pkgs: string[], what: string, o: { version?: string; preApproved?: boolean; deps?: Partial<AddonDeps> } = {}): Promise<'ready' | number> {
  const d: AddonDeps = { ...DEFAULT_DEPS, ...o.deps };
  const version = o.version ?? VERSION;
  const have = pkgs.map(p => ({ pkg: p, v: addonVersion(p, d.env, d.dataDir) }));
  const need = have.filter(h => h.v !== version);
  if (!need.length) return 'ready';

  if (d.env.CLAWDCURSOR_ADDONS_DIR) {
    for (const h of need) {
      d.out(h.v === null
        ? `${what} needs ${h.pkg}, and CLAWDCURSOR_ADDONS_DIR has no built copy at ${addonPath(h.pkg, d.env, d.dataDir)}: run \`npm run build:addons\` in the clawdcursor repo.`
        : `${h.pkg} ${h.v} in CLAWDCURSOR_ADDONS_DIR does not match clawdcursor ${version}: they must be the same version.`);
    }
    return 1;
  }

  const cmd = installCommandText(need.map(h => h.pkg), version, d.dataDir);
  for (const h of need) {
    d.out(h.v === null
      ? `${what} needs the ${h.pkg} add-on, which is not installed.`
      : `${h.pkg} ${h.v} is installed, but clawdcursor is ${version}: the add-on must be the same version.`);
  }
  d.out(`It is downloaded from npm: ${need.map(h => `${h.pkg}@${version}`).join(' and ')}, into ${installDir(d.dataDir)}.`);
  if (!o.preApproved) {
    if (!d.isTTY) {
      d.out(`Nothing was downloaded. Install it with:\n  ${cmd}\nor pass --yes.`);
      return 1;
    }
    if (!(await d.ask(`${need.some(h => h.v !== null) ? 'Update' : 'Download and install'} it now? [y/N] `))) {
      d.out(`Nothing was downloaded. To install it later:\n  ${cmd}`);
      return 1;
    }
  }
  d.out(`> ${cmd}`);
  const code = await d.npm(installArgs(need.map(h => h.pkg), version, d.dataDir));
  if (code !== 0) {
    d.out(`npm install failed (exit code ${code}). Run it yourself:\n  ${cmd}`);
    return 1;
  }
  const still = need.filter(h => addonVersion(h.pkg, d.env, d.dataDir) !== version);
  if (still.length) {
    d.out(`npm finished, but ${still.map(h => h.pkg).join(', ')} ${version} is not in ${installDir(d.dataDir)}.`);
    return 1;
  }
  return 'ready';
}

function load<T>(pkg: string): T {
  // A path computed at run time: the CLI bundle (scripts/bundle-cli.mjs) leaves this require alone.
  return require(addonPath(pkg)) as T;
}

export function coreContext(): CoreContext {
  return { coreVersion: VERSION, coreEntry: path.join(getPackageRoot(), 'dist', 'surface', 'cli.js'), node: process.execPath, dataDir: DATA_DIR };
}

const CONSENT_FIRST = 'clawdcursor needs your one-time consent before an agent can drive the desktop: run `clawdcursor consent`, then try again.';

/** `clawdcursor task "<task>"` */
export async function runTaskCommand(task: string, opts: { with?: string; model?: string; granular?: boolean; yes?: boolean }): Promise<number> {
  if (!hasConsent()) { DEFAULT_DEPS.out(CONSENT_FIRST); return 1; }
  const ready = await ensureAddons([AGENT_ADDON], '`clawdcursor task`', { preApproved: opts.yes });
  if (ready !== 'ready') return ready;
  const r = await load<AgentAddon>(AGENT_ADDON).runTask({ task, with: opts.with, model: opts.model, granular: opts.granular }, coreContext());
  return r.exitCode;
}

/** `clawdcursor logs` */
export async function runLogsCommand(opts: { follow?: boolean; session?: string; tool?: string; errors?: boolean; since?: string; run?: string; yes?: boolean }): Promise<number> {
  const ready = await ensureAddons([AGENT_ADDON], '`clawdcursor logs`', { preApproved: opts.yes });
  if (ready !== 'ready') return ready;
  return load<AgentAddon>(AGENT_ADDON).runLogs(opts, coreContext());
}

/**
 * Doctor's setup step. `direct` (doctor --setup): straight to setup. Otherwise (after the diagnostics) an offer, made
 * only in a terminal and only while the test agent is not set up; a yes to it covers the download it names.
 */
export async function doctorSetupStep(direct: boolean, deps: Partial<AddonDeps> = {}): Promise<number> {
  const d: AddonDeps = { ...DEFAULT_DEPS, ...deps };
  const pkgs = [DOCTOR_ADDON, AGENT_ADDON];
  const missing = pkgs.filter(p => addonVersion(p, d.env, d.dataDir) !== VERSION);
  let preApproved = false;
  if (!direct) {
    if (!d.isTTY) return 0;
    if (fs.existsSync(path.join(d.dataDir, 'agent.json'))) {
      d.out('🧪 Test agent (clawdcursor task): set up. Change it with `clawdcursor doctor --setup`.');
      return 0;
    }
    const download = missing.length && !d.env.CLAWDCURSOR_ADDONS_DIR
      ? ` It downloads ${missing.map(p => `${p}@${VERSION}`).join(' and ')} from npm into ${installDir(d.dataDir)}.` : '';
    if (!(await d.ask(`🧪 Set up the test agent (clawdcursor task)?${download} [y/N] `))) return 0;
    preApproved = true;
  }
  const ready = await ensureAddons(pkgs, '`clawdcursor doctor --setup`', { preApproved, deps: d });
  if (ready !== 'ready') return ready;
  if (!d.isTTY) { d.out('Setup asks a few questions: run `clawdcursor doctor --setup` in a terminal.'); return 1; }
  return load<DoctorAddon>(DOCTOR_ADDON).runSetup({ ...coreContext(), agent: load<AgentAddon>(AGENT_ADDON), hasConsent });
}
