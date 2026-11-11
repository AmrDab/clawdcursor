/**
 * Opening a task's fixture for a live run, reading its state, and closing it again.
 *
 *   web     a private window of a separate browser instance on a fixture page; state = what the page posted
 *   native  the fixture app of this OS (WinForms / AppKit / GTK); state = the JSON file it writes
 *   app     a real app, only when it is installed and NOT already running (the owner's windows are never reused);
 *           state = a read-only probe of that app, or none (manual verify)
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { browserAppNames, openBrowser, type BrowserExe } from './browser';
import type { FixtureServer } from './fixture-server';
import { POWERSHELL, killTree, pidsByCommandLine, start, system32, tryRun, waitFor } from './proc';
import type { FixtureState, TaskSpec } from './types';

const NATIVE_DIR = path.join(__dirname, '..', 'fixtures', 'native');
const APPS_DIR = path.join(__dirname, '..', 'fixtures', 'apps');

export interface LiveFixture {
  /** How the prompt names the window. */
  window: string;
  /** The exact app names the session log may give this fixture. A name alone never passes the privacy guard. */
  apps: string[];
  /** The processes the benchmark started for this fixture, now. The guard accepts the focus only in these or their children. */
  roots(): Promise<number[]> | number[];
  /** A Store app: the exact title its ApplicationFrameHost window must have to count as this fixture. */
  frameTitle?: string;
  /** A web fixture: its browser's debug port and temp profile, for the proof that CDP acts can only reach this instance. */
  cdp?: { cdpPort: number; profileDir: string };
  /** null: this task has no state to read, or it could not be read. */
  state(): Promise<FixtureState | null>;
  close(): Promise<void>;
}

export interface FixtureContext {
  server: FixtureServer;
  browser: BrowserExe | null;
  /** The built native fixture, or why there is none. */
  native: NativeBuild | { missing: string };
  /** A fresh directory for this run. */
  workDir: string;
  runId: string;
  /** Top-left corner for the fixture window (to run the suite on another monitor). */
  pos?: [number, number];
}

// ── native fixture ──────────────────────────────────────────────────────────

export interface NativeBuild { cmd: string; args: string[]; apps: string[] }

/** Build (or locate) the native fixture of this OS. */
export async function buildNative(outDir: string, platform: string = process.platform): Promise<NativeBuild | { missing: string }> {
  fs.mkdirSync(outDir, { recursive: true });
  if (platform === 'win32') {
    const out = await tryRun(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(NATIVE_DIR, 'windows', 'build.ps1'), '-OutDir', outDir], 120_000);
    const exe = path.join(outDir, 'BenchFixture.exe');
    return out !== null && fs.existsSync(exe) ? { cmd: exe, args: [], apps: ['BenchFixture'] } : { missing: 'the WinForms fixture did not build (Add-Type)' };
  }
  if (platform === 'darwin') {
    const exe = path.join(outDir, 'BenchFixture');
    const out = await tryRun('swiftc', ['-O', path.join(NATIVE_DIR, 'macos', 'BenchFixture.swift'), '-o', exe], 300_000);
    return out !== null && fs.existsSync(exe) ? { cmd: exe, args: [], apps: ['BenchFixture'] } : { missing: 'swiftc could not build the AppKit fixture (install the Xcode command line tools)' };
  }
  const script = path.join(NATIVE_DIR, 'linux', 'bench_fixture.py');
  const gtk = await tryRun('python3', ['-c', 'import gi; gi.require_version("Gtk", "3.0"); from gi.repository import Gtk']);
  // The script names its own process BenchFixture (prctl): no generic "python3" in the allowlist.
  return gtk !== null ? { cmd: 'python3', args: [script], apps: ['BenchFixture'] }
    : { missing: 'python3 with gi and GTK 3 is not installed' };
}

export function nativeArgs(o: { state: string; mode: 'dialog' | 'editor'; pos?: [number, number] }): string[] {
  return ['--state', o.state, '--mode', o.mode, ...(o.pos ? ['--pos', o.pos.join(',')] : [])];
}

