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
import { POWERSHELL, killTree, start, system32, tryRun, waitFor } from './proc';
import type { FixtureState, TaskSpec } from './types';

const NATIVE_DIR = path.join(__dirname, '..', 'fixtures', 'native');
const APPS_DIR = path.join(__dirname, '..', 'fixtures', 'apps');

export interface LiveFixture {
  /** How the prompt names the window. */
  window: string;
  /** App names the privacy guard allows for this task. */
  apps: string[];
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
  cdpPort: number;
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
  // The process is python3: the session log cannot tell this fixture from another Python GUI.
  return gtk !== null ? { cmd: 'python3', args: [script], apps: ['BenchFixture', 'bench_fixture', 'Python3', 'python3'] }
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
    state: async () => readStateFile(state),
    close: async () => killTree(child.pid),
  };
}

// ── real apps ───────────────────────────────────────────────────────────────

/** "Display is 4,183" (Windows) or "4183" (macOS) -> "4183". */
export function parseCalcDisplay(text: string): string {
  return text.replace(/[^\d.-]/g, '').replace(/\.$/, '');
}

const DESIGNCENTER_ROOT = 'C:\\Program Files\\Siemens';

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
    if (platform === 'darwin') {
      if (!fs.existsSync('/System/Applications/Calculator.app')) return 'Calculator is not installed';
      return await running('Calculator') ? 'Calculator is already open: the owner\'s window is never reused' : null;
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
    return { window: 'Designcenter (already open, with a part loaded)', apps: ['Designcenter', 'Designcenter NX', 'ugraf', 'NX'],
      state: async () => null, close: async () => { /* not ours to close */ } };
  }
  if (app === 'calculator' && process.platform === 'win32') {
    start(system32('calc.exe'), [], { stdio: 'ignore' });
    const probe = async () => {
      const out = await tryRun(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(APPS_DIR, 'calculator-probe.ps1')]);
      return out === null ? null : parseCalcDisplay(out);
    };
    await waitFor(probe, 30_000, 'Calculator to open');
    return {
      window: 'Calculator', apps: ['Calculator', 'CalculatorApp', 'ApplicationFrameHost'],
      state: async () => { const d = await probe(); return d === null ? null : { state: { display: d }, events: [] }; },
      // It was not running before this task (appUnavailable), so every Calculator process now is this task's.
      close: async () => { try { execFileSync(system32('taskkill.exe'), ['/IM', 'CalculatorApp.exe', '/F'], { stdio: 'ignore' }); } catch { /* closed */ } },
    };
  }
  if (app === 'calculator') {
    await tryRun('open', ['-a', 'Calculator']);
    const probe = async () => {
      const out = await osa('tell application "System Events" to tell process "Calculator" to get value of static text 1 of group 1 of window 1');
      return out === null ? null : parseCalcDisplay(out);
    };
    await waitFor(probe, 30_000, 'Calculator to open');
    return {
      window: 'Calculator', apps: ['Calculator'],
      state: async () => { const d = await probe(); return d === null ? null : { state: { display: d }, events: [] }; },
      close: async () => { await osa('tell application "Calculator" to quit'); },
    };
  }
  const doc = path.join(ctx.workDir, 'bench-document.txt');
  fs.writeFileSync(doc, '');
  await tryRun('open', ['-a', 'TextEdit', doc]);
  const text = () => osa('tell application "TextEdit" to get text of document 1');
  await waitFor(async () => (await text()) !== null, 30_000, 'TextEdit to open');
  return {
    window: 'TextEdit "bench-document.txt"', apps: ['TextEdit'],
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
  const browser = await openBrowser(ctx.browser, { profileDir: path.join(ctx.workDir, 'browser-profile'), cdpPort: ctx.cdpPort,
    url: ctx.server.url(f.page, ctx.runId, f.query), pos: ctx.pos });
  return {
    window: `the browser window showing the page "${PAGE_TITLES[f.page] ?? f.page}" (a private window, already open)`,
    apps: browserAppNames(ctx.browser.kind),
    state: async () => ctx.server.state(ctx.runId),
    close: () => browser.close(),
  };
}
