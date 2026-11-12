import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { RESULT_FILES, agentRoot, needsImages, notApplicable, notRunAfter, parseArgs, prepareOutDir, readBaseline, selectTasks, writeTaskResults } from '../run';
import { which } from '../lib/proc';
import { globalPackageRoots, resolveCli } from '../lib/isolated';
import { Cleanup } from '../lib/cleanup';
import { browserAppNames, browserArgs, findBrowser } from '../lib/browser';
import { isolatedEnv, serverCommand } from '../lib/isolated';
import { nativeArgs, nativeStatePath, parseCalcDisplay, parseCalcProbe, readStateFile } from '../lib/live-fixtures';
import { evaluate } from '../lib/tasks';
import { buildPrompt, PRIVACY_RULES } from '../lib/prompt';
import { DONE_MARK, FAILED_MARK, buildReport, renderMarkdown } from '../lib/scorer';
import { loadTasks } from '../lib/tasks';

describe('the isolated clawdcursor', () => {
  it('runs the compact surface on its own port and accepts consent in its own home', () => {
    const { cmd, args } = serverCommand('/repo/dist/surface/cli.js', 4567);
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(['/repo/dist/surface/cli.js', 'agent', '--compact', '--port', '4567', '--accept']);
  });

  it('gets a temp home, its own session directory and the fixture browser port; nothing of the owner\'s setup', () => {
    expect(isolatedEnv({}, { home: '/h', sessionDir: '/s', cdpPort: 1, fencePids: [4120, 4188] }).CLAWD_FENCE_PIDS).toBe('4120,4188');
    // No fixture process known: the fence is still set, and then everything is outside it.
    expect(isolatedEnv({}, { home: '/h', sessionDir: '/s', cdpPort: 1, fencePids: [] }).CLAWD_FENCE_PIDS).toBe('none');
    const env = isolatedEnv({ PATH: '/bin', CLAWD_FENCE_PIDS: '1', HOME: '/home/owner', USERPROFILE: 'C:\\Users\\owner', APPDATA: 'C:\\Users\\owner\\AppData\\Roaming',
      CLAWDCURSOR_SESSION_DIR: '/home/owner/.clawdcursor/sessions', CLAWD_NO_BANNER: '1', CLAWD_AGENT_CDP_PORT: '9333', CLAWDCURSOR_LOG_DIR: '/x' },
    { home: '/tmp/bench/home', sessionDir: '/tmp/bench/sessions', cdpPort: 5555 });
    expect(env).toEqual({ PATH: '/bin', APPDATA: 'C:\\Users\\owner\\AppData\\Roaming', HOME: '/tmp/bench/home', USERPROFILE: '/tmp/bench/home',
      CLAWDCURSOR_SESSION_DIR: '/tmp/bench/sessions', CLAWD_AGENT_CDP_PORT: '5555' });
  });
});

describe('the fixture browser', () => {
  const args = (kind: 'edge' | 'chrome') => browserArgs({ kind, profileDir: '/tmp/p', url: 'http://127.0.0.1:1/form.html?run=r', pos: [1920, 40] });

  it('is a separate instance (temp profile) in a private window, on the fixture page', () => {
    const a = args('edge');
    expect(a).toContain('--user-data-dir=/tmp/p');
    expect(a).toContain('--inprivate');
    expect(a).toContain('--remote-debugging-port=0');   // the port is read from the profile it wrote it to
    expect(a).toContain('--window-position=1920,40');
    expect(a[a.length - 1]).toBe('http://127.0.0.1:1/form.html?run=r');
    expect(args('chrome')).toContain('--incognito');
    expect(args('chrome')).not.toContain('--inprivate');
  });

  it('is found among the installed Chromium browsers, or not at all', () => {
    expect(findBrowser('win32', p => p.includes('Chrome'))).toMatchObject({ kind: 'chrome' });
    expect(findBrowser('darwin', p => p.includes('Edge'))).toMatchObject({ kind: 'edge' });
    expect(findBrowser('linux', () => false)).toBeNull();
  });

  it('is named by its display name only: no process or host name in the allowlist', () => {
    expect(browserAppNames('edge')).toEqual(['Edge', 'Microsoft Edge']);
    expect(browserAppNames('chrome')).toEqual(['Chrome', 'Google Chrome']);
    expect(browserAppNames('chromium')).toEqual(['Chromium']);
  });
});

