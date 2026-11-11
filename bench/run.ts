/**
 * The clawdcursor benchmark runner (issue #384). See bench/README.md.
 *
 *   npm run bench                    the plan: what would run here. Starts nothing.
 *   npm run bench -- --selfcheck     proves fixtures and predicates in a headless browser. No agent, no window.
 *   npm run bench -- --live [...]    runs the tasks. TAKES OVER THE MOUSE AND KEYBOARD until it ends.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { ADAPTERS, detectModels, parseModels, type ModelRun } from './lib/adapters';
import { findBrowser } from './lib/browser';
import { startFixtureServer, type FixtureServer } from './lib/fixture-server';
import { resolveCli, startIsolated } from './lib/isolated';
import { appUnavailable, buildNative, openFixture, type FixtureContext, type NativeBuild } from './lib/live-fixtures';
import { USER_CDP_PORT, cdpIsFixture, ownsFocus, readFocus } from './lib/ownership';
import { freePort, sleep } from './lib/proc';
import { buildPrompt } from './lib/prompt';
import { buildReport, compare, renderMarkdown, score, toBaseline, type Baseline, type Score } from './lib/scorer';
import { currentOs, loadTasks } from './lib/tasks';
import { Watchdog, readSessionCalls, tailSessionDir, type Verdict } from './lib/watchdog';
import type { AgentRun, CallSig, TaskSpec } from './lib/types';

export interface Options {
  live: boolean; selfcheck: boolean; includeManual: boolean; updateBaseline: boolean;
  build?: string; models?: string; tasks?: string[]; out?: string; baseline?: string; pos?: [number, number];
}

export function parseArgs(argv: string[]): Options {
  const o: Options = { live: false, selfcheck: false, includeManual: false, updateBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--live') o.live = true;
    else if (a === '--selfcheck') o.selfcheck = true;
    else if (a === '--include-manual') o.includeManual = true;
    else if (a === '--update-baseline') o.updateBaseline = true;
    else if (a === '--build') o.build = value();
    else if (a === '--models') o.models = value();
    else if (a === '--tasks') o.tasks = value().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--out') o.out = value();
    else if (a === '--baseline') o.baseline = value();
    else if (a === '--window-pos') {
      const [x, y] = value().split(',').map(Number);
      if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('--window-pos needs x,y');
      o.pos = [x, y];
    } else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** The tasks to run here, and the ones left out with the reason. Real apps are checked when their turn comes. */
export function selectTasks(all: TaskSpec[], o: Pick<Options, 'tasks' | 'includeManual'>, osName = currentOs()): { run: TaskSpec[]; skipped: Array<{ task: string; why: string }> } {
  const unknown = (o.tasks ?? []).filter(id => !all.some(t => t.id === id));
  if (unknown.length) throw new Error(`unknown task(s): ${unknown.join(', ')}`);
  const run: TaskSpec[] = [];
  const skipped: Array<{ task: string; why: string }> = [];
  for (const t of all) {
    if (o.tasks && !o.tasks.includes(t.id)) continue;
    if (!t.os.includes(osName)) skipped.push({ task: t.id, why: `runs on ${t.os.join(', ')} only` });
    else if (t.manualVerify && !o.includeManual) skipped.push({ task: t.id, why: 'manual verify: pass --include-manual, with the app open' });
    else run.push(t);
  }
  return { run, skipped };
}

