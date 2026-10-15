/**
 * LinuxAdapter behavior tests (1.5.12 Linux bug batch).
 *
 * Every external process is mocked (execFile / spawn / nut-js / fs) so these
 * run on the Windows dev box and on every CI OS. Each `describe` locks in one
 * live-verified Linux bug from the Ubuntu 24.04 (Xvfb + openbox) MCP run:
 *
 *   L2 writeClipboard waited for xclip's 'close' — xclip forks a selection
 *      server that keeps the pipes open, so every write took TOOL_TIMEOUT_MS.
 *   L3 setWindowState('normal') removed the `hidden` hint but never
 *      un-iconified the window (needs activation).
 *   L4 listWindows reported processName '' for every window, so focus /
 *      app_running by process name never matched.
 *   L5 keyPress typed unknown key names as text and reported success.
 *   L6 GDK_SCALE in the environment faked dpiRatio=2 on X11, where xdotool /
 *      nut-js / X input all work in physical pixels.
 *   L7 findElements without a pid let the Python bridge guess the app.
 *   L8 invokeElement was a {success:false} stub.
 *   L9 AT-SPI role names weren't normalized; INT_MIN bounds were published.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

type ExecResult = { stdout: string; stderr?: string };
const h = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
  exec: null as null | ((cmd: string, args: string[]) => ExecResult | Promise<ExecResult>),
  spawn: null as null | ((cmd: string, args: string[], opts: unknown) => unknown),
  proc: {} as Record<string, string | Error>,
  files: {} as Record<string, string>,
  keyboard: {
    config: {} as Record<string, unknown>,
    type: null as unknown,
    pressKey: null as unknown,
    releaseKey: null as unknown,
  },
}));

vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb?: (e: unknown, r?: unknown) => void) => {
    const done = (typeof opts === 'function' ? opts : cb) as (e: unknown, r?: unknown) => void;
    h.calls.push({ cmd, args });
    try {
      Promise.resolve(h.exec!(cmd, args)).then(
        r => done(null, { stdout: r.stdout, stderr: r.stderr ?? '' }),
        e => done(e),
      );
    } catch (e) {
      done(e);
    }
  },
  spawn: (cmd: string, args: string[], opts: unknown) => h.spawn!(cmd, args, opts),
}));

vi.mock('@nut-tree-fork/nut-js', async () => {
  // Real Key enum (pure data, no native binding) so the adapter's key tables
  // hold the same values production does.
  const { Key } = await import('@nut-tree-fork/shared/dist/lib/enums/key.enum.js');
  return {
    mouse: { config: {}, setPosition: vi.fn(), click: vi.fn(), pressButton: vi.fn(), releaseButton: vi.fn() },
    keyboard: h.keyboard,
    screen: { width: async () => 1920, height: async () => 1080, grab: vi.fn() },
    Point: class { constructor(public x: number, public y: number) {} },
    Button: { LEFT: 0, MIDDLE: 1, RIGHT: 2 },
    Key,
  };
});
vi.mock('sharp', () => ({ default: vi.fn() }));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    // .desktop entries under the XDG application dirs come from h.files.
    readdirSync: (p: unknown, ...rest: unknown[]) => {
      const dir = String(p);
      if (dir.endsWith('/applications')) {
        const names = Object.keys(h.files).filter(f => f.startsWith(dir + '/')).map(f => f.slice(dir.length + 1));
        if (!names.length) throw Object.assign(new Error(`ENOENT ${dir}`), { code: 'ENOENT' });
        return names;
      }
      return (actual.readdirSync as any)(p, ...rest);
    },
    readFileSync: (p: unknown, ...rest: unknown[]) => {
      const key = String(p);
      if (key in h.files) return h.files[key];
      if (key.startsWith('/proc/')) {
        const v = h.proc[key];
        if (v === undefined) throw Object.assign(new Error(`ENOENT ${key}`), { code: 'ENOENT' });
        if (v instanceof Error) throw v;
        return v;
      }
      return (actual.readFileSync as any)(p, ...rest);
    },
  };
});

import { Key } from '@nut-tree-fork/shared/dist/lib/enums/key.enum.js';
import { LinuxAdapter } from '../platform/linux';
import { normalizeRole } from '../core/sense/ui-map-normalize';

// 0x3c00003 = 62914563 — calculator; 0x3c00004 = 62914564 — mousepad
const WMCTRL = [
  '0x03c00003  0 4242   100 200 800 600  box gnome-calculator',
  '0x03c00004  0 5555   50 60 640 480  box Untitled - Mousepad',
].join('\n') + '\n';
const XRANDR = 'Screen 0: minimum 8 x 8, current 1920 x 1080, maximum 32767 x 32767\n' +
  'screen connected primary 1920x1080+0+0 0mm x 0mm\n';

/** Default exec handler: every binary present, calculator is the active window. */
function defaultExec(python: (args: string[]) => unknown = () => ({ elements: [] })) {
  return (cmd: string, args: string[]): ExecResult => {
    if (cmd === 'command' || cmd === 'which') return { stdout: '/usr/bin/x\n' };
    if (cmd === 'xrandr') return { stdout: XRANDR };
    if (cmd === 'wmctrl') return { stdout: args[0] === '-l' ? WMCTRL : '' };
    if (cmd === 'xdotool' && args[0] === 'getactivewindow') return { stdout: '62914563\n' };
    if (cmd === 'python3') {
      // init() probes `python3 -c "import gi..."`; bridge calls pass the script path.
      if (args[0] === '-c') return { stdout: '' };
      return { stdout: JSON.stringify(python(args.slice(1))) };
    }
    return { stdout: '' };
  };
}

