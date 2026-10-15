/**
 * scripts/mac/ax-helper.swift against the real macOS accessibility API.
 *
 * macOS only. The first group needs nothing but `swiftc`: the compile, the JSON
 * protocol, the lock-screen contract. The second group drives a throwaway AppKit
 * app with known accessibility data (src/__tests__/fixtures/ax-fixture-app.swift:
 * identifier-only buttons like SwiftUI's Calculator, a secure field, two windows)
 * and so needs an unlocked screen, the Accessibility permission, and
 * CLAWD_LIVE_MAC_TESTS=1 — it opens a window (without taking focus), so it is not
 * part of a plain `npm test`.
 *
 *   CLAWD_LIVE_MAC_TESTS=1 npx vitest run src/__tests__/mac-ax-live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { getPackageRoot } from '../paths';
import { macAxBinary } from '../platform/mac-ocr-binary';

const isMac = process.platform === 'darwin';
const fixturesEnabled = process.env.CLAWD_LIVE_MAC_TESTS === '1';
const HELPER_SRC = path.join(getPackageRoot(), 'scripts', 'mac', 'ax-helper.swift');
const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'ax-fixture-app.swift');

let tmp: string;
let helper: string | null = null;

/** Run the helper; it always exits 0 with one JSON object, even for logical failures. */
function run(args: string[], timeoutMs = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(helper!, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`not JSON: ${String(stdout).slice(0, 200)}`)); }
    });
  });
}

describe.skipIf(!isMac)('ax-helper — protocol (macOS)', () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-axlive-'));
    macAxBinary.reset();
    helper = await macAxBinary.compile(HELPER_SRC, path.join(tmp, 'bin'));
  }, 240_000);
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('compiles with swiftc', () => {
    expect(helper, 'swiftc could not build scripts/mac/ax-helper.swift').toBeTruthy();
  });

  it('frontmost: the app NSWorkspace calls frontmost, and whether the screen is locked', async () => {
    const r = await run(['frontmost']);
    expect(r.ok).toBe(true);
    expect(typeof r.locked).toBe('boolean');
    if (r.frontmost) {
      expect(typeof r.frontmost.name).toBe('string');
      expect(r.frontmost.processId).toBeGreaterThan(0);
      expect(['regular', 'accessory', 'prohibited']).toContain(r.frontmost.activationPolicy);
      expect(Array.isArray(r.frontmost.windows)).toBe(true);
    }
  });

  it('a locked screen is reported by every command that would read garbage (the AX tree behind it is empty shells)', async () => {
    const { locked } = await run(['frontmost']);
    if (!locked) return;   // only meaningful while the screen happens to be locked
    for (const args of [['windows'], ['active'], ['focused'], ['tree'], ['find', '--name', 'x'], ['invoke', '--name', 'x', '--action', 'click'], ['apps', '--name', 'Finder']]) {
      const r = await run(args);
      expect(r, args.join(' ')).toMatchObject({ ok: false, kind: 'locked' });
      expect(r.error).toMatch(/locked/i);
    }
  });

  it('an unknown command is a failed reply, not a crash', async () => {
    const r = await run(['frobnicate']);
    expect(r).toMatchObject({ ok: false, kind: 'failed' });
    expect(r.error).toMatch(/frobnicate|usage/i);
  });

  it('a pid that does not exist is a failed reply that says so', async () => {
    const lock = (await run(['frontmost'])).locked;
    const r = await run(['tree', '--pid', '2147483000']);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe(lock ? 'locked' : r.kind === 'permission' ? 'permission' : 'failed');
  });

  it('invoke with nothing to aim at refuses (it used to press an arbitrary element)', async () => {
    const lock = (await run(['frontmost'])).locked;
    if (lock) return;
    const r = await run(['invoke', '--action', 'click']);
    if (r.ok === false) expect(r.kind).toBe('permission');
    else expect(r).toMatchObject({ ok: true, success: false });
  });
});