describe('fixtures', () => {
  it('passes the state file, the mode and the position to the native fixture', () => {
    expect(nativeArgs({ state: '/tmp/s.json', mode: 'editor' })).toEqual(['--state', '/tmp/s.json', '--mode', 'editor']);
    expect(nativeArgs({ state: '/tmp/s.json', mode: 'dialog', pos: [-1200, 300] })).toEqual(['--state', '/tmp/s.json', '--mode', 'dialog', '--pos', '-1200,300']);
  });

  it('reads the Calculator probe: the display and the expression that produced it', () => {
    expect(parseCalcProbe('display Display is 4,183\r\nexpression Expression is 47 × 89=\r\n')).toEqual({ display: '4183', expression: '47 × 89=' });
    expect(parseCalcProbe('display Display is 4,183\r\n')).toEqual({ display: '4183', expression: '' });
    expect(parseCalcProbe('')).toBeNull();
  });

  it('the Calculator task is exact: typing the result does not pass', () => {
    const task = loadTasks().find(t => t.id === 'calc-multiply')!;
    expect(evaluate(task.success!, { state: { display: '4183', expression: '47 × 89=' }, events: [] })).toBe(true);
    expect(evaluate(task.success!, { state: { display: '4183', expression: '' }, events: [] })).toBe(false);          // typed 4183
    expect(evaluate(task.success!, { state: { display: '4183', expression: '4183 × 1=' }, events: [] })).toBe(false);
    expect(evaluate(task.success!, { state: { display: '4183', expression: '47 × 89' }, events: [] })).toBe(false);    // not evaluated
  });

  it('reads the Calculator display as digits', () => {
    expect(parseCalcDisplay('Display is 4,183\r\n')).toBe('4183');
    expect(parseCalcDisplay('4183')).toBe('4183');
    expect(parseCalcDisplay('Display is -12.5')).toBe('-12.5');
    expect(parseCalcDisplay('Display is 0')).toBe('0');
  });
});

describe('the prompt', () => {
  const task = loadTasks().find(t => t.id === 'web-trap-new')!;
  const prompt = buildPrompt(task, 'the browser window showing "Bench Traps"');

  it('puts the privacy rules before the task', () => {
    for (const r of PRIVACY_RULES) expect(prompt).toContain(r);
    expect(prompt.indexOf(PRIVACY_RULES[0])).toBeLessThan(prompt.indexOf(task.prompt));
    expect(prompt).toMatch(/ONLY in the fixture window/);
    expect(prompt).toMatch(/Never list windows/);
    expect(prompt).toMatch(/any other window or app/);
  });

  it('names the window, the task and the end marks', () => {
    expect(prompt).toContain('Fixture window: the browser window showing "Bench Traps"');
    expect(prompt).toContain(`Task: ${task.prompt}`);
    expect(prompt).toContain(DONE_MARK);
    expect(prompt).toContain(FAILED_MARK);
  });
});

describe('the command line', () => {
  it('plans by default: a live run must be asked for', () => {
    expect(parseArgs([])).toEqual({ live: false, selfcheck: false, selfcheckFixtures: false, writeOracles: false, includeManual: false, updateBaseline: false, repeats: 1 });
    expect(parseArgs(['--live']).live).toBe(true);
  });

  it('reads every option', () => {
    expect(parseArgs(['--live', '--build', '.', '--models', 'claude-code:sonnet', '--tasks', 'a, b', '--out', 'o', '--baseline', 'b.json',
      '--include-manual', '--update-baseline', '--repeats', '3'])).toEqual({ live: true, selfcheck: false, selfcheckFixtures: false, writeOracles: false, includeManual: true,
      updateBaseline: true, repeats: 3, build: '.', models: 'claude-code:sonnet', tasks: ['a', 'b'], out: 'o', baseline: 'b.json' });
  });

  it('rejects an unknown option, a missing value and a bad position', () => {
    expect(() => parseArgs(['--fast'])).toThrow('unknown option --fast');
    expect(() => parseArgs(['--build'])).toThrow('--build needs a value');
    // Fixture windows open on the primary monitor only: there is no option to move them (the fence refuses other monitors).
    expect(() => parseArgs(['--window-pos', '-1920,40'])).toThrow('unknown option --window-pos');
    expect(() => parseArgs(['--repeats', '0'])).toThrow('1 to 9');
  });
});

