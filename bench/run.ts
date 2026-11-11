/**
 * The clawdcursor benchmark runner (issue #384). See bench/README.md.
 *
 *   npm run bench                    the plan: what would run here. Starts nothing.
 *   npm run bench -- --selfcheck     proves fixtures, predicates, isolation and the fence. No agent, no window.
 *   npm run bench -- --live [...]    runs the tasks. TAKES OVER THE MOUSE AND KEYBOARD until it ends.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ADAPTERS, detectModels, parseModels, preflightAll, type ModelRun } from './lib/adapters';
import { setAgentBin } from './lib/adapters/common';
import { findBrowser } from './lib/browser';
import { Cleanup } from './lib/cleanup';
import { startFixtureServer, type FixtureServer } from './lib/fixture-server';
import { probeMcp, resolveCli, startIsolated } from './lib/isolated';
import { appUnavailable, buildNative, openFixture, type FixtureContext, type NativeBuild } from './lib/live-fixtures';
import { USER_CDP_PORT, cdpIsFixture, ownsFocus, portOpen, readFocus } from './lib/ownership';
import { execFileSync } from 'child_process';
import { freePort, sleep, system32 } from './lib/proc';
import { buildPrompt } from './lib/prompt';
import { aggregate, buildReport, compare, renderMarkdown, score, toBaseline, type Baseline, type Score } from './lib/scorer';
import { currentOs, loadTasks } from './lib/tasks';
import { Watchdog, readSessionCalls, tailSessionDir, type Verdict } from './lib/watchdog';
import type { AgentRun, CallSig, TaskSpec } from './lib/types';

export interface Options {
  live: boolean; selfcheck: boolean; includeManual: boolean; updateBaseline: boolean; repeats: number;
  build?: string; models?: string; tasks?: string[]; out?: string; baseline?: string; claudeBin?: string; codexBin?: string;
}

export function parseArgs(argv: string[]): Options {
  const o: Options = { live: false, selfcheck: false, includeManual: false, updateBaseline: false, repeats: 1 };
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
    else if (a === '--claude-bin') o.claudeBin = value();
    else if (a === '--codex-bin') o.codexBin = value();
    else if (a === '--repeats') {
      o.repeats = Number(value());
      if (!Number.isInteger(o.repeats) || o.repeats < 1 || o.repeats > 9) throw new Error('--repeats needs a number from 1 to 9');
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

/** A task whose scripted trajectory needs a screenshot cannot be done by a model that is shown no images. */
export const needsImages = (t: TaskSpec) => t.oracle.screenshots > 0;

/** Why this model does not run this task (it is then "n/a", not failed), or null. */
export function notApplicable(t: TaskSpec, m: Pick<ModelRun, 'label'> & { adapter: { seesImages: boolean } }): string | null {
  return needsImages(t) && !m.adapter.seesImages ? `n/a for ${m.label}: the task needs a screenshot and this model is shown no images` : null;
}

/**
 * The results directory must be new or empty: session logs and state files left by an earlier run would be read back
 * as this run's.
 */
export function prepareOutDir(dir?: string): string {
  // No --out: a new private directory (0700, a name nobody can guess) under the temp directory.
  if (dir === undefined) return fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-bench-'));
  const out = path.resolve(dir);
  try { fs.mkdirSync(out, { recursive: true, mode: 0o700 }); }   // a no-op when it is there
  catch { throw new Error(`${out} is not a directory that can be used for results. Give --out a new directory.`); }
  // Read once: what is in it now is what the refusal is about.
  if (fs.readdirSync(out).length) {
    throw new Error(`${out} is not empty: results of an earlier run could be read back as this one's. Give --out a new directory.`);
  }
  return out;
}

/** A new file in a directory of this run: never over an existing one, readable by the current user only. */
const writeNew = (file: string, text: string) => fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });

/**
 * The files the RUNNER writes into a task's results directory, once each, at the end of the task. Nothing else writes
 * these names: the native fixture's own live state file has another one (nativeStatePath).
 */
export const RESULT_FILES = { state: 'fixture-state.json', agent: 'agent.json' } as const;

export function writeTaskResults(workDir: string, state: unknown, agent: AgentRun): void {
  writeNew(path.join(workDir, RESULT_FILES.state), JSON.stringify(state, null, 2));
  writeNew(path.join(workDir, RESULT_FILES.agent), JSON.stringify(agent, null, 2));
}

