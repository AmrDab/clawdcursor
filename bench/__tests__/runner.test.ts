import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { agentRoot, needsImages, notApplicable, parseArgs, prepareOutDir, selectTasks } from '../run';
import { Cleanup } from '../lib/cleanup';
import { browserAppNames, browserArgs, findBrowser } from '../lib/browser';
import { isolatedEnv, serverCommand } from '../lib/isolated';
import { nativeArgs, parseCalcDisplay, parseCalcProbe } from '../lib/live-fixtures';
import { evaluate } from '../lib/tasks';
import { buildPrompt, PRIVACY_RULES } from '../lib/prompt';
import { DONE_MARK, FAILED_MARK } from '../lib/scorer';
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
    expect(parseArgs([])).toEqual({ live: false, selfcheck: false, includeManual: false, updateBaseline: false, repeats: 1 });
    expect(parseArgs(['--live']).live).toBe(true);
  });

  it('reads every option', () => {
    expect(parseArgs(['--live', '--build', '.', '--models', 'claude-code:sonnet', '--tasks', 'a, b', '--out', 'o', '--baseline', 'b.json',
      '--include-manual', '--update-baseline', '--repeats', '3'])).toEqual({ live: true, selfcheck: false, includeManual: true,
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
    expect(() => prepareOutDir(file)).toThrow(/is not empty/);
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
