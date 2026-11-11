import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startFixtureServer, stationCode, renderLongread, WEB_PAGES, type FixtureServer } from '../lib/fixture-server';
import { evaluate, loadTasks } from '../lib/tasks';
import type { FixtureState } from '../lib/types';

vi.useRealTimers();

describe('the fixture server', () => {
  let server: FixtureServer;
  beforeAll(async () => { server = await startFixtureServer(); });
  afterAll(async () => { await server.close(); });

  const post = (run: string, body: unknown) => fetch(`http://127.0.0.1:${server.port}/api/state?run=${run}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('listens on 127.0.0.1 only and serves every page with the recorder', async () => {
    expect(server.url('form', 'r1')).toBe(`http://127.0.0.1:${server.port}/form.html?run=r1`);
    for (const page of WEB_PAGES) {
      const res = await fetch(server.url(page, 'r1'));
      expect(res.status, page).toBe(200);
      expect(await res.text(), page).toContain('<script src="/bench.js"></script>');
    }
    expect((await fetch(`http://127.0.0.1:${server.port}/bench.js`)).status).toBe(200);
  });

  it('serves nothing else', async () => {
    for (const p of ['/', '/../package.json', '/form.html.bak', '/api/other']) {
      expect((await fetch(`http://127.0.0.1:${server.port}${p}`)).status, p).toBe(404);
    }
  });

  it('puts the task query in the page URL', () => {
    expect(server.url('canvas', 'r2', { mode: 'targets' })).toContain('/canvas.html?run=r2&mode=targets');
  });

  it('records what a page posts: events in order with a time, and the newest state', async () => {
    const before = Date.now();
    expect((await post('rec', { seq: 1, state: { n: 1 }, events: [{ type: 'click', target: 'a', trusted: true }] })).status).toBe(204);
    // Posts can overtake each other: seq 3 arrives before seq 2.
    await post('rec', { seq: 3, state: { n: 3 }, events: [{ type: 'click', target: 'c' }] });
    await post('rec', { seq: 2, state: { n: 2 }, events: [{ type: 'input', target: 'b' }] });
    const fx = server.state('rec');
    expect(fx.state).toEqual({ n: 3 });
    expect(fx.events.map(e => e.target)).toEqual(['a', 'b', 'c']);
    expect(fx.events[0]).toMatchObject({ type: 'click', trusted: true });
    expect(fx.events[0].t).toBeGreaterThanOrEqual(before);
    expect(await (await fetch(`http://127.0.0.1:${server.port}/api/state?run=rec`)).json()).toEqual(fx);
  });

  it('keeps runs apart, and an unknown run is empty', async () => {
    await post('one', { seq: 1, state: { a: 1 }, events: [] });
    expect(server.state('two')).toEqual({ state: {}, events: [] });
    expect(server.state('one').state).toEqual({ a: 1 });
  });

  it('rejects a bad run id and bad JSON', async () => {
    expect((await post('bad%20id', {})).status).toBe(400);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state?run=ok`, { method: 'POST', body: '{' });
    expect(res.status).toBe(400);
  });

  it('feeds the predicates of the web tasks', async () => {
    const task = loadTasks().find(t => t.id === 'web-trap-new')!;
    const clicks = { whatsNew: 0, new: 1, pageClose: 0, dialogClose: 0, hiddenLink: 0, visibleLink: 0, exportLabel: 0, exportButton: 0 };
    await post('trap-ok', { seq: 1, state: { clicks, dialogOpen: true }, events: [{ type: 'click', target: 'new' }] });
    await post('trap-bad', { seq: 1, state: { clicks: { ...clicks, new: 0, whatsNew: 1 }, dialogOpen: true }, events: [] });
    expect(evaluate(task.success!, server.state('trap-ok'))).toBe(true);
    expect(evaluate(task.success!, server.state('trap-bad'))).toBe(false);
  });
});

describe('the reading page', () => {
  const html = renderLongread();

  it('is the same on every render, and long', () => {
    expect(renderLongread()).toBe(html);
    expect(html.length).toBeGreaterThan(40_000);
  });

  it('shows 40 different station codes, each once', () => {
    const codes = Array.from({ length: 40 }, (_, i) => stationCode(i + 1));
    expect(new Set(codes).size).toBe(40);
    for (const c of codes) expect(html.split(c).length - 1, c).toBe(1);
    expect(html).toContain(`<tr><td>Delta-17</td><td>${stationCode(17)}</td></tr>`);
  });
});

describe('the web pages', () => {
  const read = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'web', name), 'utf8');

  it('the canvas page has no text and no control for the accessibility tree', () => {
    const body = read('canvas.html').split('<body>')[1].replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    expect(body.replace(/<canvas[^>]*aria-hidden="true"[^>]*><\/canvas>/, '').replace(/<\/?(body|html)>/g, '').trim()).toBe('');
  });

  it('the trap page puts each trap before the wanted element', () => {
    const html = read('trap.html');
    const before = (a: string, b: string) => expect(html.indexOf(`data-bench="${a}"`)).toBeLessThan(html.indexOf(`data-bench="${b}"`));
    before('whatsNew', 'new'); before('pageClose', 'dialogClose'); before('hiddenLink', 'visibleLink'); before('exportLabel', 'exportButton');
  });

  it('load nothing from outside the fixture server', () => {
    for (const page of WEB_PAGES.filter(p => p !== 'longread')) expect(read(`${page}.html`)).not.toMatch(/https?:\/\//);
    expect(renderLongread()).not.toMatch(/https?:\/\//);
  });
});

// The WinForms fixture: built with Add-Type and run with --selftest (off screen, never activated, closes itself).
describe.runIf(process.platform === 'win32')('the Windows native fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-fixture-test-'));
  const exe = path.join(dir, 'BenchFixture.exe');
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const selftest = (mode: string): FixtureState => {
    const state = path.join(dir, `${mode}.json`);
    execFileSync(exe, ['--state', state, '--mode', mode, '--selftest'], { timeout: 30_000 });
    return JSON.parse(fs.readFileSync(state, 'utf8'));
  };

  beforeAll(() => {
    execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, '..', 'fixtures', 'native', 'windows', 'build.ps1'), '-OutDir', dir], { timeout: 90_000 });
  }, 120_000);
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('records the dialog: fields, list, checkbox, the duplicate buttons and the modal', () => {
    const fx = selftest('dialog');
    expect(fx.state).toEqual({ name: 'Self Test', email: 'self@test.example', priority: 'High', subscribe: true,
      applied: { name: 'Self Test', email: 'self@test.example', priority: 'High', subscribe: true },
      billingEdit: 0, shippingEdit: 1, mainOk: 0, mainCancel: 0, modalOpen: false, modalResult: 'ok' });
    expect(fx.events.map(e => `${e.type}:${e.target}`)).toEqual(['input:name', 'input:email', 'select:priority', 'toggle:subscribe',
      'click:shippingEdit', 'click:apply', 'click:delete', 'click:modalOk']);
    expect(fx.events.every(e => Math.abs(e.t - Date.now()) < 60_000)).toBe(true);
    // The state has the keys the native tasks read.
    const modal = loadTasks().find(t => t.id === 'native-dialog-modal')!;
    expect(evaluate(modal.success!, { ...fx, state: { ...fx.state, shippingEdit: 0 } })).toBe(true);
    expect(evaluate(modal.success!, { ...fx, state: { ...fx.state, shippingEdit: 0, mainOk: 1 } })).toBe(false);
  }, 40_000);

  it('records the editor text with plain line breaks', () => {
    const fx = selftest('editor');
    expect(fx.state).toEqual({ text: 'first line\nsecond line' });
    const task = loadTasks().find(t => t.id === 'editor-type-lines')!;
    expect(evaluate(task.success!, fx)).toBe(false);
    expect(evaluate(task.success!, { state: { text: 'Benchmark line one\nBenchmark line two' }, events: [] })).toBe(true);
  }, 40_000);

  it('exits with an error when it is not told where to write its state', () => {
    expect(() => execFileSync(exe, ['--selftest'], { timeout: 30_000 })).toThrow();
  }, 40_000);
});
