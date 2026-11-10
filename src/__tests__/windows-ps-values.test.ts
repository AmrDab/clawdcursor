/**
 * GHSA-9ppf-38v8-h97v: the Windows adapter never writes a caller's value into PowerShell source.
 * A title or app name crosses as $env:; a pid is written only when it is an integer (batch steps are unvalidated JSON).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('../platform/ps-runner', () => ({
  psRunner: { run: () => Promise.resolve(null), start: vi.fn(), stop: vi.fn() },
}));

type Call = { cmd: string; args: string[]; opts: { env?: NodeJS.ProcessEnv } };
const calls: Call[] = [];
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: Call['opts'], cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
    calls.push({ cmd, args, opts });
    cb(null, { stdout: 'ok', stderr: '' });
  },
  spawn: (cmd: string, args: string[], opts: Call['opts']) => {
    calls.push({ cmd, args, opts });
    return { unref: () => {}, on: () => {} };
  },
}));

import { WindowsAdapter } from '../platform/windows';
import { __setSystemRootForTests, powershellExe } from '../platform/ps-spawn';

// PowerShell is started by absolute path under %SystemRoot%: a stand-in SystemRoot makes that resolvable on any OS.
const isPs = (c: { cmd: string }) => c.cmd === powershellExe();
let root = '';

const EVIL = 'x’;Start-Process calc;’';

describe('WindowsAdapter — values reach PowerShell as data', () => {
  let adapter: WindowsAdapter;
  beforeEach(() => {
    calls.length = 0; adapter = new WindowsAdapter();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-sysroot-'));
    const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, '');
    __setSystemRootForTests(root);
  });
  afterEach(() => { __setSystemRootForTests(undefined); fs.rmSync(root, { recursive: true, force: true }); });

  it('a window title crosses as $env:CLAWD_PS_TITLE, not in the script', async () => {
    await adapter.setWindowState('maximize', { title: EVIL, processId: 42 });
    const ps = calls.find(isPs)!;
    expect(ps.args.join(' ')).not.toContain('calc');
    expect(ps.opts.env?.CLAWD_PS_TITLE).toBe(EVIL);
  });

  it('a pid that is not an integer is refused before any PowerShell runs', async () => {
    const pid = '1; Start-Process calc' as unknown as number;
    for (const state of ['maximize', 'close'] as const) {
      expect(await adapter.setWindowState(state, { processId: pid })).toBe(false);
    }
    expect(calls.filter(isPs)).toEqual([]);
  });

  it('an app name crosses as $env:CLAWD_PS_FILE, not in the script', async () => {
    vi.spyOn(adapter, 'listWindows').mockResolvedValue([]);
    vi.spyOn(adapter as never, 'findLaunchedWindow').mockResolvedValue({ title: 'x', pid: 1 } as never);
    vi.spyOn(adapter as never, 'foregroundLaunched').mockImplementation((r: unknown) => Promise.resolve(r) as never);
    await adapter.launchApp(EVIL, { url: 'https://example.com', alwaysNewInstance: true });
    const ps = calls.find(isPs)!;
    expect(ps.args.join(' ')).not.toContain('calc');
    expect(ps.opts.env).toMatchObject({ CLAWD_PS_FILE: EVIL, CLAWD_PS_ARGS: 'https://example.com' });
  });
});
