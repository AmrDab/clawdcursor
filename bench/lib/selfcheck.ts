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
import { ORACLES, nativeDo, oracleCounts, runnable, scriptProblems } from './oracles';
import { TASKS_DIR } from './tasks';
import { cdpIsFixture, ownsFocus, readFocus } from './ownership';
import { Watchdog, readSessionCalls } from './watchdog';
import { freePort, pidsByCommandLine, tryRun, waitFor } from './proc';
import { startFixtureServer } from './fixture-server';
import { evaluate, loadTasks } from './tasks';
import type { TaskSpec } from './types';

type Script = (p: Page) => Promise<unknown>;

/**
 * Per web task: a WRONG trajectory, the trap the task is about. The right one is the task's oracle script (oracles.ts):
 * the predicate must hold after the oracle and must not hold after this.
 */
const WRONG: Record<string, Script> = {
  'web-form-fill': async p => { await p.fill('#name', 'Ada Lovelace'); await p.click('#confirm'); },
  'web-trap-new': p => p.click('[data-bench="whatsNew"]'),
  'web-trap-dialog-close': p => p.click('[data-bench="pageClose"]'),
  'web-trap-hidden-link': p => p.evaluate(() => (document.querySelector('[data-bench="hiddenLink"]') as HTMLElement).click()),
  'web-trap-label-button': p => p.click('[data-bench="exportLabel"]'),
  'web-timing-late-dialog': async p => { await p.click('#start'); await p.waitForTimeout(300); },
  // Typed at once: the field throws it away, and Save before Ready saves nothing.
  'web-timing-gated-field': async p => { await p.click('#open'); await p.fill('#code', 'ORBIT-42'); await p.click('#save'); },
  'web-canvas-draw': async p => { await p.mouse.move(120, 120); await p.mouse.down(); await p.mouse.move(520, 120, { steps: 3 }); await p.mouse.up(); },
  'web-canvas-targets': async p => { for (const [x, y] of [[110, 100], [300, 100], [300, 500], [400, 400]]) await p.mouse.click(x, y); },
  'web-long-read': async p => { await p.fill('#answer', 'QX-4462-MX'); await p.click('#submit'); },
};

/** What a script measured against what the task's spec says. */
export interface Measured { task: string; calls: number; screenshots: number; spec: { calls: number; screenshots: number }; ran: 'web' | 'native' | 'not run here' }

