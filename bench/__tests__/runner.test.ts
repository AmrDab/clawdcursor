import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseArgs, selectTasks } from '../run';
import { browserAppNames, browserArgs, findBrowser } from '../lib/browser';
import { isolatedEnv, serverCommand } from '../lib/isolated';
import { nativeArgs, parseCalcDisplay } from '../lib/live-fixtures';
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
    const env = isolatedEnv({ PATH: '/bin', HOME: '/home/owner', USERPROFILE: 'C:\\Users\\owner', APPDATA: 'C:\\Users\\owner\\AppData\\Roaming',
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
    expect(parseArgs([])).toEqual({ live: false, selfcheck: false, includeManual: false, updateBaseline: false });
    expect(parseArgs(['--live']).live).toBe(true);
  });

  it('reads every option', () => {
    expect(parseArgs(['--live', '--build', '.', '--models', 'claude-code:sonnet', '--tasks', 'a, b', '--out', 'o', '--baseline', 'b.json',
      '--window-pos', '-1920,40', '--include-manual', '--update-baseline'])).toEqual({ live: true, selfcheck: false, includeManual: true,
      updateBaseline: true, build: '.', models: 'claude-code:sonnet', tasks: ['a', 'b'], out: 'o', baseline: 'b.json', pos: [-1920, 40] });
  });

  it('rejects an unknown option, a missing value and a bad position', () => {
    expect(() => parseArgs(['--fast'])).toThrow('unknown option --fast');
    expect(() => parseArgs(['--build'])).toThrow('--build needs a value');
    expect(() => parseArgs(['--window-pos', 'left'])).toThrow('x,y');
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