/** The state file: written whole and moved into place, but a read can still land between the two. */
export function readStateFile(file: string): FixtureState | null {
  for (let i = 0; i < 5; i++) {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (o && typeof o.state === 'object' && Array.isArray(o.events)) return o as FixtureState;
    } catch { /* being replaced: try again */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return null;
}

async function openNative(mode: 'dialog' | 'editor', ctx: FixtureContext): Promise<LiveFixture | { skip: string }> {
  if ('missing' in ctx.native) return { skip: ctx.native.missing };
  const state = path.join(ctx.workDir, 'fixture-state.json');
  const child = start(ctx.native.cmd, [...ctx.native.args, ...nativeArgs({ state, mode, pos: ctx.pos })], { stdio: 'ignore' });
  await waitFor(() => fs.existsSync(state), 20_000, 'the native fixture to start');
  return {
    window: mode === 'editor' ? '"Bench Editor" (a desktop app)' : '"Bench Dialog" (a desktop app)',
    apps: ctx.native.apps,
    roots: () => child.pid ? [child.pid] : [],
    state: async () => readStateFile(state),
    close: async () => killTree(child.pid),
  };
}

// ── real apps ───────────────────────────────────────────────────────────────

/**
 * The probe's two lines: "display Display is 4,183" and "expression Expression is 47 × 89=". The expression is what
 * makes the task exact: typing 4183 leaves it empty.
 */
export function parseCalcProbe(out: string): { display: string; expression: string } | null {
  const line = (key: string) => out.split(/\r?\n/).find(l => l.startsWith(`${key} `))?.slice(key.length + 1).trim();
  const display = line('display');
  if (display === undefined) return null;
  return { display: parseCalcDisplay(display), expression: (line('expression') ?? '').replace(/^Expression is\s*/i, '') };
}

/** "Display is 4,183" -> "4183". */
export function parseCalcDisplay(text: string): string {
  return text.replace(/[^\d.-]/g, '').replace(/\.$/, '');
}

const DESIGNCENTER_ROOT = 'C:\\Program Files\\Siemens';

/** The pids of the running processes with this image name ("CalculatorApp.exe", or "TextEdit" on macOS). */
export function imagePids(image: string, platform: string = process.platform): number[] {
  try {
    const out = platform === 'win32'
      ? execFileSync(system32('tasklist.exe'), ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
      : execFileSync('pgrep', ['-x', image], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return parseImagePids(out, platform);
  } catch { return []; }   // pgrep exits 1 when there is none
}

/** tasklist CSV rows ("Image","PID",...) or pgrep lines. */
export function parseImagePids(out: string, platform: string): number[] {
  const cells = platform === 'win32' ? out.split(/\r?\n/).map(l => l.split('","')[1]) : out.split(/\s+/);
  return cells.map(Number).filter(n => Number.isInteger(n) && n > 0);
}

/** Why a real app cannot be used now (not installed, or the owner has it open), or null when it can. */
export async function appUnavailable(app: 'calculator' | 'textedit' | 'designcenter', platform: string = process.platform): Promise<string | null> {
  const running = async (name: string) => platform === 'win32'
    ? ((await tryRun(system32('tasklist.exe'), ['/FI', `IMAGENAME eq ${name}`, '/NH'])) ?? '').toLowerCase().includes(name.toLowerCase())
    : (await tryRun('pgrep', ['-x', name])) !== null;
  if (app === 'calculator') {
    if (platform === 'win32') {
      const pkg = await tryRun(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage -Name Microsoft.WindowsCalculator).Name']);
      if (!pkg?.trim()) return 'Calculator (Store app) is not installed';
      return await running('CalculatorApp.exe') ? 'Calculator is already open: the owner\'s window is never reused (close it to run this task)' : null;
    }
    return 'no Calculator task on this OS';
  }
  if (app === 'textedit') {
    if (platform !== 'darwin') return 'TextEdit is macOS only';
    return await running('TextEdit') ? 'TextEdit is already open: the owner\'s documents are never touched' : null;
  }
  if (platform !== 'win32' || !fs.existsSync(DESIGNCENTER_ROOT) || !fs.readdirSync(DESIGNCENTER_ROOT).some(d => /^Designcenter/i.test(d))) {
    return 'Designcenter is not installed';
  }
  return null;
}

async function openApp(app: 'calculator' | 'textedit' | 'designcenter', ctx: FixtureContext): Promise<LiveFixture | { skip: string }> {
  const why = await appUnavailable(app);
  if (why) return { skip: why };
  const osa = (script: string) => tryRun('osascript', ['-e', script]);
  if (app === 'designcenter') {
    // Starting a CAD session takes minutes and a licence: the person running the benchmark opens it with a part loaded.
    // The one fixture the benchmark does not start: its processes are the Designcenter ones running when the task begins.
    const cad = imagePids('ugraf.exe');
    if (!cad.length) return { skip: 'Designcenter is not open: open it with a part loaded, then run with --include-manual' };
    return { window: 'Designcenter (already open, with a part loaded)', apps: ['Designcenter', 'Designcenter NX'], roots: () => cad,
      state: async () => null, close: async () => { /* not ours to close */ } };
  }
  if (app === 'calculator' && process.platform === 'win32') {
    start(system32('calc.exe'), [], { stdio: 'ignore' });
    const probe = async () => {
      const out = await tryRun(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(APPS_DIR, 'calculator-probe.ps1')]);
      return out === null ? null : parseCalcProbe(out);
    };
    await waitFor(probe, 30_000, 'Calculator to open');
    return {
      // No Calculator ran before this task (appUnavailable), so these are the processes this task started. Its window
      // belongs to ApplicationFrameHost: that frame counts only with this exact title and one of these processes inside.
      window: 'Calculator', apps: ['Calculator'], frameTitle: 'Calculator',
      roots: () => imagePids('CalculatorApp.exe'),
      state: async () => { const d = await probe(); return d === null ? null : { state: d, events: [] }; },
      close: async () => { for (const pid of imagePids('CalculatorApp.exe')) killTree(pid); },
    };
  }
  const doc = path.join(ctx.workDir, 'bench-document.txt');
  fs.writeFileSync(doc, '');
  await tryRun('open', ['-a', 'TextEdit', doc]);
  const text = () => osa('tell application "TextEdit" to get text of document 1');
  await waitFor(async () => (await text()) !== null, 30_000, 'TextEdit to open');
  return {
    window: 'TextEdit "bench-document.txt"', apps: ['TextEdit'], roots: () => imagePids('TextEdit'),
    state: async () => { const t = await text(); return t === null ? null : { state: { text: t.replace(/\n$/, '') }, events: [] }; },
    close: async () => { await osa('tell application "TextEdit" to quit saving no'); },
  };
}

// ── any task ────────────────────────────────────────────────────────────────

const PAGE_TITLES: Record<string, string> = { form: 'Bench Form', trap: 'Bench Traps', timing: 'Bench Timing', canvas: 'Bench Canvas', longread: 'Bench Reading' };

export async function openFixture(task: TaskSpec, ctx: FixtureContext): Promise<LiveFixture | { skip: string }> {
  const f = task.fixture;
  if (f.kind === 'native') return openNative(f.mode, ctx);
  if (f.kind === 'app') return openApp(f.app, ctx);
  if (!ctx.browser) return { skip: 'no Chromium browser (Edge, Chrome or Chromium) is installed' };
  const profileDir = path.join(ctx.workDir, 'browser-profile');
  const browser = await openBrowser(ctx.browser, { profileDir, url: ctx.server.url(f.page, ctx.runId, f.query), pos: ctx.pos });
  const image = path.basename(ctx.browser.exe);
  return {
    window: `the browser window showing the page "${PAGE_TITLES[f.page] ?? f.page}" (a private window, already open)`,
    apps: browserAppNames(ctx.browser.kind),
    // Every process on this run's temp profile: the owner's browser, on its own profile, is never one of them.
    roots: () => pidsByCommandLine(profileDir, image),
    cdp: { cdpPort: browser.cdpPort, profileDir },
    state: async () => ctx.server.state(ctx.runId),
    close: () => browser.close(),
  };
}
