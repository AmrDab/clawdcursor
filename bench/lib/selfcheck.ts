/**
 * `npm run bench -- --selfcheck`: proves the fixtures, the task predicates and the runner's isolation, without an agent
 * and without a window.
 *
 * Web: each web task's page is driven by a scripted trajectory in a HEADLESS browser, once the right way (the predicate
 * must hold) and once into the trap (it must not). Native: the fixture's own --selftest (off screen, never activated).
 * Isolation: the isolated daemon and the fixture browser start and stop, and the owner's ~/.clawdcursor is unchanged.
 * It is not part of the unit tests: it needs an installed Chromium browser and a clawdcursor build.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, type Page } from 'playwright';
import { findBrowser, openBrowser } from './browser';
import { resolveCli, startIsolated } from './isolated';
import { buildNative, nativeArgs, openApp, openNativeFixture, readStateFile, type LiveFixture } from './live-fixtures';
import { cdpIsFixture, ownsFocus, readFocus } from './ownership';
import { freePort, pidsByCommandLine, tryRun, waitFor } from './proc';
import { startFixtureServer } from './fixture-server';
import { evaluate, loadTasks } from './tasks';
import type { TaskSpec } from './types';

type Script = (p: Page) => Promise<void>;

/** Per web task: [the right trajectory, a wrong one]. */
const SCRIPTS: Record<string, [Script, Script]> = {
  'web-form-fill': [
    async p => {
      await p.fill('#name', 'Ada Lovelace');
      await p.fill('#qty', '7');
      await p.selectOption('#shipping', 'Express');
      await p.check('#gift');
      await p.uncheck('#newsletter');
      await p.click('summary');
      await p.check('#fragile');
      await p.click('#note');
      await p.keyboard.type('Leave at the side door');
      await p.click('#confirm');
    },
    async p => { await p.fill('#name', 'Ada Lovelace'); await p.click('#confirm'); },
  ],
  'web-trap-new': [p => p.click('[data-bench="new"]'), p => p.click('[data-bench="whatsNew"]')],
  'web-trap-dialog-close': [p => p.click('[data-bench="dialogClose"]'), p => p.click('[data-bench="pageClose"]')],
  'web-trap-hidden-link': [
    p => p.click('[data-bench="visibleLink"]'),
    p => p.evaluate(() => (document.querySelector('[data-bench="hiddenLink"]') as HTMLElement).click()),
  ],
  'web-trap-label-button': [p => p.click('[data-bench="exportButton"]'), p => p.click('[data-bench="exportLabel"]')],
  'web-timing-late-dialog': [
    async p => { await p.click('#start'); await p.click('#download', { timeout: 8000 }); },
    async p => { await p.click('#start'); await p.waitForTimeout(300); },
  ],
  'web-timing-gated-field': [
    async p => {
      await p.click('#open');
      await p.waitForFunction(() => document.getElementById('editorStatus')!.textContent === 'Ready', undefined, { timeout: 8000 });
      await p.fill('#code', 'ORBIT-42');
      await p.click('#save');
    },
    // Typed at once: the field throws it away, and Save before Ready saves nothing.
    async p => { await p.click('#open'); await p.fill('#code', 'ORBIT-42'); await p.click('#save'); },
  ],
  'web-canvas-draw': [
    async p => { await drag(p, [120, 120], [520, 520]); },
    async p => { await drag(p, [120, 120], [520, 120]); },
  ],
  'web-canvas-targets': [
    async p => { for (const [x, y] of [[110, 100], [520, 130], [320, 320], [130, 530], [540, 500]]) await p.mouse.click(x, y); },
    async p => { for (const [x, y] of [[110, 100], [300, 100], [300, 500], [400, 400]]) await p.mouse.click(x, y); },
  ],
  'web-long-read': [
    async p => {
      const code = await p.locator('tr', { has: p.locator('td', { hasText: /^Delta-17$/ }) }).locator('td').nth(1).innerText();
      await p.fill('#answer', code);
      await p.click('#submit');
    },
    async p => { await p.fill('#answer', 'QX-4462-MX'); await p.click('#submit'); },
  ],
};

/** The canvas sits 20 px into the page: page coordinates here. */
async function drag(p: Page, from: [number, number], to: [number, number]): Promise<void> {
  await p.mouse.move(from[0], from[1]);
  await p.mouse.down();
  await p.mouse.move(to[0], to[1], { steps: 3 });
  await p.mouse.up();
}