const portOpen = (port: number) => new Promise<boolean>(resolve => {
  const s = net.connect({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

interface Env { cli: string; server: FixtureServer; native: NativeBuild | { missing: string }; outDir: string; tempRoot: string; pos?: [number, number] }

/** One task with one model: fixture, isolated server, agent under the watchdog, then the score. */
async function runOne(task: TaskSpec, m: ModelRun, env: Env, n: number): Promise<Score | { skip: string }> {
  const workDir = path.join(env.outDir, m.label.replace(/[^A-Za-z0-9._-]/g, '_'), task.id);
  fs.mkdirSync(workDir, { recursive: true });
  const ctx: FixtureContext = { server: env.server, browser: findBrowser(), native: env.native, workDir, runId: `r${n}-${task.id}`.slice(0, 64), pos: env.pos };
  const fixture = await openFixture(task, ctx);
  if ('skip' in fixture) return fixture;
  const sessionDir = path.join(workDir, 'sessions');
  let daemon: Awaited<ReturnType<typeof startIsolated>> | undefined;
  try {
    // clawdcursor's browser port: the fixture browser's. For a task with no browser, a free port nothing listens on.
    const cdpPort = fixture.cdp?.cdpPort ?? await freePort();
    daemon = await startIsolated({ cli: env.cli, home: path.join(env.tempRoot, `home-${n}`), sessionDir, cdpPort, logFile: path.join(workDir, 'server.log') });
    // What the privacy guard may rely on: the focus is in a process this task started, and (web) CDP can only reach its browser.
    const cdp = fixture.cdp;
    const proveCdp = async () => cdp !== undefined && await cdpIsFixture({ ...cdp, browserPids: fixture.roots });
    let cdpProven = await proveCdp();
    const cdpClock = setInterval(() => { proveCdp().then(ok => { cdpProven = ok; }, () => { cdpProven = false; }); }, 5000);
    const dog = new Watchdog({ maxCalls: task.caps.calls, maxSeconds: task.caps.seconds, fixtureApps: fixture.apps }, {
      ownsFocus: async () => ownsFocus(await readFocus(), await fixture.roots(), fixture.frameTitle),
      cdpIsFixture: () => cdpProven,
    });
    const abort = new AbortController();
    let killed: Verdict | undefined;
    const stop = (v: Verdict | null) => { if (v && !killed) { killed = v; abort.abort(); } };
    const sigs: CallSig[] = [];
    const started = Date.now();
    // One line at a time, in order: the privacy proofs of a line finish before the next line is judged.
    let judging: Promise<void> = Promise.resolve();
    const stopTail = tailSessionDir(sessionDir, c => { judging = judging.then(async () => stop(await dog.judge(c))).catch(() => undefined); });
    const clock = setInterval(() => stop(dog.onTime((Date.now() - started) / 1000)), 500);
    let result = { finalText: '', exitCode: null as number | null };
    try {
      result = await m.adapter.run({ prompt: buildPrompt(task, fixture.window), model: m.model, mcpUrl: daemon.mcpUrl, token: daemon.token, workDir,
        signal: abort.signal, onSig: s => { sigs.push(s); stop(dog.onSig(s)); } });
    } catch (e) {
      result.finalText = `adapter error: ${(e as Error).message}`;
    } finally {
      clearInterval(clock);
      clearInterval(cdpClock);
      stopTail();
    }
    await judging;   // the last calls are judged before the score is written
    const seconds = (Date.now() - started) / 1000;
    await sleep(1500);   // a late effect still reaches the fixture's recorder
    const state = await fixture.state();
    const calls = readSessionCalls(sessionDir);
    const agent: AgentRun = { ...result, sigs, seconds, ...(killed ? { killed } : {}) };
    fs.writeFileSync(path.join(workDir, 'fixture-state.json'), JSON.stringify(state, null, 2));
    fs.writeFileSync(path.join(workDir, 'agent.json'), JSON.stringify(agent, null, 2));
    return score({ task, model: m.label, calls, fixture: state, agent });
  } finally {
    await daemon?.stop().catch(() => { /* already down */ });
    await fixture.close().catch(() => { /* already closed */ });
    try { fs.rmSync(path.join(workDir, 'mcp.json'), { force: true }); } catch { /* not written */ }
  }
}

async function plan(o: Options): Promise<void> {
  const { run, skipped } = selectTasks(loadTasks(), o);
  const { found } = await detectModels();
  console.log(`clawdcursor benchmark: the plan for ${currentOs()} (nothing is started)\n`);
  console.log('Tasks:');
  for (const t of run) {
    const why = t.fixture.kind === 'app' ? await appUnavailable(t.fixture.app) : null;
    console.log(`  ${why ? 'skip' : 'run '} ${t.id.padEnd(26)} ${t.archetype.padEnd(22)} ${t.mechanisms.join(' ').padEnd(6)} oracle ${t.oracle.calls} calls / ${t.oracle.screenshots} shots${why ? `  (${why})` : ''}`);
  }
  for (const s of skipped) console.log(`  skip ${s.task.padEnd(26)} (${s.why})`);
  console.log('\nAgents:');
  for (const f of found) console.log(`  ${f.id.padEnd(12)} ${f.detail ?? 'not installed'}`);
  const browser = findBrowser();
  console.log(`\nBrowser: ${browser ? browser.exe : 'none found (web tasks are skipped)'}`);
  try { const c = await resolveCli(o.build); console.log(`clawdcursor: ${c.version} (${c.source})`); }
  catch (e) { console.log(`clawdcursor: ${(e as Error).message}`); }
  console.log('\nRun it with --live. A live run takes over the mouse and keyboard until it ends: do not use the computer meanwhile.');
}

async function live(o: Options): Promise<number> {
  const osName = currentOs();
  const { run, skipped } = selectTasks(loadTasks(), o);
  const models = o.models ? parseModels(o.models) : (await detectModels()).runs;
  if (!models.length) throw new Error(`no agent host found (${ADAPTERS.map(a => a.id).join(', ')})`);
  for (const m of models) if (!await m.adapter.detect()) throw new Error(`${m.adapter.id} is not installed`);
  // The daemon tries the default browser debug port when it starts: a browser there is the owner's own session.
  if (await portOpen(USER_CDP_PORT)) throw new Error(`a browser is listening on debug port ${USER_CDP_PORT}: clawdcursor would attach to it. Close it first.`);
  const { cli, version, source } = await resolveCli(o.build);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(o.out ?? path.join(os.tmpdir(), 'clawdcursor-bench', stamp));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-bench-run-'));
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`clawdcursor ${version} (${source}); ${run.length} task(s) x ${models.map(m => m.label).join(', ')}; results in ${outDir}`);
  const server = await startFixtureServer();
  const scores: Score[] = [];
  try {
    const native = run.some(t => t.fixture.kind === 'native') ? await buildNative(path.join(tempRoot, 'native')) : { missing: 'not needed' };
    const env: Env = { cli, server, native, outDir, tempRoot, pos: o.pos };
    let n = 0;
    for (const m of models) {
      for (const task of run) {
        process.stdout.write(`${m.label} ${task.id} ... `);
        try {
          const s = await runOne(task, m, env, ++n);
          if ('skip' in s) {
            if (!skipped.some(k => k.task === task.id)) skipped.push({ task: task.id, why: s.skip });
            console.log(`skipped (${s.skip})`);
            continue;
          }
          scores.push(s);
          console.log(`${s.manual ? 'manual' : s.success ? 'done' : 'NOT done'}, ${s.calls} calls, ${s.screenshots} shots, ${s.seconds}s`
            + `${s.killed ? `, stopped by the watchdog (${s.killed})` : ''}${s.gate.pass ? '' : `  [gate: ${s.gate.failures.join('; ')}]`}`);
          if (s.killed === 'privacy') throw new Error('PRIVACY: the agent acted outside the fixture windows. The run is stopped.');
        } catch (e) {
          if ((e as Error).message.startsWith('PRIVACY')) throw e;
          skipped.push({ task: task.id, why: `${m.label}: ${(e as Error).message}` });
          console.log(`error: ${(e as Error).message}`);
        }
      }
    }
  } finally {
    await server.close();
    try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* a temp dir */ }
    const report = buildReport({ date: new Date().toISOString(), os: osName, clawdcursor: version, models: models.map(m => m.label), skipped }, scores);
    const baselineFile = path.resolve(o.baseline ?? path.join(__dirname, 'baseline', `${osName}.json`));
    const base: Baseline | null = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : null;
    const md = renderMarkdown(report, base ? compare(report, base) : undefined);
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(outDir, 'report.md'), md);
    console.log(`\n${md}\n${base ? '' : `No baseline at ${baselineFile}: pass --update-baseline to write one.\n`}Report: ${path.join(outDir, 'report.md')}`);
    if (o.updateBaseline && scores.length) {
      fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
      fs.writeFileSync(baselineFile, JSON.stringify(toBaseline(report), null, 2) + '\n');
      console.log(`Baseline written: ${baselineFile}`);
    }
    process.exitCode = report.gate.pass ? 0 : 1;
  }
  return process.exitCode ?? 1;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  if (o.selfcheck) {
    const { selfcheckWeb, selfcheckNative, selfcheckIsolation } = await import('./lib/selfcheck');
    const results = [await selfcheckNative(), await selfcheckWeb(), await selfcheckIsolation(o.build)];
    process.exitCode = results.every(Boolean) ? 0 : 1;
    return;
  }
  if (o.live) await live(o);
  else await plan(o);
}

if (require.main === module) {
  main().catch(e => { console.error(`bench: ${(e as Error).message}`); process.exitCode = 2; });
}