// ─── Needs an unlocked screen + Accessibility permission ─────────────────────

describe.skipIf(!isMac || !fixturesEnabled)('ax-helper — against a fixture app (macOS, CLAWD_LIVE_MAC_TESTS=1)', () => {
  let fixture: ChildProcess | null = null;
  let pid = 0;
  let usable = false;

  beforeAll(async () => {
    tmp = tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cc-axlive-'));
    if (!helper) {
      macAxBinary.reset();
      helper = await macAxBinary.compile(HELPER_SRC, path.join(tmp, 'bin'));
    }
    const probe = await run(['windows']);
    usable = probe.ok === true;
    if (!usable) {
      console.warn(`[mac-ax-live] fixture tests skipped: ${probe.kind} — ${probe.error}`);
      return;
    }
    const bin = path.join(tmp, 'ax-fixture');
    await new Promise<void>((resolve, reject) =>
      execFile('swiftc', ['-O', FIXTURE_SRC, '-o', bin], { timeout: 120_000 }, err => (err ? reject(err) : resolve())));
    fixture = spawn(bin, [], { stdio: ['ignore', 'pipe', 'ignore'] });
    pid = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('fixture did not start')), 30_000);
      fixture!.stdout!.on('data', d => {
        const m = /READY (\d+)/.exec(String(d));
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
    });
    await new Promise(r => setTimeout(r, 600));   // let AppKit register both windows
  }, 300_000);

  afterAll(() => { fixture?.kill('SIGKILL'); });

  const node = (tree: any, pred: (n: any) => boolean): any => {
    if (!tree) return undefined;
    if (pred(tree)) return tree;
    for (const c of tree.children ?? []) { const hit = node(c, pred); if (hit) return hit; }
    return undefined;
  };

  it('windows: fast, and lists both fixture windows with sane geometry', async (ctx) => {
    if (!usable) return ctx.skip();
    const t0 = Date.now();
    const r = await run(['windows']);
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(r.ok).toBe(true);
    const mine = r.windows.filter((w: any) => w.processId === pid);
    expect(mine.map((w: any) => w.title).sort()).toEqual(['Fixture A', 'Fixture B']);
    for (const w of mine) {
      expect(w.bounds.width).toBeGreaterThan(300);
      expect(w.bounds.height).toBeGreaterThan(200);
      expect(w.isMinimized).toBe(false);
    }
  });

  it('apps --name: the process, its launch state and its readable windows', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['apps', '--name', 'ax-fixture']);
    expect(r.ok).toBe(true);
    const app = r.apps.find((a: any) => a.processId === pid);
    expect(app).toBeTruthy();
    expect(app.finishedLaunching).toBe(true);
    expect(app.windows.length).toBe(2);
  });

  it('B3: the tree is the app\'s MAIN window (B), not window 1 / the biggest (A)', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['tree', '--pid', String(pid)]);
    expect(r.ok).toBe(true);
    expect(r.tree.controlType).toBe('AXWindow');
    expect(r.tree.title ?? r.tree.name).toBe('Fixture B');
  });

  it('B9: a button that has only an AXIdentifier is in the tree with it', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['tree', '--pid', String(pid)]);
    const one = node(r.tree, n => n.automationId === 'One');
    expect(one).toBeTruthy();
    expect(one.controlType).toBe('AXButton');
    const save = node(r.tree, n => n.automationId === 'saveButton');
    expect(save.name).toBe('Save');
  });

  it('secure fields never leave the helper with their value', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['tree', '--pid', String(pid)]);
    const secret = node(r.tree, n => n.automationId === 'secretField');
    expect(secret.secure).toBe(true);
    expect(secret.value).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('hunter2');
    const plain = node(r.tree, n => n.automationId === 'nameField');
    expect(plain.value).toBe('hello world');
  });

  it('a tree capped by node count says so, with what it read', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['tree', '--pid', String(pid), '--max-nodes', '4']);
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.reason).toBe('nodes');
    expect(r.nodeCount).toBeLessThanOrEqual(4);
  });

  it('find --id: exactly the element with that AXIdentifier', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['find', '--pid', String(pid), '--id', 'One']);
    expect(r.ok).toBe(true);
    expect(r.elements).toHaveLength(1);
    expect(r.elements[0]).toMatchObject({ automationId: 'One', controlType: 'AXButton', processId: pid });
  });

  it('find --name matches the title, the description AND the identifier; the exact match comes first', async (ctx) => {
    if (!usable) return ctx.skip();
    const byTitle = await run(['find', '--pid', String(pid), '--name', 'save']);
    expect(byTitle.elements[0].automationId).toBe('saveButton');
    const byId = await run(['find', '--pid', String(pid), '--name', 'One']);   // invoke_element maps automationId → name
    expect(byId.elements.some((e: any) => e.automationId === 'One')).toBe(true);
  });

  it('find --role narrows to a role', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['find', '--pid', String(pid), '--role', 'AXTextField']);
    expect(r.elements.length).toBeGreaterThan(0);
    expect(r.elements.every((e: any) => /TextField/.test(e.controlType))).toBe(true);
  });

  it('B9 end to end: invoke an identifier-only button, and the app really received the press', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['invoke', '--pid', String(pid), '--id', 'One', '--action', 'click']);
    expect(r).toMatchObject({ ok: true, success: true });
    await new Promise(res => setTimeout(res, 200));
    const status = await run(['find', '--pid', String(pid), '--id', 'status']);
    expect(status.elements[0].value).toBe('pressed: One');
  });

  it('set-value changes a text field; get-value reads it back', async (ctx) => {
    if (!usable) return ctx.skip();
    const set = await run(['invoke', '--pid', String(pid), '--id', 'nameField', '--action', 'set-value', '--value', 'replaced text']);
    expect(set).toMatchObject({ ok: true, success: true });
    const got = await run(['invoke', '--pid', String(pid), '--id', 'nameField', '--action', 'get-value']);
    expect(got).toMatchObject({ ok: true, success: true, value: 'replaced text' });
  });

  it('get-value on a secure field is refused', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['invoke', '--pid', String(pid), '--id', 'secretField', '--action', 'get-value']);
    expect(r).toMatchObject({ ok: true, success: false });
    expect(JSON.stringify(r)).not.toContain('hunter2');
    expect(r.error).toMatch(/secure/i);
  });

  it('toggle presses a checkbox and reports the state it ended in', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['invoke', '--pid', String(pid), '--id', 'enableBox', '--action', 'toggle']);
    expect(r).toMatchObject({ ok: true, success: true });
    expect(['On', 'Off']).toContain(r.data.toggleState);
  });

  it('a miss is a plain {success:false} with the reason, not an error', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['invoke', '--pid', String(pid), '--id', 'doesNotExist', '--action', 'click']);
    expect(r).toMatchObject({ ok: true, success: false });
    expect(r.error).toMatch(/not found/i);
  });

  it('invoke refuses to act with nothing to aim at', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['invoke', '--pid', String(pid), '--action', 'click']);
    expect(r).toMatchObject({ ok: true, success: false });
  });

  it('focused: the focused control of the app, or null when nothing in it has focus', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['focused', '--pid', String(pid)]);
    expect(r.ok).toBe(true);
    if (r.focused) {
      expect(typeof r.focused.controlType).toBe('string');
      expect(r.focused.processId).toBe(pid);
    }
  });

  it('active: the frontmost app\'s window, in the WindowInfo shape', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['active']);
    expect(r.ok).toBe(true);
    if (r.active) {
      expect(r.active.processId).toBeGreaterThan(0);
      expect(typeof r.active.processName).toBe('string');
      expect(typeof r.active.bounds.width).toBe('number');
      expect(['AXFocusedWindow', 'AXMainWindow', 'AXWindows', 'none']).toContain(r.active.source);
    }
  });
});
