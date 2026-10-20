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
import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process';
import { getPackageRoot } from '../paths';
import { macAxBinary } from '../platform/mac-ocr-binary';
import { runAppleScript, MacKeyboardGuard } from '../platform/mac-keyboard';

const isMac = process.platform === 'darwin';
const fixturesEnabled = process.env.CLAWD_LIVE_MAC_TESTS === '1';
const HELPER_SRC = path.join(getPackageRoot(), 'scripts', 'mac', 'ax-helper.swift');
const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'ax-fixture-app.swift');

let tmp: string;
let helper: string | null = null;

/** Run the helper; it always exits 0 with one JSON object, even for logical failures. */
function run(args: string[], timeoutMs = 30_000, stdin?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = execFile(helper!, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`not JSON: ${String(stdout).slice(0, 200)}`)); }
    });
    if (stdin !== undefined) child.stdin!.end(stdin);
  });
}

// Built once for the whole file and removed after the last group has run.
beforeAll(async () => {
  if (!isMac) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-axlive-'));
  macAxBinary.reset();
  helper = await macAxBinary.compile(HELPER_SRC, path.join(tmp, 'bin'));
}, 240_000);
afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

/** Seconds since the last keyboard / mouse input (HID idle time). */
function idleSeconds(): number {
  try {
    const out = execFileSync('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8' });
    const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out);
    return m ? Number(m[1]) / 1e9 : Infinity;
  } catch { return Infinity; }
}

/** The tests that start an ordinary app (it takes the keyboard focus) wait until nobody is at the machine. */
async function waitUntilIdle(minIdleSeconds = 45, maxWaitMs = 20 * 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (idleSeconds() < minIdleSeconds) {
    if (Date.now() - t0 > maxWaitMs) return false;
    await new Promise(r => setTimeout(r, 5_000));
  }
  return true;
}