/** Run every web task's oracle script and its wrong trajectory in a headless browser. */
export async function selfcheckWeb(log: (line: string) => void = console.log, measured: Measured[] = []): Promise<boolean> {
  const tasks = loadTasks().filter(t => t.fixture.kind === 'web');
  const server = await startFixtureServer();
  // An installed browser, headless: no window, nothing takes the focus.
  const channel = process.platform === 'win32' ? 'msedge' : 'chrome';
  const browser = await chromium.launch({ channel, headless: true });
  let ok = true;
  try {
    for (const task of tasks) {
      const steps = ORACLES[task.id];
      const wrong = WRONG[task.id];
      if (!steps || !wrong || runnable(steps) !== 'web') { log(`FAIL ${task.id}: no oracle script or no wrong trajectory to run in a browser`); ok = false; continue; }
      const right = await runScript(task, async p => { for (const step of steps) await step.web!(p); }, `${task.id}-oracle`, server, browser);
      const counts = oracleCounts(steps);
      const pass = right.holds && right.events > 0;
      if (!pass) ok = false;
      else measured.push({ task: task.id, ...counts, spec: task.oracle, ran: 'web' });
      log(`${pass ? 'ok  ' : 'FAIL'} ${task.id} oracle script: predicate ${right.holds}, ${counts.calls} calls, ${counts.screenshots} screenshots`);
      const bad = await runScript(task, wrong, `${task.id}-wrong`, server, browser);
      if (bad.holds) ok = false;
      log(`${bad.holds ? 'FAIL' : 'ok  '} ${task.id} wrong trajectory: predicate ${bad.holds}`);
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
export async function selfcheckNative(log: (line: string) => void = console.log, measured: Measured[] = []): Promise<boolean> {
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
    // Each native task's oracle script, through the fixture's own handlers (--do): the predicate must hold after it.
    for (const task of loadTasks().filter(t => t.fixture.kind === 'native')) {
      const steps = ORACLES[task.id];
      if (!steps || runnable(steps) !== 'native' || task.fixture.kind !== 'native' || !task.success) { log(`FAIL ${task.id}: no oracle script to run in the fixture`); ok = false; continue; }
      const counts = oracleCounts(steps);
      if (process.platform !== 'win32') {   // only the WinForms fixture runs a script so far
        measured.push({ task: task.id, ...counts, spec: task.oracle, ran: 'not run here' });
        log(`skip ${task.id} oracle script: this OS's fixture does not run scripts yet (${counts.calls} calls)`);
        continue;
      }
      const state = path.join(dir, `${task.id}.json`);
      const ran = await tryRun(built.cmd, [...built.args, ...nativeArgs({ state, mode: task.fixture.mode }), '--selftest', '--do', nativeDo(steps)], 60_000);
      const fx = ran === null ? null : readStateFile(state);
      const holds = !!fx && evaluate(task.success, fx);
      if (!holds) ok = false;
      else measured.push({ task: task.id, ...counts, spec: task.oracle, ran: 'native' });
      log(`${holds ? 'ok  ' : 'FAIL'} ${task.id} oracle script: predicate ${holds}, ${counts.calls} calls, ${counts.screenshots} screenshots`);
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
      // The window the run is fenced to, and a second window that is NOT in the fence: another process, whose title
      // CONTAINS the fixture's title (on Windows, where the fixture takes a title). A focus that searched by title could
      // take either.
      const lookalike = process.platform === 'win32' ? 'Bench Dialog - notes (not the fixture)' : undefined;
      const otherTitle = lookalike ?? 'Bench Editor';
      const other = await openNativeFixture('editor', native, dirs[1], lookalike);
      const fixture = await openNativeFixture('dialog', native, dirs[0]);
      try {
        const otherPid = (await other.roots())[0];
        const fixturePid = (await fixture.roots())[0];
        await fenced(fixture, 1, async call => {
          const front = async () => { const t = await call('accessibility', { action: 'read_tree' }); return allowed(t) && /Apply/.test(text(t)) && /Subscribe/.test(text(t)); };
          const focus = await call('window', { action: 'focus', processId: fixturePid });
          ok = check(allowed(focus) && !focus.isError, `native fixture: window focus on it is allowed (${text(focus).split('\n')[0].slice(0, 80)})`) && ok;
          const tree = await call('accessibility', { action: 'read_tree' });
          ok = check(allowed(tree) && /Apply/.test(text(tree)) && /Subscribe/.test(text(tree)), 'native fixture: read_tree on it is allowed and shows its controls') && ok;
          ok = check(!text(tree).includes(otherTitle), 'native fixture: read_tree does not list the window outside the fence') && ok;
          const byPid = await call('accessibility', { action: 'read_tree', processId: fixturePid });
          ok = check(allowed(byPid), 'native fixture: read_tree by its process id is allowed') && ok;
          if (lookalike) {
            // "Bench Dialog" is in both titles: refused, and the look-alike is never brought to the front.
            const ambiguous = await call('window', { action: 'focus', title: 'Bench Dialog' });
            ok = check(!allowed(ambiguous) && !!ambiguous.isError, 'a second window whose title contains the fixture\'s: focus by that title is refused (FENCED)') && ok;
            ok = check(await front(), 'a second window whose title contains the fixture\'s: it was not focused (the fixture is still in front)') && ok;
          }
          const otherFocus = await call('window', { action: 'focus', title: otherTitle });
          ok = check(!allowed(otherFocus) && !!otherFocus.isError, 'a window outside the fence: window focus is refused (FENCED)') && ok;
          const otherByPid = await call('window', { action: 'focus', processId: otherPid });
          ok = check(!allowed(otherByPid), 'a window outside the fence: window focus by its process id is refused (FENCED)') && ok;
          const otherTree = await call('accessibility', { action: 'read_tree', processId: otherPid });
          ok = check(!allowed(otherTree) && !/Document/.test(text(otherTree)), 'a window outside the fence: read_tree is refused (FENCED)') && ok;
          ok = check(await front(), 'the window outside the fence was never focused: the fixture is still in front') && ok;
          const again = await call('window', { action: 'focus', processId: fixturePid });
          ok = check(allowed(again) && !again.isError, 'native fixture: still allowed after the refusals') && ok;
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
          // One act by name, in the benchmark's own Calculator (the 0 key): what stopped the second Codex run. The session
          // log must name the app it went to as the APP, and the watchdog, with its real proofs, must let it pass.
          const press = await call('accessibility', { action: 'invoke', name: 'Zero' });
          ok = check(allowed(press) && !press.isError, `Calculator: an act by name on it is allowed (${text(press).split('\n')[0].slice(0, 70)})`) && ok;
          const calls = readSessionCalls(path.join(root, 'sessions-2'));
          const acted = calls.filter(c => c.tool === 'accessibility' && c.action === 'invoke');
          ok = check(acted.length === 1 && acted[0].app === 'Calculator', `Calculator: the session log names the app acted in "Calculator" (it says "${acted[0]?.app ?? '(none)'}")`) && ok;
          const roots = await calc.roots();
          ok = check(!!acted[0]?.appPid && roots.includes(acted[0].appPid) && Number.isInteger(acted[0].appHandle),
            `Calculator: the act line carries who it went to: process ${acted[0]?.appPid} (the Calculator the benchmark started: ${roots.join(', ')}), window ${acted[0]?.appHandle}`) && ok;
          const dog = new Watchdog({ maxCalls: 50, maxSeconds: 600, fixtureApps: calc.apps }, {
            ownsFocus: async () => ownsFocus(await readFocus(), await calc.roots(), calc.frameTitle), ownsPid: async pid => (await calc.roots()).includes(pid),
            cdpIsFixture: () => false });
          let verdict: { rule: string; detail: string } | null = null;
          for (const c of calls) verdict ??= await dog.judge(c);
          ok = check(verdict === null, `Calculator: the watchdog agrees with the fence: no privacy stop${verdict ? ` (${verdict.rule}: ${verdict.detail})` : ''}`) && ok;
          // A batch: each step carries its OWN verified target, and the watchdog judges each step by it.
          const two = await call('batch', { steps: [{ name: 'accessibility', arguments: { action: 'invoke', name: 'Zero' } }, { name: 'accessibility', arguments: { action: 'invoke', name: 'Zero' } }] });
          const batchLine = readSessionCalls(path.join(root, 'sessions-2')).filter(c => c.tool === 'batch').pop();
          const stepPids = (batchLine?.steps ?? []).map(st => st.appPid);
          ok = check(allowed(two) && stepPids.length === 2 && stepPids.every(p => !!p && roots.includes(p)),
            `Calculator: each step of a batch records its own target process (${stepPids.join(', ')})`) && ok;
          const batchVerdict = batchLine ? await dog.judge(batchLine) : { rule: 'missing', detail: 'no batch line' };
          ok = check(batchVerdict === null, `Calculator: the watchdog passes the batch step by step${batchVerdict ? ` (${batchVerdict.rule}: ${batchVerdict.detail})` : ''}`) && ok;
          const stripped = batchLine ? await dog.judge({ ...batchLine, steps: batchLine.steps!.map(st => ({ ...st, appPid: undefined })) }) : null;
          ok = check(stripped?.rule === 'privacy', 'Calculator: the same batch with no process on its steps is stopped, though the batch line has one') && ok;
          // The same act under the shared host's name: inside by the process recorded with it; with no such record, stopped.
          const asHost = await dog.judge({ ...acted[0], app: 'Application Frame Host' });
          ok = check(asHost === null, 'Calculator: an act logged under the shared host name passes by the process recorded with it') && ok;
          const noRecord = await dog.judge({ ...acted[0], app: 'Application Frame Host', appPid: undefined, appHandle: undefined });
          ok = check(noRecord?.rule === 'privacy', 'Calculator: a shared-host act with no process recorded is stopped, wherever the focus is') && ok;
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

/**
 * The oracles: every task's spec must carry exactly the counts of its script, and every script must have the shape of
 * a minimal but realistic trajectory. `measured` holds the scripts that were RUN here (and held their predicate); the
 * real-app tasks cannot be run without their app, so their scripts are only counted. With `write`, the counts are
 * written into the specs instead of compared.
 */
export function selfcheckOracles(measured: Measured[], write: boolean, log: (line: string) => void = console.log): boolean {
  let ok = true;
  for (const task of loadTasks()) {
    const steps = ORACLES[task.id];
    if (!steps) { log(`FAIL ${task.id}: no oracle script (bench/lib/oracles.ts)`); ok = false; continue; }
    const problems = scriptProblems(steps);
    if (problems.length) { log(`FAIL ${task.id} oracle script: ${problems.join('; ')}`); ok = false; continue; }
    const counts = oracleCounts(steps);
    const ran = measured.find(m => m.task === task.id)?.ran ?? 'not run here';
    if (task.oracle.calls === counts.calls && task.oracle.screenshots === counts.screenshots) {
      log(`ok   ${task.id} oracle: ${counts.calls} calls, ${counts.screenshots} screenshots (script ${ran === 'not run here' ? 'counted, not run here' : `run: ${ran}`})`);
      continue;
    }
    if (!write) {
      log(`FAIL ${task.id} oracle: the spec says ${task.oracle.calls} calls / ${task.oracle.screenshots} screenshots, its script is ${counts.calls} / ${counts.screenshots}. Run --selfcheck --write-oracles.`);
      ok = false;
      continue;
    }
    const file = path.join(TASKS_DIR, `${task.id}.json`);
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    spec.oracle = { screenshots: counts.screenshots, calls: counts.calls };
    fs.writeFileSync(file, JSON.stringify(spec, null, 2) + '\n');
    log(`wrote ${task.id} oracle: ${counts.calls} calls, ${counts.screenshots} screenshots (was ${task.oracle.calls} / ${task.oracle.screenshots})`);
  }
  return ok;
}