describe('selectTasks', () => {
  const all = loadTasks();

  it('runs the tasks of this OS and leaves out manual-verify tasks unless asked', () => {
    const win = selectTasks(all, { includeManual: false }, 'windows');
    expect(win.run.map(t => t.id)).not.toContain('textedit-type-lines');
    expect(win.run.map(t => t.id)).not.toContain('cad-designcenter-orbit');
    expect(win.run.map(t => t.id)).toContain('editor-type-lines');
    expect(win.skipped.find(s => s.task === 'cad-designcenter-orbit')!.why).toMatch(/manual/);
    expect(selectTasks(all, { includeManual: true }, 'windows').run.map(t => t.id)).toContain('cad-designcenter-orbit');
  });

  it('gives macOS and Linux their own sets', () => {
    const mac = selectTasks(all, { includeManual: false }, 'macos').run.map(t => t.id);
    expect(mac).toContain('textedit-type-lines');
    expect(mac).not.toContain('editor-type-lines');
    const linux = selectTasks(all, { includeManual: false }, 'linux').run.map(t => t.id);
    expect(linux).toContain('native-dialog-fill');
    expect(linux).not.toContain('calc-multiply');
  });

  it('narrows to the named tasks and rejects an unknown one', () => {
    expect(selectTasks(all, { tasks: ['web-trap-new'], includeManual: false }, 'windows').run.map(t => t.id)).toEqual(['web-trap-new']);
    expect(() => selectTasks(all, { tasks: ['nope'], includeManual: false })).toThrow('unknown task(s): nope');
  });
});

describe('what ships', () => {
  it('bench/ is not in the npm package', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    expect(pkg.files.some((f: string) => f.replace(/^!/, '').startsWith('bench'))).toBe(false);
    expect(pkg.scripts.bench).toBe('tsx bench/run.ts');
  });
});

describe('a model that is shown no images', () => {
  const all = loadTasks();
  const blind = { label: 'ollama:qwen2.5:7b', adapter: { seesImages: false } };
  const sighted = { label: 'claude-code:sonnet', adapter: { seesImages: true } };

  it('does not run the tasks that need a screenshot: they are n/a, not failed', () => {
    expect(all.filter(needsImages).map(t => t.id).sort()).toEqual(['cad-designcenter-orbit', 'web-canvas-draw', 'web-canvas-targets']);
    for (const t of all.filter(needsImages)) {
      expect(notApplicable(t, blind)).toMatch(/^n\/a for ollama:qwen2.5:7b/);
      expect(notApplicable(t, sighted)).toBeNull();
    }
  });
  it('runs every other task', () => {
    for (const t of all.filter(t => !needsImages(t))) expect(notApplicable(t, blind)).toBeNull();
  });
});