/** The baseline to compare with, or null when there is none yet: one read, no "does it exist" first. */
export function readBaseline(file: string): Baseline | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

/**
 * Where the agents run: a new directory with nothing of the owner's in it or above it, so no CLAUDE.md, AGENTS.md or
 * project settings load. The temp directory is inside the home directory on Windows; the Public folder is not.
 */
export function agentRoot(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  // mkdtemp makes a new directory with a name nobody can guess (0700 on macOS and Linux). No Public folder: the temp directory.
  let dir: string;
  try { dir = fs.mkdtempSync(path.join(platform === 'win32' && env.PUBLIC ? env.PUBLIC : os.tmpdir(), 'clawdcursor-bench-agent-')); }
  catch { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-bench-agent-')); }
  // It holds the MCP config with the daemon's bearer token, and the Public folder is readable by every account: on
  // Windows the directory is cut off from inherited permissions and given to the current user alone.
  if (platform === 'win32') {
    try {
      const me = execFileSync(system32('whoami.exe'), { encoding: 'utf8' }).trim();
      execFileSync(system32('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `${me}:(OI)(CI)F`], { stdio: 'ignore' });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`could not make the agents' directory private (icacls): ${(e as Error).message}`);
    }
  }
  return dir;
}

interface Env {
  cli: string; server: FixtureServer; native: NativeBuild | { missing: string }; outDir: string; tempRoot: string; agentRoot: string;
  cleanup: Cleanup;
}

/** One task with one model: fixture, fenced isolated server, agent under the watchdog, then the score. */
async function runOne(task: TaskSpec, m: ModelRun, env: Env, n: number, repeat: number): Promise<Score | { skip: string }> {
  const workDir = path.join(env.outDir, m.label.replace(/[^A-Za-z0-9._-]/g, '_'), repeat ? `${task.id}.${repeat + 1}` : task.id);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const ctx: FixtureContext = { server: env.server, browser: findBrowser(), native: env.native, workDir, runId: `r${n}-${task.id}`.slice(0, 64) };
  const fixture = await openFixture(task, ctx);
  if ('skip' in fixture) return fixture;
  const fixtureClosed = env.cleanup.add(() => fixture.close());
  const sessionDir = path.join(workDir, 'sessions');
  const agentDir = path.join(env.agentRoot, `run-${n}`);
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  let daemon: Awaited<ReturnType<typeof startIsolated>> | undefined;
  let daemonClosed = () => { /* not started */ };
  try {
    // clawdcursor's browser port: the fixture browser's. For a task with no browser, a free port nothing listens on.
    const cdpPort = fixture.cdp?.cdpPort ?? await freePort();
    // The fence: the daemon itself refuses, before acting or reading, whatever is outside the fixture's processes.
    const fencePids = await fixture.roots();
    daemon = await startIsolated({ cli: env.cli, home: path.join(env.tempRoot, `home-${n}`), sessionDir, cdpPort, fencePids, logFile: path.join(workDir, 'server.log') });
    const started0 = daemon;
    daemonClosed = env.cleanup.add(() => started0.kill());
    // The second layer, after the fact: the watchdog's proofs (the focus is in a process this task started; CDP can only reach its browser).
    const cdp = fixture.cdp;
    const proveCdp = async () => cdp !== undefined && await cdpIsFixture({ ...cdp, browserPids: fixture.roots });
    let cdpProven = await proveCdp();
    const cdpClock = setInterval(() => { proveCdp().then(ok => { cdpProven = ok; }, () => { cdpProven = false; }); }, 5000);
    const dog = new Watchdog({ maxCalls: task.caps.calls, maxSeconds: task.caps.seconds, fixtureApps: fixture.apps }, {
      ownsFocus: async () => ownsFocus(await readFocus(), await fixture.roots(), fixture.frameTitle),
      cdpIsFixture: () => cdpProven,
    });
    const abort = new AbortController();
    const agentStopped = env.cleanup.add(() => abort.abort());
    let killed: Verdict | undefined;
    const stop = (v: Verdict | null) => { if (v && !killed) { killed = v; abort.abort(); } };
    const sigs: CallSig[] = [];
    const started = Date.now();
    // One line at a time, in order: the privacy proofs of a line finish before the next line is judged.
    let judging: Promise<void> = Promise.resolve();
    const stopTail = tailSessionDir(sessionDir, c => { judging = judging.then(async () => stop(await dog.judge(c))).catch(() => undefined); });
    const clock = setInterval(() => stop(dog.onTime((Date.now() - started) / 1000)), 500);
    let result: { finalText: string; exitCode: number | null; serverUnreachable?: string } = { finalText: '', exitCode: null };
    // Whatever the agent host is: can clawdcursor be reached at all? If not, the agent is not started, and the row is a
    // clawdcursor failure (never an "agent error").
    const unreachable = await probeMcp(daemon.mcpUrl, daemon.token);
    try {
      if (unreachable) result = { finalText: '', exitCode: null, serverUnreachable: unreachable };
      else result = await m.adapter.run({ prompt: buildPrompt(task, fixture.window), model: m.model, mcpUrl: daemon.mcpUrl, token: daemon.token,
        workDir: agentDir, logFile: path.join(workDir, 'agent.log'), signal: abort.signal, onSig: s => { sigs.push(s); stop(dog.onSig(s)); } });
    } catch (e) {
      result.finalText = `adapter error: ${(e as Error).message}`;
    } finally {
      clearInterval(clock);
      clearInterval(cdpClock);
      stopTail();
      agentStopped();
    }
    await judging;   // the last calls are judged before the score is written
    // An agent that made no call and did not say why: ask the daemon again before calling it the agent's fault.
    if (!result.serverUnreachable && !killed && !sigs.length && !readSessionCalls(sessionDir).length) {
      const now = await probeMcp(daemon.mcpUrl, daemon.token);
      if (now) result.serverUnreachable = now;
    }
    const seconds = (Date.now() - started) / 1000;
    await sleep(1500);   // a late effect still reaches the fixture's recorder
    const state = await fixture.state();
    const calls = readSessionCalls(sessionDir);
    const agent: AgentRun = { ...result, sigs, seconds, ...(killed ? { killed } : {}) };
    writeTaskResults(workDir, state, agent);
    return score({ task, model: m.label, calls, fixture: state, agent });
  } finally {
    await daemon?.stop().catch(() => { /* already down */ });
    daemonClosed();
    await fixture.close().catch(() => { /* already closed */ });
    fixtureClosed();
    try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch { /* removed with the agent root */ }
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
  for (const f of found) {
    const a = ADAPTERS.find(x => x.id === f.id);
    console.log(`  ${f.id.padEnd(12)} ${f.detail ?? f.why ?? 'not installed'}${f.detail && a && !a.seesImages ? '  (no images: screenshot tasks are n/a)' : ''}`);
  }
  const browser = findBrowser();
  console.log(`\nBrowser: ${browser ? browser.exe : 'none found (web tasks are skipped)'}`);
  try { const c = await resolveCli(o.build); console.log(`clawdcursor: ${c.version} (${c.source})`); }
  catch (e) { console.log(`clawdcursor: ${(e as Error).message}`); }
  console.log('\nRun it with --live. A live run takes over the mouse and keyboard until it ends: do not use the computer meanwhile.');
}

async function live(o: Options): Promise<void> {
  const osName = currentOs();
  const { run, skipped } = selectTasks(loadTasks(), o);
  const models = o.models ? parseModels(o.models) : (await detectModels()).runs;
  if (!models.length) throw new Error(`no agent host found (${ADAPTERS.map(a => a.id).join(', ')})`);
  for (const m of models) if (!await m.adapter.detect()) throw new Error(`${m.adapter.id}: ${m.adapter.why?.() ?? 'not installed'}`);
  // The daemon tries the default browser debug port when it starts: a browser there is the owner's own session.
  if (await portOpen(USER_CDP_PORT)) throw new Error(`a browser is listening on debug port ${USER_CDP_PORT}: clawdcursor would attach to it. Close it first.`);
  const { cli, version, source } = await resolveCli(o.build);
  const outDir = prepareOutDir(o.out);
  // Everything a run starts is registered here: Ctrl+C, a kill or a crash closes it all before the process exits.
  const cleanup = new Cleanup();
  const uninstall = cleanup.install();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-bench-run-'));
  const agents = agentRoot();
  const removeTemp = () => {
    for (const dir of [tempRoot, agents]) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* a temp dir */ } }
  };
  cleanup.add(removeTemp);
  // Before anything opens on the desktop: can each agent run at all? One trivial prompt each, no tools.
  process.stdout.write('Checking the agents ... ');
  const stopPreflight = new AbortController();
  const preflightStopped = cleanup.add(() => stopPreflight.abort());
  const cannotRun = await preflightAll(models, label => {
    const dir = path.join(agents, `preflight-${label.replace(/[^A-Za-z0-9._-]/g, '_')}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }, stopPreflight.signal);
  preflightStopped();
  if (cannotRun.length) {
    console.log('failed');
    await cleanup.runAll();
    uninstall();
    throw new Error(`no task was run, because an agent cannot run:\n  ${cannotRun.join('\n  ')}`);
  }
  console.log('ok');
  console.log(`clawdcursor ${version} (${source}); ${run.length} task(s) x ${models.map(m => m.label).join(', ')}${o.repeats > 1 ? ` x ${o.repeats} repeats` : ''}; results in ${outDir}`);
  const server = await startFixtureServer();
  cleanup.add(() => server.close());
  const scores: Score[] = [];
  try {
    const native = run.some(t => t.fixture.kind === 'native') ? await buildNative(path.join(tempRoot, 'native')) : { missing: 'not needed' };
    const env: Env = { cli, server, native, outDir, tempRoot, agentRoot: agents, cleanup };
    let n = 0;
    for (const m of models) {
      for (const task of run) {
        const na = notApplicable(task, m);
        if (na) { skipped.push({ task: task.id, why: na }); console.log(`${m.label} ${task.id} ... n/a`); continue; }
        const repeats: Score[] = [];
        for (let repeat = 0; repeat < o.repeats; repeat++) {
          process.stdout.write(`${m.label} ${task.id}${o.repeats > 1 ? ` (${repeat + 1}/${o.repeats})` : ''} ... `);
          try {
            const s = await runOne(task, m, env, ++n, repeat);
            if ('skip' in s) {
              if (!skipped.some(k => k.task === task.id && k.why === s.skip)) skipped.push({ task: task.id, why: s.skip });
              console.log(`skipped (${s.skip})`);
              break;
            }
            repeats.push(s);
            console.log(`${s.serverError ? `CLAWDCURSOR UNREACHABLE (${s.serverError})` : s.agentError ? `AGENT ERROR (${s.agentError})` : s.manual ? 'manual' : s.success ? 'done' : 'NOT done'}, ${s.calls} calls, ${s.screenshots} shots, ${s.seconds}s`
              + `${s.killed ? `, stopped by the watchdog (${s.killed})` : ''}${s.gate.pass ? '' : `  [gate: ${s.gate.failures.join('; ')}]`}`);
            if (s.killed === 'privacy') throw new Error('PRIVACY: the agent acted outside the fixture windows. The run is stopped.');
          } catch (e) {
            if ((e as Error).message.startsWith('PRIVACY')) { if (repeats.length) scores.push(aggregate(repeats)); throw e; }
            skipped.push({ task: task.id, why: `${m.label}: ${(e as Error).message}` });
            console.log(`error: ${(e as Error).message}`);
            break;
          }
        }
        if (repeats.length) scores.push(aggregate(repeats));
      }
    }
  } finally {
    await cleanup.runAll();
    uninstall();
    const report = buildReport({ date: new Date().toISOString(), os: osName, clawdcursor: version, models: models.map(m => m.label), skipped }, scores);
    const baselineFile = path.resolve(o.baseline ?? path.join(__dirname, 'baseline', `${osName}.json`));
    const base = readBaseline(baselineFile);
    const md = renderMarkdown(report, base ? compare(report, base) : undefined);
    writeNew(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    writeNew(path.join(outDir, 'report.md'), md);
    console.log(`\n${md}\n${base ? '' : `No baseline at ${baselineFile}: pass --update-baseline to write one.\n`}Report: ${path.join(outDir, 'report.md')}`);
    if (o.updateBaseline && report.gate.status === 'INCOMPLETE') console.log('No baseline written: the run is INCOMPLETE.');
    else if (o.updateBaseline && scores.length) {
      fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
      fs.writeFileSync(baselineFile, JSON.stringify(toBaseline(report), null, 2) + '\n');
      console.log(`Baseline written: ${baselineFile}`);
    }
    // 0: the gate passes. 1: it fails. 3: incomplete (an agent host failed, or nothing was measured).
    process.exitCode = report.gate.status === 'PASS' ? 0 : report.gate.status === 'FAIL' ? 1 : 3;
  }
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  if (o.claudeBin) setAgentBin('claude', o.claudeBin);
  if (o.codexBin) setAgentBin('codex', o.codexBin);
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
