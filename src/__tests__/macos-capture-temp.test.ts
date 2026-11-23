/**
 * Security scan (2026-11): the macOS adapter had the screenshot helper write captures to
 * `/tmp/.clawdcursor-shot-<pid>-<time>.png` (and the permission probe to `/tmp/.clawdcursor-probe-<pid>.png`): a
 * predictable name in the shared /tmp, where another user of the Mac could read the screen or plant a symlink first. A
 * capture now goes to a random name in a fresh owner-only mkdtemp directory under the per-user temp dir, and the directory
 * is removed after the read, on failure too. (native-helper.ts's own captures were fixed the same way in 4e5388a.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const helper = vi.hoisted(() => ({
  seen: [] as { file: string; dirMode: number; dirExisted: boolean }[],
  fail: false,
  png: Buffer.alloc(0),
}));

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  Button: { LEFT: 0 },
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('child_process', async () => {
  const { promisify } = await import('util');
  const fs = await import('fs');
  const path = await import('path');
  /** The screenshot helper: writes a capture to the path it is given (`--fullscreen <path>`), noting where that was. */
  const capture = (file: string) => {
    const dir = path.dirname(file);
    helper.seen.push({ file, dirExisted: fs.existsSync(dir), dirMode: fs.existsSync(dir) ? fs.statSync(dir).mode & 0o777 : -1 });
    if (helper.fail) throw new Error('screenshot-helper failed');
    fs.writeFileSync(file, helper.png);
  };
  const execFile: any = vi.fn();
  execFile[promisify.custom] = async (_file: string, args: string[]) => { capture(args[1]); return { stdout: '', stderr: '' }; };
  const spawn = vi.fn((_file: string, args: string[]) => {
    const proc = Object.assign(new EventEmitter(), { kill: vi.fn() });
    setImmediate(() => { let code = 0; try { capture(args[1]); } catch { code = 1; } proc.emit('close', code); });
    return proc;
  });
  return { execFile, spawn };
});

import sharp from 'sharp';
import { MacOSAdapter } from '../platform/macos';

const UUID_PNG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;

function adapter(): MacOSAdapter {
  const mac = new MacOSAdapter();
  // probeScreenRecording checks that the helper exists before it runs it.
  const fakeHelper = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fake-helper-')), 'screenshot-helper');
  fs.writeFileSync(fakeHelper, '');
  (mac as unknown as { screenshotHelperPath: string }).screenshotHelperPath = fakeHelper;
  return mac;
}
const probe = (mac: MacOSAdapter) => (mac as unknown as { probeScreenRecording(): Promise<boolean> }).probeScreenRecording();

/** A capture path is a random name in a fresh owner-only directory of its own under os.tmpdir(), gone after the call. */
function expectPrivateAndRemoved(seen: { file: string; dirMode: number; dirExisted: boolean }): void {
  const dir = path.dirname(seen.file);
  expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(dir)).toMatch(/^clawdcursor-.{6}$/);
  expect(path.basename(seen.file)).toMatch(UUID_PNG);
  expect(seen.file).not.toContain(String(process.pid));
  expect(seen.dirExisted).toBe(true);
  if (process.platform !== 'win32') expect(seen.dirMode).toBe(0o700);
  expect(fs.existsSync(dir), `${dir} was left behind`).toBe(false);
}

beforeEach(async () => {
  helper.seen = [];
  helper.fail = false;
  helper.png = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
});

describe('macOS captures are written where only this user can read them', () => {
  it('screenshot(): a random name in a fresh owner-only directory, removed after the read', async () => {
    const r = await adapter().screenshot();
    expect([r.width, r.height]).toEqual([40, 20]);
    expect(helper.seen).toHaveLength(1);
    expectPrivateAndRemoved(helper.seen[0]);
  });

  it('two captures never share a path', async () => {
    const mac = adapter();
    await mac.screenshot();
    await mac.screenshot();
    expect(helper.seen[0].file).not.toBe(helper.seen[1].file);
    expect(path.dirname(helper.seen[0].file)).not.toBe(path.dirname(helper.seen[1].file));
  });

  it('screenshot(): the directory is removed when the helper fails too', async () => {
    helper.fail = true;
    await expect(adapter().screenshot()).rejects.toThrow(/screenshot-helper failed/);
    expectPrivateAndRemoved(helper.seen[0]);
  });

  it('the Screen Recording probe: the same, granted or not', async () => {
    helper.png = Buffer.alloc(200, 1);   // the probe only checks that a capture of some size was written
    expect(await probe(adapter())).toBe(true);
    expectPrivateAndRemoved(helper.seen[0]);
    helper.fail = true;
    expect(await probe(adapter())).toBe(false);
    expectPrivateAndRemoved(helper.seen[1]);
  });
});