export async function selfcheckWeb(log: (line: string) => void = console.log): Promise<boolean> {
  const tasks = loadTasks().filter(t => t.fixture.kind === 'web');
  const server = await startFixtureServer();
  // An installed browser, headless: no window, nothing takes the focus.
  const channel = process.platform === 'win32' ? 'msedge' : 'chrome';
  const browser = await chromium.launch({ channel, headless: true });
  let ok = true;
  try {
    for (const task of tasks) {
      const scripts = SCRIPTS[task.id];
      if (!scripts) { log(`FAIL ${task.id}: no selfcheck script`); ok = false; continue; }
      for (const [i, want] of [[0, true], [1, false]] as Array<[number, boolean]>) {
        const got = await runScript(task, scripts[i], `${task.id}-${i}`, server, browser);
        const pass = got.holds === want && (want ? got.events > 0 : true);
        if (!pass) ok = false;
        log(`${pass ? 'ok  ' : 'FAIL'} ${task.id} ${want ? 'right' : 'wrong'} trajectory: predicate ${got.holds}, ${got.events} events`);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return ok;
}

async function runScript(task: TaskSpec, script: Script, run: string, server: Awaited<ReturnType<typeof startFixtureServer>>,
  browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<{ holds: boolean; events: number }> {
  if (task.fixture.kind !== 'web' || !task.success) throw new Error('not a web task');
  const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
  try {
    await page.goto(server.url(task.fixture.page, run, task.fixture.query));
    await script(page);
    await page.waitForTimeout(400);  // the recorder posts 30 ms after an event and polls its state every 200 ms
    const fx = server.state(run);
    return { holds: evaluate(task.success, fx), events: fx.events.length };
  } finally {
    await page.close();
  }
}

/** The native fixture of this OS: built, then run with --selftest (off screen, never activated, closes itself). */
export async function selfcheckNative(log: (line: string) => void = console.log): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-selfcheck-'));
  try {
    const built = await buildNative(dir);
    if ('missing' in built) { log(`skip native fixture: ${built.missing}`); return true; }
    let ok = true;
    for (const mode of ['dialog', 'editor'] as const) {
      const state = path.join(dir, `${mode}.json`);
      const ran = await tryRun(built.cmd, [...built.args, ...nativeArgs({ state, mode }), '--selftest'], 60_000);
      const fx = ran === null ? null : readStateFile(state);
      const pass = !!fx && (mode === 'editor' ? fx.state.text === 'first line\nsecond line'
        : fx.state.modalResult === 'ok' && fx.state.shippingEdit === 1 && fx.state.billingEdit === 0
          && JSON.stringify(fx.state.applied) === JSON.stringify({ name: 'Self Test', email: 'self@test.example', priority: 'High', subscribe: true }));
      if (!pass) ok = false;
      log(`${pass ? 'ok  ' : 'FAIL'} native fixture ${mode}: ${fx ? `${fx.events.length} events` : 'no state file'}`);
    }
    return ok;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What a daemon writes into its data directory when it starts: the token, consent, pidfile and config. The owner's own
 * clawdcursor may be running and logging meanwhile, so the whole directory is not compared: these files are, and the
 * session and log files are searched for the isolated daemon's pid.
 */
function fingerprint(dir: string): string {
  return ['token', 'consent', 'start.pid', 'config.json'].map(f => {
    try { const st = fs.statSync(path.join(dir, f)); return `${f}|${st.size}|${st.mtimeMs}`; } catch { return `${f}|none`; }
  }).join('\n');
}

/** Did the process `pid` leave a session file in the owner's directory? (Session files are named ...-<pid>-<n>.jsonl.) */
function wroteSession(dir: string, pid: number): boolean {
  try { return fs.readdirSync(path.join(dir, 'sessions')).some(f => f.includes(`-${pid}-`)); } catch { return false; }
}

/**
 * The isolation of the runner: the fixture browser (headless here) opens a page and is closed whole; the isolated daemon
 * starts in a temp home on its own port, refuses a request without its token and lists the six tools. It is fenced
 * (CLAWD_FENCE_PIDS) to the headless browser, and a handful of calls prove the fence refuses them before anything on
 * the desktop is read or touched. The owner's ~/.clawdcursor must be byte-for-byte as before.
 */
export async function selfcheckIsolation(buildDir: string | undefined, log: (line: string) => void = console.log): Promise<boolean> {
  const real = path.join(os.homedir(), '.clawdcursor');
  const before = fingerprint(real);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-selfcheck-'));
  const check = (ok: boolean, what: string) => { log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); return ok; };
  let ok = true;
  const server = await startFixtureServer();
  try {
    const { cli, version, source } = await resolveCli(buildDir);
    const exe = findBrowser();
    const profileDir = path.join(root, 'browser-profile');
    const browser = exe ? await openBrowser(exe, { profileDir, url: server.url('trap', 'isolation'), extraArgs: ['--headless=new'] }) : null;
    const cdpPort = browser?.cdpPort ?? await freePort();
    if (!browser) log('skip fixture browser: no Chromium browser installed');
    // Fenced to the headless fixture browser (or to nothing): no call below may reach the desktop.
    const fencePids = exe && browser ? await pidsByCommandLine(profileDir, path.basename(exe.exe)) : [];
    const daemon = await startIsolated({ cli, home: path.join(root, 'home'), sessionDir: path.join(root, 'sessions'), cdpPort, fencePids, logFile: path.join(root, 'server.log') });
    const daemonPid = daemon.pid;
    try {
      if (browser) {
        await waitFor(() => server.state('isolation').events.some(e => e.type === 'load'), 10_000, 'the page to report').catch(() => undefined);
        ok = check(server.state('isolation').events.some(e => e.type === 'load'), 'fixture browser: the page reports to the fixture server') && ok;
        // The privacy guard's proofs, for real: the debug port belongs to a process on the temp profile; and this
        // headless browser has no window, so the focus (wherever the owner is working) is not the fixture's.
        const roots = () => pidsByCommandLine(profileDir, path.basename(exe!.exe));
        ok = check(await cdpIsFixture({ cdpPort, profileDir, browserPids: roots }), 'privacy proof: the browser on the fixture debug port runs on the fixture profile') && ok;
        ok = check(!await cdpIsFixture({ cdpPort, profileDir: root, browserPids: roots }) && !await cdpIsFixture({ cdpPort, profileDir, browserPids: () => [] }),
          'privacy proof: a browser that is not on the fixture profile is refused') && ok;
        ok = check(!ownsFocus(await readFocus(), await roots()), 'privacy proof: the focused window (not a fixture) is not accepted as one') && ok;
      }
      const bare = await fetch(daemon.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      ok = check(bare.status === 401, `isolated clawdcursor ${version} (${source}) on port ${daemon.port}: refuses a request without its token`) && ok;
      const client = new Client({ name: 'bench-selfcheck', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${daemon.token}` } } }));
      const tools = (await client.listTools()).tools.map(t => t.name).sort().join(',');
      // The fence, end to end: each of these is refused by the daemon BEFORE it reads or does anything (code FENCED).
      // The window in front here is whatever the owner is using: it is not in the fence.
      const fencedCalls: Array<[string, Record<string, unknown>]> = [
        ['window', { action: 'list' }], ['system', { action: 'clipboard_read' }], ['computer', { action: 'screenshot' }],
        ['accessibility', { action: 'read_tree' }], ['window', { action: 'open_url', url: 'http://127.0.0.1:9/' }],
        ['batch', { steps: [{ name: 'system', arguments: { action: 'clipboard_read' } }, { name: 'window', arguments: { action: 'list' } }] }],
      ];
      for (const [name, args] of fencedCalls) {
        const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
        const text = (r.content ?? []).map(c => c.text ?? '').join('\n');
        const image = (r.content ?? []).some(c => c.type === 'image');
        ok = check(!!r.isError && text.includes('FENCED: ') && !image, `fence: ${name} ${String(args.action ?? '')} is refused before anything is read`) && ok;
      }
      await client.close();
      ok = check(tools === 'accessibility,batch,browser,computer,system,window', `isolated clawdcursor: the six tools (${tools})`) && ok;
      ok = check(fs.existsSync(path.join(root, 'home', '.clawdcursor', 'token')), 'isolated clawdcursor: its data is in the temp home') && ok;
    } finally {
      await daemon.stop();
      await browser?.close();
    }
    ok = check(!fs.existsSync(profileDir), 'fixture browser: closed, its temp profile removed') && ok;
    ok = check(fingerprint(real) === before && !wroteSession(real, daemonPid), `the owner's ${real} is untouched (token, consent, pidfile, config, sessions)`) && ok;
  } catch (e) {
    ok = check(false, `isolation: ${(e as Error).message}`);
  } finally {
    await server.close();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* a temp dir */ }
  }
  return ok;
}

/**
 * `--selfcheck-fixtures`: the benchmark's own fixtures behind the real fence. Unlike --selfcheck this OPENS WINDOWS for a
 * few seconds (the native fixture twice, and Calculator when it can be used), and focuses its own fixture. No agent runs.
 *
 * It is the check the first Codex run needed: the daemon is fenced to the fixture exactly as a live run fences it, and
 * `window focus` and `read_tree` on the fixture must be ALLOWED, while a second, unfenced window must be REFUSED.
 */
export async function selfcheckFixtures(buildDir: string | undefined, log: (line: string) => void = console.log): Promise<boolean> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-selfcheck-'));
  const check = (ok: boolean, what: string) => { log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); return ok; };
  let ok = true;
  type Reply = { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = (r: Reply) => (r.content ?? []).map(c => c.text ?? '').join('\n');
  /** A daemon fenced to `fixture`, and a client on it: what `run` sees is what an agent would. */
  const fenced = async (fixture: LiveFixture, n: number, run: (call: (name: string, args: Record<string, unknown>) => Promise<Reply>) => Promise<void>) => {
    const { cli } = await resolveCli(buildDir);
    const daemon = await startIsolated({ cli, home: path.join(root, `home-${n}`), sessionDir: path.join(root, `sessions-${n}`), cdpPort: await freePort(),
      fencePids: await fixture.roots(), logFile: path.join(root, `server-${n}.log`) });
    const client = new Client({ name: 'bench-selfcheck-fixtures', version: '0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${daemon.token}` } } }));
      await run((name, args) => client.callTool({ name, arguments: args }) as Promise<Reply>);
    } finally {
      await client.close().catch(() => { /* not connected */ });
      await daemon.stop();
    }
  };
  const allowed = (r: Reply) => !text(r).includes('FENCED: ');
  try {
    const native = await buildNative(path.join(root, 'native'));
    if ('missing' in native) log(`skip native fixture: ${native.missing}`);
    else {
      const dirs = ['fixture', 'other'].map(d => { const dir = path.join(root, d); fs.mkdirSync(dir, { mode: 0o700 }); return dir; });
      // The window the run is fenced to, and a second window that is NOT in the fence (the same app, another process).
      const other = await openNativeFixture('editor', native, dirs[1]);
      const fixture = await openNativeFixture('dialog', native, dirs[0]);
      try {
        const otherPid = (await other.roots())[0];
        await fenced(fixture, 1, async call => {
          const focus = await call('window', { action: 'focus', title: 'Bench Dialog' });
          ok = check(allowed(focus) && !focus.isError, `native fixture: window focus on it is allowed (${text(focus).split('\n')[0].slice(0, 80)})`) && ok;
          const tree = await call('accessibility', { action: 'read_tree' });
          ok = check(allowed(tree) && /Apply/.test(text(tree)) && /Subscribe/.test(text(tree)), 'native fixture: read_tree on it is allowed and shows its controls') && ok;
          ok = check(!/Bench Editor/.test(text(tree)), 'native fixture: read_tree does not list the window outside the fence') && ok;
          const byPid = await call('accessibility', { action: 'read_tree', processId: (await fixture.roots())[0] });
          ok = check(allowed(byPid), 'native fixture: read_tree by its process id is allowed') && ok;
          const otherFocus = await call('window', { action: 'focus', title: 'Bench Editor' });
          ok = check(!allowed(otherFocus) && !!otherFocus.isError, 'a window outside the fence: window focus is refused (FENCED)') && ok;
          const otherTree = await call('accessibility', { action: 'read_tree', processId: otherPid });
          ok = check(!allowed(otherTree) && !/Document/.test(text(otherTree)), 'a window outside the fence: read_tree is refused (FENCED)') && ok;
          const again = await call('window', { action: 'focus', title: 'Bench Dialog' });
          ok = check(allowed(again), 'native fixture: still allowed after the refusals') && ok;
        });
      } finally {
        await fixture.close();
        await other.close();
      }
    }

    // A Store app: its window belongs to ApplicationFrameHost, the fence is given the app's own process.
    const calc = await openApp('calculator', { workDir: root });
    if ('skip' in calc) log(`skip Calculator: ${calc.skip}`);
    else {
      try {
        await fenced(calc, 2, async call => {
          const tree = await call('accessibility', { action: 'read_tree' });
          ok = check(allowed(tree) && /Calculator/.test(text(tree)), 'Calculator (a Store app): read_tree on it is allowed') && ok;
          const focus = await call('window', { action: 'focus', title: 'Calculator' });
          ok = check(allowed(focus), `Calculator: window focus by its title is allowed (${text(focus).split('\n')[0].slice(0, 80)})`) && ok;
          const host = await call('window', { action: 'focus', processName: 'ApplicationFrameHost' });
          ok = check(!allowed(host), 'Calculator: its shared host process by name is refused (FENCED)') && ok;
        });
      } finally {
        await calc.close();
      }
    }
  } catch (e) {
    ok = check(false, `fixtures behind the fence: ${(e as Error).message}`);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* a temp dir */ }
  }
  return ok;
}