describe.skipIf(!isMac)('ax-helper — protocol (macOS)', () => {
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
  let fixtureBin = '';
  const extra: ChildProcess[] = [];

  /** Start the fixture app; resolves its pid once both windows are up. */
  async function startFixture(mode: 'normal' | 'slow' | 'zoomed' | 'minimized' = 'normal', bin = fixtureBin, env: Record<string, string> = {}): Promise<{ proc: ChildProcess; pid: number }> {
    const proc = spawn(bin, [], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, AXFIXTURE_MODE: mode, ...env } });
    const p = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('fixture did not start')), 30_000);
      proc.stdout!.on('data', d => {
        const m = /READY (\d+)/.exec(String(d));
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
    });
    await new Promise(r => setTimeout(r, 600));   // let AppKit register the windows
    return { proc, pid: p };
  }

  beforeAll(async () => {
    if (!helper) return;
    const probe = await run(['windows']);
    usable = probe.ok === true;
    if (!usable) {
      console.warn(`[mac-ax-live] fixture tests skipped: ${probe.kind} — ${probe.error}`);
      return;
    }
    fixtureBin = path.join(tmp, 'ax-fixture');
    await new Promise<void>((resolve, reject) =>
      execFile('swiftc', ['-O', FIXTURE_SRC, '-o', fixtureBin], { timeout: 120_000 }, err => (err ? reject(err) : resolve())));
    const f = await startFixture('normal');
    fixture = f.proc;
    pid = f.pid;
  }, 300_000);

  afterAll(() => { fixture?.kill('SIGKILL'); for (const p of extra) p.kill('SIGKILL'); });

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
    expect(r.skipped).toEqual([]);          // every app was reached…
    expect(r.truncated).toBe(false);        // …so the list is complete
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
    expect(r).toMatchObject({ ok: true, success: false, refused: true });
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
    expect(r.refused).toBeUndefined();                     // it looked, and there was nothing: not a refusal
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

  it('a value that starts with "--" is a value, not the next flag', async (ctx) => {
    if (!usable) return ctx.skip();
    const text = '--- title: not a flag';
    const set = await run(['invoke', '--pid', String(pid), '--id', 'nameField', '--action', 'set-value', '--value', text]);
    expect(set).toMatchObject({ ok: true, success: true });
    const got = await run(['invoke', '--pid', String(pid), '--id', 'nameField', '--action', 'get-value']);
    expect(got.value).toBe(text);
  });

  it('a name that starts with "--" still filters (it used to turn find into an unfiltered dump)', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['find', '--pid', String(pid), '--name', '--no-such-control']);
    expect(r.ok).toBe(true);
    expect(r.elements).toEqual([]);
  });

  it('a press whose action runs a modal loop is reported as pending — it happened — not as a failure to click', async (ctx) => {
    if (!usable) return ctx.skip();
    // AXPress does not return until the modal ends; the SDK says kAXErrorCannotComplete there "does not
    // necessarily mean that the function has failed". Reporting a miss made callers click it again.
    const r = await run(['invoke', '--pid', String(pid), '--id', 'modalButton', '--action', 'click', '--ax-timeout-ms', '600']);
    expect(r).toMatchObject({ ok: true, success: true, data: { pending: true } });
    await new Promise(res => setTimeout(res, 3_800));   // the fixture closes its own alert after 3 s
    const status = await run(['find', '--pid', String(pid), '--id', 'status']);
    expect(status.elements[0].value).toBe('modal: closed');
  });

  it('review 2: an app that HANGS while the press runs is a timeout — only a modal loop (which keeps answering) is "pending"', async (ctx) => {
    if (!usable) return ctx.skip();
    // The Hang button blocks the app's main thread for 4 s inside its action: AXPress returns kAXErrorCannotComplete after
    // the timeout exactly as for the modal button, but the app then answers nothing. Reported as "pending" the caller
    // would carry on against an app that is frozen; a second timeout on a cheap read tells the two apart.
    const r = await run(['invoke', '--pid', String(pid), '--id', 'hangButton', '--action', 'click', '--ax-timeout-ms', '600']);
    expect(r).toMatchObject({ ok: false, kind: 'timeout', acted: true });     // the one timeout that may have changed something
    expect(r.error).toMatch(/respond/i);
    expect(r.error).toMatch(/may or may not|might|unknown/i);       // the click itself did happen
    await new Promise(res => setTimeout(res, 4_500));               // the fixture is busy for 4 s
    const status = await run(['find', '--pid', String(pid), '--id', 'status', '--ax-timeout-ms', '3000']);
    expect(status.elements[0].value).toBe('hang: over');
  });

  it('find and invoke match the label the tree shows: a button named only by a child static text', async (ctx) => {
    if (!usable) return ctx.skip();
    const tree = await run(['tree', '--pid', String(pid)]);
    const peek = node(tree.tree, n => n.automationId === 'peekButton');
    expect(peek.name).toBe('Peeked');                       // the tree names it
    const found = await run(['find', '--pid', String(pid), '--name', 'Peeked']);
    expect(found.elements.map((e: any) => e.automationId)).toContain('peekButton');
    const pressed = await run(['invoke', '--pid', String(pid), '--name', 'Peeked', '--action', 'click']);
    expect(pressed).toMatchObject({ ok: true, success: true });
    await new Promise(res => setTimeout(res, 200));
    expect((await run(['find', '--pid', String(pid), '--id', 'status'])).elements[0].value).toBe('pressed: peekButton');
  });

  // A SwiftUI sidebar accepts AXPress on the label of a row and does nothing: the selection lives on the ROW. The helper said
  // "Invoked" (System Settings > General, live blind run of 2026-10-19) and the pane never changed.
  describe('a label inside a selectable row (a settings-style sidebar)', () => {
    let sidePid = 0;
    let sideProc: ChildProcess | null = null;
    beforeAll(async () => {
      if (!usable) return;
      const s = await startFixture('sidebar');
      sideProc = s.proc;
      extra.push(s.proc);
      sidePid = s.pid;
    }, 60_000);
    afterAll(() => { sideProc?.kill('SIGKILL'); });
    const status = async () => (await run(['invoke', '--pid', String(sidePid), '--id', 'status', '--action', 'get-value'])).value;
    const click = (id: string) => run(['invoke', '--pid', String(sidePid), '--id', id, '--action', 'click']);

    it('clicking the label selects the row it is in — success is claimed only because the selection really changed', async (ctx) => {
      if (!usable) return ctx.skip();
      expect(await status()).toBe('idle');
      const r = await click('sidebar.General');
      await new Promise(res => setTimeout(res, 400));
      expect(await status()).toBe('selected: General');
      expect(r).toMatchObject({ ok: true, success: true });
      // the same row again is still a success; another row moves the selection
      expect(await click('sidebar.General')).toMatchObject({ ok: true, success: true });
      expect(await click('sidebar.Displays')).toMatchObject({ ok: true, success: true });
      await new Promise(res => setTimeout(res, 400));
      expect(await status()).toBe('selected: Displays');
    });
  });

  describe('inside a live app, one hung subtree', () => {
    let slowPid = 0;
    let slowProc: ChildProcess | null = null;
    beforeAll(async () => {
      if (!usable) return;
      const s = await startFixture('slow');
      slowProc = s.proc;
      extra.push(s.proc);
      slowPid = s.pid;
    }, 60_000);
    // It is stalled by every read of its slow element: gone before the tests that expect a healthy desktop.
    afterAll(() => { slowProc?.kill('SIGKILL'); });

    it('every call to the app is bounded by --ax-timeout-ms, not only the first one', async (ctx) => {
      if (!usable) return ctx.skip();
      // AXUIElementSetMessagingTimeout on an app element covers that element only ("not … other accessibility
      // objects"): window and descendant calls kept the OS default (1.5 s here, 6 s on older macOS). The slow
      // view blocks the app for 3 s, so with a 100 ms limit on every call the walk is over in about a second;
      // with the default it waits the stall out.
      const t0 = Date.now();
      const r = await run(['tree', '--pid', String(slowPid), '--ax-timeout-ms', '100', '--timeout-ms', '9000']);
      expect(Date.now() - t0).toBeLessThan(1_800);
      expect(r.ok).toBe(true);
      expect(r.truncated).toBe(true);          // part of the window could not be read — and it says so
      expect(r.reason).toBe('unreadable');
    });

    it('a miss while part of the window did not answer is "not found in the readable part", not a timeout', async (ctx) => {
      if (!usable) return ctx.skip();
      await new Promise(res => setTimeout(res, 3_500));     // let the previous stall drain
      const t0 = Date.now();
      const r = await run(['find', '--pid', String(slowPid), '--name', 'no element is called this', '--ax-timeout-ms', '400', '--timeout-ms', '6000']);
      expect(Date.now() - t0).toBeLessThan(5_000);          // a quick miss, nowhere near the deadline
      expect(r).toMatchObject({ ok: false, kind: 'partial' });
      expect(r.error).toMatch(/not found in the readable part of the window \(\d+ elements? did not answer\)/);
      await new Promise(res => setTimeout(res, 3_500));     // and let ITS stall drain before the next test
    });

    it('refuses to press a partial match when part of the window could not be read', async (ctx) => {
      if (!usable) return ctx.skip();
      await new Promise(res => setTimeout(res, 3_500));     // let the previous stall drain
      // "Save" is a substring of "Save As…"; an exact "Save" could be hiding in the unreadable subtree.
      const r = await run(['invoke', '--pid', String(slowPid), '--name', 'Save', '--action', 'click', '--ax-timeout-ms', '700', '--timeout-ms', '4000']);
      expect(r.success === true).toBe(false);
      expect(r.kind === 'timeout' || r.ok === true).toBe(true);
      expect(r.acted).toBeUndefined();                     // it only searched: nothing was pressed
      if (r.kind === 'timeout') expect(String(r.error)).toMatch(/read_tree.*space:"screen"/);   // and it says what to do instead
      // wait the stall out (a long per-call limit, so the read queues behind it instead of failing), then look
      const status = await run(['find', '--pid', String(slowPid), '--id', 'status', '--ax-timeout-ms', '8000', '--timeout-ms', '15000']);
      expect(status.elements[0].value).toBe('idle');         // nothing was pressed
    });
  });

  describe('focusing a window (scripts/mac/focus-window.jxa)', () => {
    const FOCUS = path.join(getPackageRoot(), 'scripts', 'mac', 'focus-window.jxa');
    const focus = (pid: number, title: string) => new Promise<any>((resolve, reject) =>
      execFile('osascript', ['-l', 'JavaScript', FOCUS, '--', '-processId', String(pid), '-title', title], { timeout: 60_000 }, (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`not JSON: ${stdout}`)); }
      }));
    // (vitest's default test timeout would cut the wait for an idle machine short)
    const windowB = async (p: number) => (await run(['windows'])).windows.find((w: any) => w.processId === p && w.title === 'Fixture B');

    it('a zoomed window stays exactly as large as it was', async (ctx) => {
      if (!usable) return ctx.skip();
      if (!await waitUntilIdle()) return ctx.skip();          // an ordinary app takes the keyboard focus: not while someone is typing
      const z = await startFixture('zoomed');
      extra.push(z.proc);
      try {
        await new Promise(res => setTimeout(res, 800));      // the zoom animation
        const before = await windowB(z.pid);
        expect(before.bounds.width).toBeGreaterThan(900);    // it really is zoomed (the window was 440 wide)
        const r = await focus(z.pid, 'Fixture B');
        expect(r.success).toBe(true);
        const after = await windowB(z.pid);
        expect(after.bounds).toEqual(before.bounds);
        expect(after.isMinimized).toBe(false);
      } finally { z.proc.kill('SIGKILL'); }
    }, 25 * 60_000);

    it('a minimized window is brought back at the size it had', async (ctx) => {
      if (!usable) return ctx.skip();
      if (!await waitUntilIdle()) return ctx.skip();
      const m = await startFixture('minimized');
      extra.push(m.proc);
      try {
        await new Promise(res => setTimeout(res, 1_200));    // the minimize animation
        const before = await windowB(m.pid);
        expect(before.isMinimized).toBe(true);
        const r = await focus(m.pid, 'Fixture B');
        expect(r.success).toBe(true);
        await new Promise(res => setTimeout(res, 1_200));
        const after = await windowB(m.pid);
        expect(after.isMinimized).toBe(false);
        expect(after.bounds.width).toBe(before.bounds.width);
        expect(after.bounds.height).toBe(before.bounds.height);
      } finally { m.proc.kill('SIGKILL'); }
    }, 25 * 60_000);
  });

  // Two processes of ONE app — the user's Chrome and the agent's own are exactly that. System Events names an app's windows by
  // process NAME, so focus-window.jxa raised (or failed to find) the first process's windows whatever pid it was given. The
  // helper's focus command talks to the process it was given.
  describe('focusing a window by pid, with two processes of the same app (the helper\'s focus command)', () => {
    let twinBin = '';
    beforeAll(() => {
      if (!fixtureBin) return;
      // The fixture again, inside a bundle: both instances then carry one name and one bundle id, like two Chromes.
      const app = path.join(tmp, 'AxTwin.app', 'Contents');
      fs.mkdirSync(path.join(app, 'MacOS'), { recursive: true });
      twinBin = path.join(app, 'MacOS', 'ax-twin');
      fs.copyFileSync(fixtureBin, twinBin);
      fs.chmodSync(twinBin, 0o755);
      fs.writeFileSync(path.join(app, 'Info.plist'),
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>ax-twin</string>' +
        '<key>CFBundleIdentifier</key><string>dev.clawdcursor.test.axtwin</string><key>CFBundleName</key><string>AxTwin</string>' +
        '<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>');
    });
    const frontPid = async (): Promise<number | undefined> => (await run(['frontmost'])).frontmost?.processId;
    const raiseBySystemEvents = (pid: number) => new Promise<void>(resolve => execFile('osascript', ['-e',
      `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`], () => resolve()));

    it('the process asked for comes to the front — not the first one of that name — and a window it does not have is an error', async (ctx) => {
      if (!usable || !twinBin) return ctx.skip();
      if (!await waitUntilIdle()) return ctx.skip();
      const a = await startFixture('normal', twinBin);
      extra.push(a.proc);
      const b = await startFixture('normal', twinBin);
      extra.push(b.proc);
      try {
        await new Promise(res => setTimeout(res, 800));
        await raiseBySystemEvents(a.pid);
        await new Promise(res => setTimeout(res, 800));
        if (await frontPid() !== a.pid) { console.warn('[mac-ax-live] not focusing: the first twin is not frontmost'); return ctx.skip(); }

        const toB = await run(['focus', '--pid', String(b.pid)]);
        expect(toB).toMatchObject({ ok: true, success: true, processId: b.pid });
        expect(await frontPid()).toBe(b.pid);

        // back to the first, by title: the title is looked for among THAT process's windows only
        const toA = await run(['focus', '--pid', String(a.pid), '--args-stdin', '1'], 30_000, JSON.stringify({ title: 'fixture a' }));
        expect(toA).toMatchObject({ ok: true, success: true, processId: a.pid, title: 'Fixture A' });
        expect(await frontPid()).toBe(a.pid);

        const none = await run(['focus', '--pid', String(b.pid), '--args-stdin', '1'], 30_000, JSON.stringify({ title: 'No such window' }));
        expect(none).toMatchObject({ ok: false, kind: 'failed' });
        expect(none.error).toMatch(/no window/i);
        expect(await frontPid()).toBe(a.pid);                   // nothing was raised for the miss
      } finally { a.proc.kill('SIGKILL'); b.proc.kill('SIGKILL'); }
    }, 25 * 60_000);

    it('a pid that does not exist is a failed reply that says so', async (ctx) => {
      if (!usable) return ctx.skip();
      const r = await run(['focus', '--pid', '999999']);
      expect(r).toMatchObject({ ok: false, kind: 'failed' });
      expect(r.error).toMatch(/no such process/);
    });
  });

  describe('the keyboard guard against a real dialog (MacKeyboardGuard on live NSWorkspace + AX data; no key is sent)', () => {
    // The guard is the same class MacOSAdapter and NativeDesktop (the MCP route) ask; here it reads the helper's real `frontmost`.
    // (tests/vitest.setup.ts sets CLAWD_NO_MAC_AX=1 for every test - that switch turns the guard off, so turn it back on here.)
    const savedKillSwitch = process.env.CLAWD_NO_MAC_AX;
    beforeAll(() => { process.env.CLAWD_NO_MAC_AX = '0'; });
    afterAll(() => { if (savedKillSwitch === undefined) delete process.env.CLAWD_NO_MAC_AX; else process.env.CLAWD_NO_MAC_AX = savedKillSwitch; });
    const guard = () => new MacKeyboardGuard({
      frontmost: async () => { const r = await run(['frontmost']); return { locked: r.locked === true, app: r.frontmost ?? null }; },
    });
    /** Open the fixture's "Open modal" alert (it closes itself after 3 s) and wait until it is up. */
    async function withAlert(env: Record<string, string>, fn: (alertPid: number) => Promise<void>) {
      const f = await startFixture('normal', fixtureBin, env);
      extra.push(f.proc);
      try {
        void run(['invoke', '--pid', String(f.pid), '--id', 'modalButton', '--action', 'click', '--ax-timeout-ms', '500']);
        await new Promise(res => setTimeout(res, 900));
        await fn(f.pid);
      } finally { f.proc.kill('SIGKILL'); }
    }

    it('an app\'s own modal alert (AXDialog) is typed into, with a warning that names the app', async (ctx) => {
      if (!usable) return ctx.skip();
      await withAlert({}, async alertPid => {
        const front = (await run(['frontmost'])).frontmost;
        if (front?.processId !== alertPid) return ctx.skip();      // the alert did not take the front: nothing to judge
        const r = await guard().assert('Return');
        expect(r.warning).toMatch(/modal dialog/i);
        expect(r.warning).toContain(String(alertPid));
        // …but the launch plumbing does not type into it
        await expect(guard().assert(undefined, { strict: true })).rejects.toThrow(/modal dialog/i);
      });
    });

    it('a dialog with the system-dialog role is refused — Return, Tab and typing — while a bare Escape is let through', async (ctx) => {
      if (!usable) return ctx.skip();
      await withAlert({ AXFIXTURE_SYSTEMDIALOG: '1' }, async alertPid => {
        const front = (await run(['frontmost'])).frontmost;
        if (front?.processId !== alertPid) return ctx.skip();
        expect(front.windows.some((w: any) => w.subrole === 'AXSystemDialog')).toBe(true);
        const g = guard();
        await expect(g.assert('Return')).rejects.toThrow(/system dialog/i);
        await expect(g.assert('Tab')).rejects.toThrow(/system dialog/i);
        await expect(g.assert()).rejects.toThrow(/system dialog/i);               // typing
        await expect(g.assert('Escape')).resolves.toEqual({});
      });
    });

    it('with no dialog up, an ordinary app has the keyboard: nothing to say', async (ctx) => {
      if (!usable) return ctx.skip();
      await expect(guard().assert('Return')).resolves.toBeTruthy();
    });
  });

  describe('keystrokes whose program travels on stdin (src/platform/mac-keyboard.ts)', () => {
    it('System Events types what the program says into the focused field of the frontmost app — nothing is on argv', async (ctx) => {
      if (!usable) return ctx.skip();
      if (!await waitUntilIdle()) return ctx.skip();          // the fixture is an ordinary app here: it takes the keyboard focus
      const z = await startFixture('zoomed');
      extra.push(z.proc);
      try {
        await new Promise(res => setTimeout(res, 1_500));    // the zoom animation, and the app coming to the front
        // Bring the fixture to the front (an app started from a background process is not necessarily activated)…
        await new Promise<void>(resolve => execFile('osascript', ['-e',
          `tell application "System Events" to set frontmost of (first process whose unix id is ${z.pid}) to true`], () => resolve()));
        await new Promise(res => setTimeout(res, 800));
        // …and type ONLY if it really is frontmost now: keystrokes go to whatever is, and that must never be the user's own app.
        const front = (await run(['frontmost'])).frontmost;
        if (front?.processId !== z.pid) { console.warn(`[mac-ax-live] not typing: the fixture is not frontmost (${front?.name})`); return ctx.skip(); }
        await run(['invoke', '--pid', String(z.pid), '--id', 'nameField', '--action', 'set-value', '--args-stdin', '1'], 30_000, JSON.stringify({ value: '' }));
        expect(await run(['invoke', '--pid', String(z.pid), '--id', 'nameField', '--action', 'focus'])).toMatchObject({ ok: true, success: true });
        await new Promise(res => setTimeout(res, 300));
        // (ASCII on purpose: System Events' `keystroke` types "a" for every non-ASCII character on macOS 26.5, whether the
        // program arrives via -e or stdin - measured side by side. type_text pastes, so it is unaffected.)
        const typed = 'stdin "quoted" \\ 123';
        const escaped = typed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        await runAppleScript(`tell application "System Events" to keystroke "${escaped}"`, 10_000);
        await new Promise(res => setTimeout(res, 500));
        const got = await run(['invoke', '--pid', String(z.pid), '--id', 'nameField', '--action', 'get-value']);
        expect(got.value).toBe(typed);
      } finally { z.proc.kill('SIGKILL'); }
    }, 25 * 60_000);

    it('#242: the helper types text outside ASCII as itself (keystroke typed "a" for each such character)', async (ctx) => {
      if (!usable) return ctx.skip();
      if (!await waitUntilIdle()) return ctx.skip();
      const z = await startFixture('zoomed');
      extra.push(z.proc);
      try {
        await new Promise(res => setTimeout(res, 1_500));
        await new Promise<void>(resolve => execFile('osascript', ['-e',
          `tell application "System Events" to set frontmost of (first process whose unix id is ${z.pid}) to true`], () => resolve()));
        await new Promise(res => setTimeout(res, 800));
        // Type ONLY if the fixture really is frontmost: key events go to whatever is.
        const front = (await run(['frontmost'])).frontmost;
        if (front?.processId !== z.pid) { console.warn(`[mac-ax-live] not typing: the fixture is not frontmost (${front?.name})`); return ctx.skip(); }
        await run(['invoke', '--pid', String(z.pid), '--id', 'nameField', '--action', 'set-value', '--args-stdin', '1'], 30_000, JSON.stringify({ value: '' }));
        expect(await run(['invoke', '--pid', String(z.pid), '--id', 'nameField', '--action', 'focus'])).toMatchObject({ ok: true, success: true });
        await new Promise(res => setTimeout(res, 300));
        const typed = 'café 日本語 ñ ü 😀 "q" \\';
        expect(await run(['type', '--args-stdin', '1'], 30_000, JSON.stringify({ text: typed }))).toMatchObject({ ok: true, typed: [...typed].length });
        await new Promise(res => setTimeout(res, 500));
        const got = await run(['invoke', '--pid', String(z.pid), '--id', 'nameField', '--action', 'get-value']);
        expect(got.value).toBe(typed);
      } finally { z.proc.kill('SIGKILL'); }
    }, 25 * 60_000);

    it('#242: a type that runs out of time says whether any of its text was typed — a retry after "acted" would type it twice', async (ctx) => {
      if (!usable) return ctx.skip();
      if (!await waitUntilIdle()) return ctx.skip();
      const z = await startFixture('zoomed');
      extra.push(z.proc);
      try {
        await new Promise(res => setTimeout(res, 1_500));
        await new Promise<void>(resolve => execFile('osascript', ['-e',
          `tell application "System Events" to set frontmost of (first process whose unix id is ${z.pid}) to true`], () => resolve()));
        await new Promise(res => setTimeout(res, 800));
        // Type ONLY if the fixture really is frontmost: key events go to whatever is.
        const front = (await run(['frontmost'])).frontmost;
        if (front?.processId !== z.pid) { console.warn(`[mac-ax-live] not typing: the fixture is not frontmost (${front?.name})`); return ctx.skip(); }
        const field = async (): Promise<string> => (await run(['invoke', '--pid', String(z.pid), '--id', 'nameField', '--action', 'get-value'])).value;
        const clear = async () => {
          await run(['invoke', '--pid', String(z.pid), '--id', 'nameField', '--action', 'set-value', '--args-stdin', '1'], 30_000, JSON.stringify({ value: '' }));
          await run(['invoke', '--pid', String(z.pid), '--id', 'nameField', '--action', 'focus']);
          await new Promise(res => setTimeout(res, 300));
        };

        // Out of time before the first key: nothing was typed, so retrying is safe and the reply must not say it may have happened.
        await clear();
        const none = await run(['type', '--args-stdin', '1', '--timeout-ms', '0'], 30_000, JSON.stringify({ text: 'abc' }));
        expect(none).toMatchObject({ ok: false, kind: 'timeout' });
        expect(none.acted).not.toBe(true);
        expect(none.error).toContain('typed 0 of 3');
        expect(await field()).toBe('');

        // Out of time part-way: some of the text IS in the target. The reply says so, and how much.
        await clear();
        const text = 'x'.repeat(4_000);
        const some = await run(['type', '--args-stdin', '1', '--timeout-ms', '600'], 30_000, JSON.stringify({ text }));
        await new Promise(res => setTimeout(res, 400));
        const typedSoFar = (await field()).length;
        expect(typedSoFar).toBeGreaterThan(0);
        expect(typedSoFar).toBeLessThan(text.length);
        expect(some).toMatchObject({ ok: false, kind: 'timeout', acted: true });
        expect(some.error).toContain(`typed ${typedSoFar} of ${text.length}`);
      } finally { z.proc.kill('SIGKILL'); }
    }, 25 * 60_000);
  });

  it('WebKit / Electron helper processes are not apps: a healthy desktop lists nothing as "not responding"', async (ctx) => {
    if (!usable) return ctx.skip();
    // "Safari Web Content", "Mail Networking", Electron renderers: XPC/helper processes that never finish
    // launching and never answer AX. Reading them cost 1.5 s each and added bogus "(not responding)" rows.
    const t0 = Date.now();
    const r = await run(['windows']);
    expect(r.unresponsive).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  // ─── Review of 9c164b0…7042d75 (nine findings) ───────────────────────────────

  it('review 1: running out of TIME is not a hung app — apps never reached are "skipped", the reply says truncated, nothing is "unresponsive"', async (ctx) => {
    if (!usable) return ctx.skip();
    // A 1 ms budget is over before the first app is read: every healthy app is merely not reached. They used to be
    // reported as unresponsive, which became bounds-0 "(not responding)" windows for perfectly healthy apps.
    const r = await run(['windows', '--timeout-ms', '1']);
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.unresponsive).toEqual([]);
    expect(r.skipped.some((s: any) => s.processId === pid)).toBe(true);
    const apps = await run(['apps', '--name', 'ax-fixture', '--timeout-ms', '1']);
    expect(apps.truncated).toBe(true);
    expect(apps.unresponsive).toEqual([]);
    expect(apps.skipped.some((s: any) => s.processId === pid)).toBe(true);
  });

  it('review 5: --id is EXACT — "savebutton" is not "saveButton" (find_element filters with === afterwards)', async (ctx) => {
    if (!usable) return ctx.skip();
    const status = async () => (await run(['find', '--pid', String(pid), '--id', 'status'])).elements[0].value;
    const before = await status();
    const exact = await run(['find', '--pid', String(pid), '--id', 'saveButton']);
    expect(exact.elements).toHaveLength(1);
    const wrongCase = await run(['find', '--pid', String(pid), '--id', 'savebutton']);
    expect(wrongCase.ok).toBe(true);
    expect(wrongCase.elements).toEqual([]);
    const press = await run(['invoke', '--pid', String(pid), '--id', 'savebutton', '--action', 'click']);
    expect(press).toMatchObject({ ok: true, success: false });
    expect(press.error).toMatch(/not found/i);
    expect(await status()).toBe(before);            // nothing was pressed
    // --name stays a case-insensitive substring match
    expect((await run(['find', '--pid', String(pid), '--name', 'SAVEBUT'])).elements.map((e: any) => e.automationId)).toContain('saveButton');
  });

  it('review 6: a role alone never presses — click at AXButton is refused and nothing was pressed', async (ctx) => {
    if (!usable) return ctx.skip();
    const status = async () => (await run(['find', '--pid', String(pid), '--id', 'status'])).elements[0].value;
    const before = await status();
    for (const action of ['click', 'toggle', 'select']) {
      const r = await run(['invoke', '--pid', String(pid), '--role', 'AXButton', '--action', action]);
      expect(r, action).toMatchObject({ ok: true, success: false, refused: true });
      expect(r.error).toMatch(/name or id/i);
    }
    expect(await status()).toBe(before);
  });

  it('review 6: a role that matches several elements is ambiguous for set-value — refused, with the candidates, nothing written', async (ctx) => {
    if (!usable) return ctx.skip();
    const value = async () => (await run(['invoke', '--pid', String(pid), '--id', 'nameField', '--action', 'get-value'])).value;
    const before = await value();
    const r = await run(['invoke', '--pid', String(pid), '--role', 'AXTextField', '--action', 'set-value', '--value', 'overwritten by mistake']);
    expect(r).toMatchObject({ ok: true, success: false, refused: true });
    expect(r.error).toMatch(/2 elements|matches 2/i);
    expect(r.error).toContain('nameField');
    expect(await value()).toBe(before);
  });

  it('review 6: a role that matches exactly ONE element still works without a name', async (ctx) => {
    if (!usable) return ctx.skip();
    const r = await run(['invoke', '--pid', String(pid), '--role', 'AXCheckBox', '--action', 'get-value']);
    expect(r).toMatchObject({ ok: true, success: true });
  });

  it('review 9: --args-stdin takes name, id and value from stdin — argv is readable by every process', async (ctx) => {
    if (!usable) return ctx.skip();
    const text = 'sent on stdin --and a flag-looking tail';
    const set = await run(['invoke', '--pid', String(pid), '--action', 'set-value', '--args-stdin', '1'], 30_000, JSON.stringify({ id: 'nameField', value: text }));
    expect(set).toMatchObject({ ok: true, success: true });
    const got = await run(['invoke', '--pid', String(pid), '--action', 'get-value', '--args-stdin', '1'], 30_000, JSON.stringify({ id: 'nameField' }));
    expect(got.value).toBe(text);
    const found = await run(['find', '--pid', String(pid), '--args-stdin', '1'], 30_000, JSON.stringify({ name: 'Save' }));
    expect(found.elements[0].automationId).toBe('saveButton');
    // empty string is a value: it clears the field
    await run(['invoke', '--pid', String(pid), '--action', 'set-value', '--args-stdin', '1'], 30_000, JSON.stringify({ id: 'nameField', value: '' }));
    expect((await run(['invoke', '--pid', String(pid), '--action', 'get-value', '--args-stdin', '1'], 30_000, JSON.stringify({ id: 'nameField' }))).value).toBe('');
  });

  it('review 9: unreadable stdin is a failed reply, not a hang or a crash', async (ctx) => {
    if (!usable) return ctx.skip();
    expect(await run(['find', '--pid', String(pid), '--args-stdin', '1'], 30_000, 'this is not json')).toMatchObject({ ok: false, kind: 'failed' });
    expect(await run(['find', '--pid', String(pid), '--args-stdin', '1'], 30_000, '')).toMatchObject({ ok: false, kind: 'failed' });
  });

  // ─── Review of 4ee6279 ───────────────────────────────────────────────────────

  it('review of 4ee6279 #7: a name of only spaces is no name — it cannot make a role-only click pass the guard', async (ctx) => {
    if (!usable) return ctx.skip();
    const status = async () => (await run(['find', '--pid', String(pid), '--id', 'status'])).elements[0].value;
    const before = await status();
    for (const blank of [' ', '   ', '\t']) {
      const viaArgv = await run(['invoke', '--pid', String(pid), '--role', 'AXButton', '--name', blank, '--action', 'click']);
      expect(viaArgv, `argv ${JSON.stringify(blank)}`).toMatchObject({ ok: true, success: false, refused: true });
      const viaStdin = await run(['invoke', '--pid', String(pid), '--role', 'AXButton', '--action', 'click', '--args-stdin', '1'], 30_000, JSON.stringify({ name: blank }));
      expect(viaStdin, `stdin ${JSON.stringify(blank)}`).toMatchObject({ ok: true, success: false, refused: true });
      expect(viaStdin.error).toMatch(/name or id/i);
    }
    expect(await status()).toBe(before);
  });

  it('review of 4ee6279 #8: ids are compared byte for byte — NFC "café" is not NFD "café"', async (ctx) => {
    if (!usable) return ctx.skip();
    // Swift\'s == calls canonically equivalent strings equal; the caller\'s === (find_element\'s own filter) does not.
    const nfc = 'caf\u00e9', nfd = 'cafe\u0301';
    expect((await run(['find', '--pid', String(pid), '--id', nfc])).elements).toHaveLength(1);
    expect((await run(['find', '--pid', String(pid), '--id', nfd])).elements).toEqual([]);
    const press = await run(['invoke', '--pid', String(pid), '--id', nfd, '--action', 'click']);
    expect(press).toMatchObject({ ok: true, success: false });
  });

  it('review 8: clawdcursor\'s own processes (clawd-overlay-<hash>) are never in the window list', async (ctx) => {
    if (!usable) return ctx.skip();
    const overlayBin = path.join(tmp, 'clawd-overlay-livetest');
    fs.copyFileSync(fixtureBin, overlayBin);
    fs.chmodSync(overlayBin, 0o755);
    const o = await startFixture('normal', overlayBin);
    extra.push(o.proc);
    try {
      // the process is up and readable by pid…
      expect((await run(['tree', '--pid', String(o.pid)])).ok).toBe(true);
      // …yet it is not an app to list (its windows are not something to drive)
      const w = await run(['windows']);
      expect(w.windows.some((x: any) => x.processId === o.pid)).toBe(false);
      expect(w.windows.some((x: any) => x.processId === pid)).toBe(true);            // the ordinary fixture still is
      expect((await run(['apps', '--name', 'clawd-overlay-livetest'])).apps).toEqual([]);
    } finally { o.proc.kill('SIGKILL'); }
  });

  // Last on purpose: it freezes the fixture.
  it('a hung app costs only its own timeout, is reported rather than dropped, and does not take the list down', async (ctx) => {
    if (!usable) return ctx.skip();
    fixture!.kill('SIGSTOP');
    try {
      const t0 = Date.now();
      const r = await run(['windows', '--ax-timeout-ms', '800']);
      expect(Date.now() - t0).toBeLessThan(3_500);
      expect(r.ok).toBe(true);
      expect(r.unresponsive.some((u: any) => u.processId === pid)).toBe(true);
      expect(Array.isArray(r.windows)).toBe(true);

      const tree = await run(['tree', '--pid', String(pid), '--ax-timeout-ms', '800']);
      expect(tree).toMatchObject({ ok: false, kind: 'timeout' });
      // not "no elements found" / "Element not found": the app did not answer
      expect(await run(['find', '--pid', String(pid), '--name', 'Save', '--ax-timeout-ms', '800'])).toMatchObject({ ok: false, kind: 'timeout' });
      expect(await run(['invoke', '--pid', String(pid), '--name', 'Save', '--action', 'click', '--ax-timeout-ms', '800'])).toMatchObject({ ok: false, kind: 'timeout' });
    } finally {
      fixture!.kill('SIGCONT');
    }
  });
});