const ENV_KEYS = ['GDK_SCALE', 'QT_SCALE_FACTOR', 'XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'XDG_DATA_HOME', 'XDG_DATA_DIRS'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  h.calls.length = 0;
  h.exec = defaultExec();
  h.spawn = () => { throw new Error('spawn not expected'); };
  h.proc = {};
  h.files = {};
  h.keyboard.type = vi.fn(async () => {});
  h.keyboard.pressKey = vi.fn(async () => {});
  h.keyboard.releaseKey = vi.fn(async () => {});
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.XDG_SESSION_TYPE = 'x11';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

/** Python-bridge invocations (cmd === 'python3' with the script path first). */
function bridgeCalls() {
  return h.calls.filter(c => c.cmd === 'python3' && c.args[0] !== '-c').map(c => c.args.slice(1));
}

// ─── L2 ───────────────────────────────────────────────────────────────────────
describe('L2 — writeClipboard returns when xclip exits, not when its pipes close', () => {
  it('resolves on "exit" even though "close" never fires, and ignores stdout/stderr', async () => {
    let spawnOpts: any;
    let proc: any;
    h.spawn = (_cmd, _args, opts) => {
      spawnOpts = opts;
      proc = new EventEmitter();
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.kill = vi.fn();
      // xclip forks: the parent exits immediately, the forked selection server
      // keeps stdout/stderr open indefinitely → 'close' never arrives.
      setTimeout(() => proc.emit('exit', 0, null), 10);
      return proc;
    };
    const adapter = new LinuxAdapter();
    const started = Date.now();
    await adapter.writeClipboard('hello');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(proc.stdin.write).toHaveBeenCalledWith('hello');
    expect(proc.kill).not.toHaveBeenCalled();
    expect(spawnOpts?.stdio).toEqual(['pipe', 'ignore', 'ignore']);
  });
});

// ─── L3 ───────────────────────────────────────────────────────────────────────
describe('L3 — restore un-minimizes (activates) the window', () => {
  it('removes the hidden hint AND activates the window by id', async () => {
    const adapter = new LinuxAdapter();
    const ok = await adapter.setWindowState('normal', { title: 'calculator' });
    expect(ok).toBe(true);
    const wm = h.calls.filter(c => c.cmd === 'wmctrl' || c.cmd === 'xdotool').map(c => [c.cmd, ...c.args].join(' '));
    const removeIdx = wm.findIndex(s => s === 'wmctrl -i -r 0x3c00003 -b remove,maximized_vert,maximized_horz,hidden');
    const activateIdx = wm.findIndex(s => s === 'wmctrl -i -a 0x3c00003' || s === 'xdotool windowactivate 0x3c00003');
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(activateIdx).toBeGreaterThan(removeIdx);
  });
});

// ─── L4 ───────────────────────────────────────────────────────────────────────
describe('L4 — listWindows resolves processName from /proc', () => {
  it('uses argv[0] basename from /proc/<pid>/cmdline, falls back to comm', async () => {
    h.proc['/proc/4242/cmdline'] = '/usr/bin/gnome-calculator\0--gapplication-service\0';
    h.proc['/proc/5555/comm'] = 'mousepad\n'; // no cmdline → comm
    const adapter = new LinuxAdapter();
    const wins = await adapter.listWindows();
    expect(wins.map(w => w.processName)).toEqual(['gnome-calculator', 'mousepad']);
  });

  it('a cmdline rewritten into one space-joined string (Chromium) yields the binary name', async () => {
    h.proc['/proc/4242/cmdline'] = '/opt/google/chrome/chrome --remote-debugging-port=9333 --user-data-dir=/home/c/.clawdcursor/cdp-profile --no-first-run\0';
    h.proc['/proc/4242/comm'] = 'chrome\n';
    // A path with a space and no rewrite still trusts comm over a half path.
    h.proc['/proc/5555/cmdline'] = '/opt/My App/myapp\0';
    h.proc['/proc/5555/comm'] = 'myapp\n';
    const adapter = new LinuxAdapter();
    const wins = await adapter.listWindows();
    expect(wins.map(w => w.processName)).toEqual(['chrome', 'myapp']);
  });

  it('focusWindow({processName}) now matches', async () => {
    h.proc['/proc/4242/cmdline'] = 'gnome-calculator\0';
    h.proc['/proc/5555/comm'] = 'mousepad\n';
    const adapter = new LinuxAdapter();
    expect(await adapter.focusWindow({ processName: 'gnome-calculator' })).toBe(true);
    expect(h.calls.some(c => c.cmd === 'wmctrl' && c.args.join(' ') === '-i -a 0x3c00003')).toBe(true);
  });

  it('leaves processName empty when /proc is unreadable', async () => {
    const adapter = new LinuxAdapter();
    const wins = await adapter.listWindows();
    expect(wins).toHaveLength(2);
    expect(wins[0].processName).toBe('');
  });
});

// ─── L5 ───────────────────────────────────────────────────────────────────────
describe('L5 — unknown key names are rejected, portable names still map', () => {
  it('throws Unknown key for a bogus name instead of typing it', async () => {
    const adapter = new LinuxAdapter();
    await expect(adapter.keyPress('notarealkey')).rejects.toThrow('Unknown key: "notarealkey"');
    await expect(adapter.keyPress('ctrl+notarealkey')).rejects.toThrow('Unknown key: "notarealkey"');
    await expect(adapter.keyPress('bogusmod+a')).rejects.toThrow('Unknown key: "bogusmod"');
    expect(h.keyboard.type).not.toHaveBeenCalled();
    expect(h.keyboard.pressKey).not.toHaveBeenCalled();
  });

  it('"super" alone presses the Super key rather than typing "super"', async () => {
    const adapter = new LinuxAdapter();
    await adapter.keyPress('super');
    expect(h.keyboard.type).not.toHaveBeenCalled();
    expect(h.keyboard.pressKey).toHaveBeenCalledWith(Key.LeftSuper);
    expect(h.keyboard.releaseKey).toHaveBeenCalledWith(Key.LeftSuper);
  });

  it('every portable key name used across the codebase still resolves', async () => {
    const adapter = new LinuxAdapter();
    const names = [
      // keys.ts canonical names + aliases
      'Return', 'return', 'enter', 'Space', 'space', 'spacebar', 'Tab', 'Escape', 'esc', 'Backspace', 'Delete',
      'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'pageup', 'PageDown', 'pagedown', 'Insert',
      'Shift', 'Control', 'ctrl', 'Alt', 'option', 'opt', 'Super', 'meta', 'win', 'windows', 'cmd', 'command', 'mod',
      'F1', 'f5', 'F12',
      // WIN_KEY_MAP / MAC_KEY_CODES extras
      'forwarddelete', 'capslock', 'numlock', 'scrolllock', 'pause', 'print', 'menu',
      // single printable characters
      'a', 'Z', '0', '9', '=', '+', '-', '_', '`', '*', '.', ',', '/', '\\', ';', "'", '[', ']',
      // combos the tools emit
      'mod+a', 'ctrl+Tab', 'ctrl+shift+Tab', 'mod+v', 'shift+a', 'alt+F4', 'super+up', 'ctrl++', 'ctrl+-',
    ];
    for (const n of names) {
      await expect(adapter.keyPress(n), n).resolves.toBeUndefined();
    }
  });

  it('a single printable character with no key mapping is typed', async () => {
    const adapter = new LinuxAdapter();
    await adapter.keyPress('*');
    expect(h.keyboard.type).toHaveBeenCalledWith('*');
  });
});

// ─── L6 ───────────────────────────────────────────────────────────────────────
describe('L6 — GDK_SCALE does not fake the DPI ratio on X11', () => {
  it('dpiRatio stays 1 and physical == logical with GDK_SCALE=2', async () => {
    process.env.GDK_SCALE = '2';
    const adapter = new LinuxAdapter();
    const size = await adapter.getScreenSize();
    expect(size.dpiRatio).toBe(1);
    expect(size.physicalWidth).toBe(1920);
    expect(size.physicalHeight).toBe(1080);
    const displays = await adapter.listDisplays();
    expect(displays[0].dpiRatio).toBe(1);
    expect(displays[0].physicalSize).toEqual({ width: 1920, height: 1080 });
  });

  it('QT_SCALE_FACTOR is ignored the same way', async () => {
    process.env.QT_SCALE_FACTOR = '1.5';
    const adapter = new LinuxAdapter();
    expect((await adapter.getScreenSize()).dpiRatio).toBe(1);
  });

  it('a real physical/logical mismatch (xrandr vs capture) is still honored', async () => {
    const base = defaultExec();
    h.exec = (cmd, args) => cmd === 'xrandr'
      ? { stdout: 'screen connected primary 960x540+0+0\n' }
      : base(cmd, args);
    const adapter = new LinuxAdapter();
    expect((await adapter.getScreenSize()).dpiRatio).toBe(2);
  });
});

// ─── L7 ───────────────────────────────────────────────────────────────────────
describe('L7 — findElements scopes to the foreground window pid by default', () => {
  it('passes --process-id of the active window when the caller omits it', async () => {
    h.exec = defaultExec(() => ({ elements: [{ name: '7', controlType: 'push button', bounds: { x: 1, y: 2, width: 3, height: 4 } }] }));
    const adapter = new LinuxAdapter();
    await adapter.init();
    const hits = await adapter.findElements({ name: '7' });
    expect(hits).toHaveLength(1);
    const args = bridgeCalls()[0];
    expect(args.slice(0, 2)).toEqual(['--cmd', 'find']);
    expect(args).toContain('--process-id');
    expect(args[args.indexOf('--process-id') + 1]).toBe('4242');
  });

  it('an explicit processId wins', async () => {
    const adapter = new LinuxAdapter();
    await adapter.init();
    await adapter.findElements({ name: '7', processId: 99 });
    const args = bridgeCalls()[0];
    expect(args[args.indexOf('--process-id') + 1]).toBe('99');
  });

  it('controlType filters on the NORMALIZED role (find "Button" matches "push button")', async () => {
    h.exec = defaultExec(() => ({ elements: [
      { name: '7', controlType: 'push button', bounds: { x: 1, y: 2, width: 3, height: 4 } },
      { name: '7', controlType: 'label', bounds: { x: 1, y: 2, width: 3, height: 4 } },
    ] }));
    const adapter = new LinuxAdapter();
    await adapter.init();
    const hits = await adapter.findElements({ name: '7', controlType: 'Button' });
    expect(hits).toHaveLength(1);
    expect(hits[0].controlType).toBe('Button');
  });
});

// ─── L8 ───────────────────────────────────────────────────────────────────────
describe('L8 — invokeElement drives the AT-SPI bridge', () => {
  it('sends --cmd invoke with action/name/pid and reports success + bounds', async () => {
    h.exec = defaultExec(() => ({ success: true, action: 'click', bounds: { x: 10, y: 20, width: 30, height: 40 } }));
    const adapter = new LinuxAdapter();
    await adapter.init();
    const res = await adapter.invokeElement({ name: '7', action: 'click' });
    expect(res.success).toBe(true);
    expect(res.bounds).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    const args = bridgeCalls()[0];
    expect(args.slice(0, 2)).toEqual(['--cmd', 'invoke']);
    expect(args[args.indexOf('--action') + 1]).toBe('click');
    expect(args[args.indexOf('--name') + 1]).toBe('7');
    expect(args[args.indexOf('--process-id') + 1]).toBe('4242');
  });

  it('passes --value for set-value and surfaces value / toggleState in data', async () => {
    let reply: unknown = { success: true, action: 'set-value' };
    h.exec = defaultExec(() => reply);
    const adapter = new LinuxAdapter();
    await adapter.init();
    await adapter.invokeElement({ name: 'Name', action: 'set-value', value: 'Ada' });
    let args = bridgeCalls()[0];
    expect(args[args.indexOf('--value') + 1]).toBe('Ada');

    reply = { success: true, action: 'get-value', value: '42' };
    const got = await adapter.invokeElement({ name: 'Display', action: 'get-value' });
    expect(got.data).toEqual({ value: '42' });

    reply = { success: true, action: 'toggle', toggleState: 'On' };
    const tog = await adapter.invokeElement({ name: 'Bold', action: 'toggle' });
    expect(tog.data).toEqual({ toggleState: 'On' });
    args = bridgeCalls()[2];
    expect(args[args.indexOf('--action') + 1]).toBe('toggle');
  });

  it('a failed action still returns bounds so callers can coordinate-fallback', async () => {
    h.exec = defaultExec(() => ({ success: false, error: 'no Action interface', bounds: { x: 5, y: 6, width: 7, height: 8 } }));
    const adapter = new LinuxAdapter();
    await adapter.init();
    const res = await adapter.invokeElement({ name: 'canvas', action: 'click' });
    expect(res.success).toBe(false);
    expect(res.bounds).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });

  it('is a no-op {success:false} when the bridge is unavailable', async () => {
    const adapter = new LinuxAdapter(); // no init() → atspi not probed
    const res = await adapter.invokeElement({ name: '7', action: 'click' });
    expect(res).toEqual({ success: false });
    expect(bridgeCalls()).toHaveLength(0);
  });
});

// ─── L9 ───────────────────────────────────────────────────────────────────────
describe('L9 — AT-SPI roles normalize to the shared vocabulary; bad bounds are flagged', () => {
  const INT_MIN = -2147483648;
  const raw = [
    { name: 'Alpha', controlType: 'push button', bounds: { x: 10, y: 10, width: 40, height: 20 } },
    { name: 'Bold', controlType: 'toggle button', bounds: { x: 10, y: 10, width: 40, height: 20 } },
    { name: 'Agree', controlType: 'check box', bounds: { x: 10, y: 10, width: 40, height: 20 } },
    { name: 'Size', controlType: 'combo box', bounds: { x: 10, y: 10, width: 40, height: 20 } },
    { name: 'Name', controlType: 'text', bounds: { x: 10, y: 10, width: 40, height: 20 } },
    { name: 'Open', controlType: 'menu item', bounds: { x: 10, y: 10, width: 40, height: 20 } },
    { name: 'Row 1', controlType: 'list item', bounds: { x: 10, y: 10, width: 40, height: 20 } },
    { name: 'Secret code: 4729', controlType: 'label', bounds: { x: 10, y: 10, width: 40, height: 20 } },
    { name: 'Calculator', controlType: 'frame', bounds: { x: 0, y: 0, width: 800, height: 600 } },
    { name: 'Password', controlType: 'password text', bounds: { x: 10, y: 10, width: 40, height: 20 } },
    { name: 'Help', controlType: 'link', bounds: { x: 10, y: 10, width: 40, height: 20 } },
    { name: 'Tab 1', controlType: 'page tab', bounds: { x: 10, y: 10, width: 40, height: 20 } },
    { name: 'Hidden', controlType: 'push button', bounds: { x: INT_MIN, y: INT_MIN, width: 40, height: 20 } },
    { name: 'Rel', controlType: 'push button', bounds: { x: 10, y: 20, width: 40, height: 20 }, coordType: 'window', processId: 4242 },
    { name: 'Unknown-state', controlType: 'push button', bounds: { x: 1, y: 1, width: 1, height: 1 }, enabled: null },
  ];

  async function tree() {
    h.exec = defaultExec(() => ({ elements: raw }));
    const adapter = new LinuxAdapter();
    await adapter.init();
    const els = await adapter.getUiTree(4242);
    const by = (name: string) => els.find(e => e.name === name)!;
    return by;
  }

  it('maps AT-SPI role names to the UIA-style names compile_ui / find_button expect', async () => {
    const by = await tree();
    const expected: Record<string, [string, string]> = {
      'Alpha': ['Button', 'button'],
      'Bold': ['Button', 'button'],
      'Agree': ['CheckBox', 'checkbox'],
      'Size': ['ComboBox', 'input'],
      'Name': ['Edit', 'input'],
      'Open': ['MenuItem', 'button'],
      'Row 1': ['ListItem', 'listitem'],
      'Secret code: 4729': ['Text', 'text'],
      'Password': ['Edit', 'input'],
      'Help': ['Hyperlink', 'link'],
      'Tab 1': ['TabItem', 'tab'],
    };
    for (const [name, [ct, role]] of Object.entries(expected)) {
      expect(by(name).controlType, name).toBe(ct);
      expect(normalizeRole(by(name).controlType), name).toBe(role);
    }
    expect(by('Calculator').controlType).toBe('Window');
    // The raw AT-SPI role survives as subrole; password fields are flagged secure.
    expect(by('Alpha').subrole).toBe('push button');
    expect(by('Password').secure).toBe(true);
    expect(by('Alpha').secure).toBeFalsy();
  });

  it('INT_MIN extents are reported as offscreen with zero bounds', async () => {
    const by = await tree();
    expect(by('Hidden').offscreen).toBe(true);
    expect(by('Hidden').bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(by('Alpha').offscreen).toBeFalsy();
  });

  it('window-relative extents are offset by the owning window origin', async () => {
    const by = await tree();
    // wmctrl says pid 4242's window sits at (100,200)
    expect(by('Rel').bounds).toEqual({ x: 110, y: 220, width: 40, height: 20 });
  });

  it('an unknown enabled state is passed through as undefined, not disabled', async () => {
    const by = await tree();
    expect(by('Unknown-state').enabled).toBeUndefined();
    expect(by('Unknown-state').disabled).toBeUndefined();
  });
});

// ─── Blind-mode batch (live blind test, Ubuntu 24.04) ─────────────────────────
describe('B4/B5 — a11y calls are scoped to the foreground window, even without a pid', () => {
  it('getFocusedElement passes the active window pid to the bridge', async () => {
    h.exec = defaultExec(() => ({ element: { name: 'x', controlType: 'text', bounds: { x: 1, y: 2, width: 3, height: 4 }, processId: 4242 } }));
    const adapter = new LinuxAdapter();
    await adapter.init();
    const el = await adapter.getFocusedElement();
    expect(el?.processId).toBe(4242);
    const args = bridgeCalls()[0];
    expect(args.slice(0, 2)).toEqual(['--cmd', 'focused']);
    expect(args[args.indexOf('--process-id') + 1]).toBe('4242');
  });

  it('a window without _NET_WM_PID (wmctrl pid 0) is scoped by its title, not left to a guess', async () => {
    const base = defaultExec();
    h.exec = (cmd, args) => {
      if (cmd === 'wmctrl' && args[0] === '-l') {
        return { stdout: WMCTRL + '0x03c00005  0 0   10 10 300 200  box xcalc\n' };
      }
      if (cmd === 'xdotool' && args[0] === 'getactivewindow') return { stdout: String(0x3c00005) + '\n' };
      return base(cmd, args);
    };
    const adapter = new LinuxAdapter();
    await adapter.init();
    await adapter.getUiTree();
    await adapter.findElements({ name: '7' });
    await adapter.invokeElement({ name: '7', action: 'click' });
    await adapter.getFocusedElement();
    for (const args of bridgeCalls()) {
      expect(args).not.toContain('--process-id');
      expect(args[args.indexOf('--window-title') + 1]).toBe('xcalc');
    }
    expect(bridgeCalls()).toHaveLength(4);
  });
});

describe('B1 — a hidden-element invoke failure says why', () => {
  it('surfaces the bridge error in data and reports no bounds', async () => {
    h.exec = defaultExec(() => ({ success: false, notVisible: true, error: "element 'Save' exists but is not visible on screen" }));
    const adapter = new LinuxAdapter();
    await adapter.init();
    const res = await adapter.invokeElement({ name: 'Save', action: 'click' });
    expect(res.success).toBe(false);
    expect(res.bounds).toBeUndefined();
    expect(String(res.data?.error)).toMatch(/not visible/);
  });
});

describe('B6 — open_app resolves desktop names and never claims a launch it did not see', () => {
  const MOUSEPAD_ONLY = '0x03c00004  0 5555   50 60 640 480  box Untitled - Mousepad\n';
  const CALC_WIN = '0x03c00009  0 777   100 200 360 499  box Calculator\n';

  function setup(opts: { windowAppears: boolean; alive: boolean }) {
    process.env.XDG_DATA_HOME = '/home/t/.local/share';
    process.env.XDG_DATA_DIRS = '/usr/share';
    h.files['/usr/share/applications/org.gnome.Calculator.desktop'] =
      '[Desktop Entry]\nName=Calculator\nExec=gnome-calculator %U\nType=Application\n\n[Desktop Action x]\nName=Other\nExec=nope\n';
    h.files['/usr/share/applications/org.xfce.mousepad.desktop'] =
      '[Desktop Entry]\nName=Mousepad\nExec=mousepad %U\nType=Application\n';
    let spawned = false;
    const base = defaultExec();
    h.exec = (cmd, args) => {
      if (cmd === 'wmctrl' && args[0] === '-l') {
        return { stdout: MOUSEPAD_ONLY + (spawned && opts.windowAppears ? CALC_WIN : '') };
      }
      return base(cmd, args);
    };
    const spawns: Array<{ cmd: string; args: string[] }> = [];
    h.spawn = (cmd: string, args: string[]) => {
      spawns.push({ cmd, args });
      const proc = Object.assign(new EventEmitter(), { pid: undefined as number | undefined, unref: () => {} });
      if (cmd === 'gnome-calculator') { proc.pid = 777; spawned = true; }
      else setImmediate(() => proc.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      return proc;
    };
    vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 777 && opts.alive) return true;
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }) as typeof process.kill);
    return spawns;
  }
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  /** Advance the faked launch-poll clock until `p` settles (spawn steps use real setImmediate). */
  async function runOutLaunchPoll(p: Promise<unknown>) {
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 100 && !done; i++) {
      await vi.advanceTimersByTimeAsync(500);
      await new Promise(r => setImmediate(r));
    }
  }

  it('"calculator" launches the desktop entry\'s Exec (gnome-calculator) and returns its window', async () => {
    const spawns = setup({ windowAppears: true, alive: true });
    const adapter = new LinuxAdapter();
    const res = await adapter.launchApp('calculator');
    expect(spawns.map(s => s.cmd)).toEqual(['calculator', 'gnome-calculator']);
    expect(spawns[1].args).toEqual([]); // %U field code dropped
    expect(res).toMatchObject({ pid: 777, title: 'Calculator' });
  });

  it('an unknown bare name fails at once instead of xdg-open + an 8 s wait + "Launched"', async () => {
    const spawns = setup({ windowAppears: false, alive: false });
    const adapter = new LinuxAdapter();
    await expect(adapter.launchApp('nosuchapp')).rejects.toThrow(/nosuchapp/);
    expect(spawns.map(s => s.cmd)).toEqual(['nosuchapp']);
  });

  it('a process that exits without a window is a failure, not a launch', async () => {
    setup({ windowAppears: false, alive: false });
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const adapter = new LinuxAdapter();
    const p = adapter.launchApp('calculator');
    const settled = expect(p).rejects.toThrow(/no window/i);
    await runOutLaunchPoll(p);
    await settled;
  });

  it('a still-running process with no window yet returns its pid but no title', async () => {
    setup({ windowAppears: false, alive: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const adapter = new LinuxAdapter();
    const p = adapter.launchApp('calculator');
    await runOutLaunchPoll(p);
    const res = await p;
    expect(res).toEqual({ pid: 777 });
  });
});