describe('the results directory', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bench-out-test-'));

  it('is created when it does not exist, and an empty one is used', () => {
    const base = tmp();
    const fresh = path.join(base, 'new', 'run');
    expect(prepareOutDir(fresh)).toBe(fresh);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(prepareOutDir(fresh)).toBe(fresh);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('is refused when it holds anything: old session logs would be read back as this run\'s', () => {
    const base = tmp();
    fs.mkdirSync(path.join(base, 'claude-code_sonnet', 'web-trap-new', 'sessions'), { recursive: true });
    expect(() => prepareOutDir(base)).toThrow(/is not empty/);
    const file = path.join(base, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(() => prepareOutDir(file)).toThrow(/is not a directory/);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('with no --out it is a new private directory with a name nobody can guess', () => {
    const a = prepareOutDir();
    const b = prepareOutDir();
    try {
      expect(a).not.toBe(b);
      expect(path.dirname(a)).toBe(fs.realpathSync(os.tmpdir()) === os.tmpdir() ? os.tmpdir() : path.dirname(a));
      expect(path.basename(a)).toMatch(/^clawdcursor-bench-.{6}$/);
      expect(fs.readdirSync(a)).toEqual([]);
      if (process.platform !== 'win32') expect(fs.statSync(a).mode & 0o077).toBe(0);
    } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
  });

  it('the baseline is read in one step: none yet is null, a broken one is an error', () => {
    const base = tmp();
    expect(readBaseline(path.join(base, 'windows.json'))).toBeNull();
    fs.writeFileSync(path.join(base, 'windows.json'), JSON.stringify({ meta: {}, scores: [] }));
    expect(readBaseline(path.join(base, 'windows.json'))).toEqual({ meta: {}, scores: [] });
    fs.writeFileSync(path.join(base, 'broken.json'), '{');
    expect(() => readBaseline(path.join(base, 'broken.json'))).toThrow();
    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe('where the agents run', () => {
  it('is a new empty directory outside the owner\'s home', () => {
    const dir = agentRoot();
    try {
      expect(fs.readdirSync(dir)).toEqual([]);
      const home = (process.env.CLAWD_TEST_REAL_HOME ?? os.homedir()).toLowerCase();
      if (process.platform === 'win32' && process.env.PUBLIC) expect(dir.toLowerCase().startsWith(home + path.sep)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it.runIf(process.platform === 'win32')('is readable by the current user alone: it holds the MCP config with the bearer token', () => {
    const dir = agentRoot();
    try {
      const acl = execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [dir], { encoding: 'utf8' });
      const entries = acl.split(/\r?\n/).map(l => l.replace(dir, '').trim()).filter(l => /:\(/.test(l));
      expect(entries).toHaveLength(1);                                   // one entry: no inherited Users / Everyone / INTERACTIVE
      expect(entries[0]).toMatch(/:\(OI\)\(CI\)\(F\)$/);
      expect(acl).not.toMatch(/BUILTIN\\Users|Everyone|INTERACTIVE|Authenticated Users/i);
      fs.writeFileSync(path.join(dir, 'mcp.json'), '{}');                // and the owner can still use it
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('falls back to the temp directory', () => {
    const dir = agentRoot('linux', {});
    expect(dir.startsWith(os.tmpdir())).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('cleanup on Ctrl+C or a crash', () => {
  it('closes everything still registered, newest first, each once', async () => {
    const c = new Cleanup();
    const order: string[] = [];
    c.add(() => { order.push('temp homes'); });
    const fixtureClosed = c.add(async () => { order.push('fixture'); });
    c.add(() => { order.push('daemon'); });
    c.add(() => { order.push('agent'); });
    expect(c.pending).toBe(4);
    await c.runAll();
    expect(order).toEqual(['agent', 'daemon', 'fixture', 'temp homes']);
    await c.runAll();
    expect(order).toHaveLength(4);
    fixtureClosed();
  });

  it('does not close what was already closed the normal way', async () => {
    const c = new Cleanup();
    const order: string[] = [];
    const done = c.add(() => { order.push('daemon'); });
    c.add(() => { order.push('fixture'); });
    done();
    await c.runAll();
    expect(order).toEqual(['fixture']);
  });

  it('goes on when a closer throws or hangs', async () => {
    const c = new Cleanup();
    const order: string[] = [];
    c.add(() => { order.push('last'); });
    c.add(() => new Promise<void>(() => { /* never */ }));
    c.add(() => { throw new Error('boom'); });
    await c.runAll(30);
    expect(order).toEqual(['last']);
  });

  it.each([['SIGINT', 130], ['SIGTERM', 143], ['uncaughtException', 1]])('on %s: closes everything, then exits with %i', async (signal, code) => {
    const c = new Cleanup();
    const target = new EventEmitter();
    const closed: string[] = [];
    c.add(async () => { await new Promise(r => setTimeout(r, 10)); closed.push('daemon'); });
    c.add(() => { closed.push('agent'); });
    const exits: number[] = [];
    let closedAtExit: string[] = [];
    const exited = new Promise<void>(resolve => {
      c.install({ target, log: () => {}, exit: n => { exits.push(n); closedAtExit = [...closed]; resolve(); } });
    });
    target.emit(signal);
    await exited;
    expect(exits).toEqual([code]);
    expect(closedAtExit).toEqual(['agent', 'daemon']);
  });

  it('a second Ctrl+C while closing exits at once', () => {
    const c = new Cleanup();
    const target = new EventEmitter();
    c.add(() => new Promise<void>(() => { /* a closer that hangs */ }));
    const exits: number[] = [];
    c.install({ target, log: () => {}, exit: n => { exits.push(n); } });
    target.emit('SIGINT');
    expect(exits).toEqual([]);
    target.emit('SIGINT');
    expect(exits).toEqual([130]);
  });

  it('the handlers can be removed', () => {
    const c = new Cleanup();
    const target = new EventEmitter();
    const uninstall = c.install({ target, log: () => {}, exit: () => {} });
    expect(target.listenerCount('SIGINT')).toBe(1);
    uninstall();
    expect(target.listenerCount('SIGINT')).toBe(0);
  });
});

describe('no shell anywhere', () => {
  const lib = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const sources = ['run.ts', 'lib/proc.ts', 'lib/isolated.ts', 'lib/browser.ts', 'lib/live-fixtures.ts', 'lib/ownership.ts', 'lib/selfcheck.ts',
    'lib/adapters/common.ts', 'lib/adapters/claude-code.ts', 'lib/adapters/codex.ts', 'lib/adapters/ollama.ts'];

  it('nothing is run through cmd.exe, a shell option or exec()', () => {
    for (const f of sources) {
      const src = lib(f);
      expect(src, f).not.toMatch(/ComSpec|cmd\.exe|shell: true|['"]\/c['"]|\bexecSync\(|[^.\w]exec\(/);
    }
  });

  it('a program is found on PATH as a real executable only: a .cmd shim is not one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-which-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'shim.cmd'), '@echo off');
      fs.writeFileSync(path.join(dir, 'tool.exe'), '');
      fs.writeFileSync(path.join(dir, 'tool'), '');
      expect(which('shim', { PATH: dir }, 'win32')).toBeNull();
      expect(which('tool', { PATH: dir }, 'win32')).toBe(path.join(dir, 'tool.exe'));
      // A POSIX PATH is split on colons, which a Windows drive letter has: checked where paths have none.
      if (process.platform !== 'win32') expect(which('tool', { PATH: `/nowhere:${dir}` }, 'linux')).toBe(path.join(dir, 'tool'));
      expect(which('missing', { PATH: dir }, 'linux')).toBeNull();
      expect(which('tool', {}, 'linux')).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('the global install is found by looking, not by asking npm', async () => {
    const win = globalPackageRoots({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming', PATH: '' }, 'win32', 'C:\\Program Files\\nodejs\\node.exe');
    expect(win.some(r => /AppData[\\/]Roaming[\\/]npm[\\/]node_modules[\\/]clawdcursor$/.test(r))).toBe(true);
    const nix = globalPackageRoots({ PATH: '' }, 'linux', '/usr/local/bin/node');
    expect(nix.map(r => r.replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''))).toContain('/usr/local/lib/node_modules/clawdcursor');
    // A build directory: its package.json and its built CLI are read, nothing is run.
    const repo = path.join(__dirname, '..', '..');
    await expect(resolveCli(path.join(repo, 'no-such-dir'))).rejects.toThrow(/npm run build/);
  });
});

describe('a task\'s results directory: one writer per file', () => {
  const agent = { finalText: 'BENCH_RESULT: DONE', exitCode: 0, sigs: [], seconds: 1 };
  /** What a native task does to its directory: the fixture starts and writes its live state there, the agent runs, the runner writes the results. */
  const nativeTask = (workDir: string, fixtureStarts: (stateFile: string) => void) => {
    const live = nativeStatePath(workDir);
    fixtureStarts(live);
    const state = readStateFile(live);
    writeTaskResults(workDir, state, agent);
    return { live, state };
  };
  const fakeFixture = (stateFile: string) => fs.writeFileSync(stateFile, JSON.stringify({ state: { text: '' }, events: [] }));

  it('the fixture\'s live state file and the runner\'s result file have different names', () => {
    const live = path.basename(nativeStatePath('/run'));
    expect(Object.values(RESULT_FILES)).not.toContain(live);
    expect(live).not.toBe('fixture-state.json');
  });

  it('a native task\'s setup and results, twice, each in a fresh directory: no EEXIST', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-results-test-'));
    try {
      for (const task of ['editor-type-lines', 'native-dialog-fill']) {
        const workDir = path.join(base, 'claude-code_sonnet', task);
        fs.mkdirSync(workDir, { recursive: true });
        const { state } = nativeTask(workDir, fakeFixture);
        expect(state).toEqual({ state: { text: '' }, events: [] });
        expect(fs.readdirSync(workDir).sort()).toEqual(['agent.json', 'fixture-state.json', 'native-fixture.live.json']);
        expect(JSON.parse(fs.readFileSync(path.join(workDir, 'fixture-state.json'), 'utf8'))).toEqual(state);
      }
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it.runIf(process.platform === 'win32')('the same with the real WinForms fixture writing its state (its self-test: no window)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-results-test-'));
    try {
      const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'fixtures', 'native', 'windows', 'build.ps1'), '-OutDir', base],
        { timeout: 90_000, cwd: base });
      for (const [i, mode] of ['editor', 'dialog', 'editor'].entries()) {
        const workDir = path.join(base, `run-${i}`);
        fs.mkdirSync(workDir);
        const { state } = nativeTask(workDir, stateFile => { execFileSync(path.join(base, 'BenchFixture.exe'), ['--state', stateFile, '--mode', mode, '--selftest'], { timeout: 30_000 }); });
        expect(state?.events.length).toBeGreaterThan(0);
        expect(fs.existsSync(path.join(workDir, 'fixture-state.json'))).toBe(true);
      }
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }, 120_000);

  it('the runner writes its files once: a second write to the same directory is refused, not an overwrite', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-results-test-'));
    try {
      writeTaskResults(workDir, { state: {}, events: [] }, agent);
      expect(() => writeTaskResults(workDir, { state: { forged: true }, events: [] }, agent)).toThrow(/EEXIST/);
      expect(JSON.parse(fs.readFileSync(path.join(workDir, 'fixture-state.json'), 'utf8'))).toEqual({ state: {}, events: [] });
    } finally { fs.rmSync(workDir, { recursive: true, force: true }); }
  });

  it('the live state of a task with no state (a manual-verify task) is null, and still written', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-results-test-'));
    try {
      writeTaskResults(workDir, null, agent);
      expect(fs.readFileSync(path.join(workDir, 'fixture-state.json'), 'utf8')).toBe('null');
    } finally { fs.rmSync(workDir, { recursive: true, force: true }); }
  });
});

describe('a fixture whose window the benchmark needs is started with its window on screen', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'live-fixtures.ts'), 'utf8');

  it('the native fixture and Calculator are started visible, never with windowsHide (which hides the first window)', () => {
    expect(src).toMatch(/startVisible\(native\.cmd/);
    expect(src).toMatch(/startVisible\(system32\('calc\.exe'\)/);
    expect(src).not.toMatch(/[^A-Za-z]start\(/);   // no plain start() of a GUI app left in this file
  });

  it('startVisible turns windowsHide off, whatever the caller passed', async () => {
    const proc = await import('../lib/proc');
    const child = proc.startVisible(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
    const code = await new Promise(r => child.once('exit', r));
    expect(code).toBe(0);
    // The flag itself is not readable from a child: the one place it is set is checked in the source.
    expect(fs.readFileSync(path.join(__dirname, '..', 'lib', 'proc.ts'), 'utf8')).toMatch(/return start\(cmd, args, \{ \.\.\.opts, windowsHide: false \}\);/);
  });

  it('the runner waits for the fixture\'s window, not only for its state file', async () => {
    expect(src).toMatch(/waitFor\(\(\) => hasWindow\(child\.pid\)/);
    const { hasWindow } = await import('../lib/proc');
    expect(await hasWindow(1234, 'linux')).toBe(true);
    expect(await hasWindow(undefined, 'win32')).toBe(false);
  });

  it('has a flag for the check that opens the real fixtures behind the fence', () => {
    expect(parseArgs(['--selfcheck-fixtures']).selfcheckFixtures).toBe(true);
    expect(parseArgs([]).selfcheckFixtures).toBe(false);
  });
});

describe('a privacy stop ends the run: what it did not get to is reported', () => {
  const tasks = loadTasks().filter(t => ['calc-multiply', 'web-canvas-draw', 'web-trap-new'].includes(t.id));
  const model = (label: string, seesImages = true) => ({ label, model: label.split(':')[1], adapter: { seesImages } }) as never;
  const codex = model('codex:default');
  const local = model('ollama:qwen2.5:7b', false);

  it('the rest of that model\'s tasks, then every task of the models after it', () => {
    expect(notRunAfter([codex, local], tasks, codex, tasks[0])).toEqual([
      { model: 'codex:default', task: 'web-canvas-draw' }, { model: 'codex:default', task: 'web-trap-new' },
      { model: 'ollama:qwen2.5:7b', task: 'calc-multiply' }, { model: 'ollama:qwen2.5:7b', task: 'web-trap-new' },   // the canvas task is n/a for it anyway
    ]);
  });

  it('nothing when the stop came on the last task of the last model, and models before it are not listed', () => {
    expect(notRunAfter([codex, local], tasks, local, tasks[2])).toEqual([]);
    expect(notRunAfter([codex, local], tasks, local, tasks[0]).map(x => x.model)).toEqual(['ollama:qwen2.5:7b']);
  });

  it('they are listed in the report as not run, not as failures', () => {
    const skipped = notRunAfter([codex], tasks, codex, tasks[0]).map(x => ({ task: x.task, why: `${x.model}: not run (privacy stop)` }));
    const md = renderMarkdown(buildReport({ date: 'd', os: 'windows', clawdcursor: '2', models: ['codex:default'], skipped }, []));
    expect(md).toContain('- web-canvas-draw: codex:default: not run (privacy stop)');
    expect(md).toContain('- web-trap-new: codex:default: not run (privacy stop)');
  });
});