describe('B7 — a GTK4 focused element gets the same window offset as the tree', () => {
  it('window-relative focused bounds are offset by the owning window origin', async () => {
    h.exec = defaultExec(() => ({ element: { name: '', controlType: 'text', coordType: 'window', processId: 4242, bounds: { x: 0, y: 165, width: 360, height: 42 } } }));
    const adapter = new LinuxAdapter();
    await adapter.init();
    const el = await adapter.getFocusedElement();
    // wmctrl says pid 4242's window sits at (100,200)
    expect(el?.bounds).toEqual({ x: 100, y: 365, width: 360, height: 42 });
  });
});

describe('R1 — window bounds are the client window\'s real position, not wmctrl\'s', () => {
  it('wmctrl adds the frame extents (openbox); xwininfo absolute origin wins', async () => {
    const base = defaultExec();
    h.exec = (cmd, args) => {
      if (cmd === 'xwininfo') {
        return { stdout: [
          'xwininfo: Window id: 0x1d8 (the root window) (has no name)',
          '     0x3c00001 "frame": ()  802x625+99+180  +99+180',
          '        0x3c00003 "gnome-calculator": ("x" "X")  800x600+1+20  +99+180',
          '     0x3c00004 "Untitled - Mousepad": ("m" "M")  640x480+0+0  +50+60',
          '',
        ].join('\n') };
      }
      return base(cmd, args);
    };
    const adapter = new LinuxAdapter();
    const wins = await adapter.listWindows();
    expect(wins[0].bounds).toEqual({ x: 99, y: 180, width: 800, height: 600 });
    expect(wins[1].bounds).toEqual({ x: 50, y: 60, width: 640, height: 480 });
  });

  it('without xwininfo output the wmctrl geometry is kept', async () => {
    const adapter = new LinuxAdapter();
    const wins = await adapter.listWindows();
    expect(wins[0].bounds).toEqual({ x: 100, y: 200, width: 800, height: 600 });
  });
});

describe('R2 — a pid-less window whose title another app also uses is never scoped to that app', () => {
  it('passes the other window\'s pid as --exclude-pids', async () => {
    const base = defaultExec();
    h.exec = (cmd, args) => {
      if (cmd === 'wmctrl' && args[0] === '-l') {
        // gnome-calculator (pid 4242) and xcalc (no pid) are both "Calculator".
        return { stdout: '0x03c00003  0 4242   100 200 800 600  box Calculator\n0x03c00005  0 0   2 40 226 394  box Calculator\n' };
      }
      if (cmd === 'xdotool' && args[0] === 'getactivewindow') return { stdout: String(0x3c00005) + '\n' };
      return base(cmd, args);
    };
    const adapter = new LinuxAdapter();
    await adapter.init();
    await adapter.findElements({ name: '=' });
    const args = bridgeCalls()[0];
    expect(args[args.indexOf('--window-title') + 1]).toBe('Calculator');
    expect(args[args.indexOf('--exclude-pids') + 1]).toBe('4242');
  });
});
