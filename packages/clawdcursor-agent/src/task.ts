/**
 * `clawdcursor task "<task>"`: an agent whose only tool is this clawdcursor does the task, and ends with PASS or FAIL.
 * By default the agent is the owner's own Claude Code or Codex, on their sign-in (subscription): no API key.
 * Exit code: 0 PASS, 1 FAIL or error, 130 Ctrl-C.
 */
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ANTHROPIC_DEFAULT_MODEL, runApi } from './api';
import { RUNNERS, apiKeyOf, readConfig, type AgentConfig, type Runner } from './config';
import { detectClaude, detectCodex, type CliStatus } from './detect';
import { killTree, runCli, type CliCommand } from './hosts';
import { newRunId, openRunLog, sessionOfRun, sessionsDir, withoutImages } from './runlog';
import { claudeMcpConfig, claudeTaskCommand, codexTaskCommand, displayCommand, mcpEntry } from './runners';
import { claudeEvents, codexEvents, elapsed, paint, renderEvent, verdictOf, type TraceEvent } from './trace';

/** What clawdcursor core hands its add-ons. */
export interface CoreContext {
  coreVersion: string;
  /** The running clawdcursor's CLI file, started with `node` as the agent's MCP server. */
  coreEntry: string;
  node: string;
  /** ~/.clawdcursor */
  dataDir: string;
}

export interface TaskOptions { task: string; with?: string; model?: string; granular?: boolean }
export interface TaskResult { exitCode: number; verdict: 'PASS' | 'FAIL' | null; runId: string | null; runFile: string | null; session: string | null; finalText: string; reason?: string }
export interface TaskIo { out?(line: string): void; color?: boolean }

type Detect = { claude(): Promise<CliStatus>; codex(): Promise<CliStatus> };
const DETECT: Detect = { claude: detectClaude, codex: detectCodex };

/** Which runner: --with, else the one doctor --setup picked, else the installed and signed-in CLI (claude first). */
export async function resolveRunner(want: string | undefined, cfg: AgentConfig, detect: Detect = DETECT): Promise<{ runner: Runner; cli?: CliStatus } | { error: string }> {
  const name = want ?? cfg.runner;
  if (name !== undefined && !(RUNNERS as readonly string[]).includes(name)) return { error: `Unknown runner "${name}": use one of ${RUNNERS.join(', ')}.` };
  if (name === 'anthropic' || name === 'openai-compatible') return { runner: name };
  if (name === 'claude' || name === 'codex') {
    const cli = await detect[name]();
    return cli.exe && cli.signedIn !== false ? { runner: name, cli } : { error: cli.fix ?? `${name} cannot run.` };
  }
  const claude = await detect.claude();
  if (claude.exe && claude.signedIn !== false) return { runner: 'claude', cli: claude };
  const codex = await detect.codex();
  if (codex.exe && codex.signedIn !== false) return { runner: 'codex', cli: codex };
  return { error: `No signed-in agent CLI found. ${claude.fix ?? ''} Or use Codex (\`codex login\`), or set up an API runner: \`clawdcursor doctor --setup\`.`.replace(/\s+/g, ' ') };
}

export async function runTask(opts: TaskOptions, ctx: CoreContext, io: TaskIo = {}): Promise<TaskResult> {
  const out = io.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const p = paint(io.color ?? (process.stdout.isTTY === true && !process.env.NO_COLOR));
  const fail = (reason: string): TaskResult => { out(p.red(reason)); return { exitCode: 1, verdict: null, runId: null, runFile: null, session: null, finalText: '', reason }; };

  const cfg = readConfig(ctx.dataDir);
  const picked = await resolveRunner(opts.with, cfg);
  if ('error' in picked) return fail(picked.error);
  const { runner } = picked;
  let model = opts.model ?? (runner === cfg.runner ? cfg.model : undefined);
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  if (runner === 'anthropic') {
    model ??= cfg.anthropic?.model ?? ANTHROPIC_DEFAULT_MODEL;
    apiKey = apiKeyOf(cfg.anthropic, 'ANTHROPIC_API_KEY');
    if (!apiKey) return fail('--with anthropic needs an API key: set ANTHROPIC_API_KEY, or store one with `clawdcursor doctor --setup`.');
  } else if (runner === 'openai-compatible') {
    model ??= cfg.openaiCompatible?.model;
    if (!model) return fail('--with openai-compatible needs a model: pass --model, or set one with `clawdcursor doctor --setup`.');
    baseUrl = cfg.openaiCompatible?.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    apiKey = apiKeyOf(cfg.openaiCompatible, 'OPENAI_API_KEY');   // a local server (Ollama, LM Studio) needs none
  }

  const started = Date.now();
  const runId = newRunId(new Date(started));
  const log = openRunLog(ctx.dataDir, runId);
  const entry = mcpEntry({ node: ctx.node, coreEntry: ctx.coreEntry, runId, granular: opts.granular });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-task-'));   // an empty cwd: no CLAUDE.md / AGENTS.md of the owner's
  const who = runner === 'claude' || runner === 'codex' ? runner : 'model';

  let finalText = '';
  let finalError = false;
  let serverState: string | undefined;
  let lastText = '';
  const show = (ev: TraceEvent) => {
    if (ev.kind === 'start') serverState = ev.server;
    if (ev.kind === 'text') lastText = ev.text;
    if (ev.kind === 'final') { finalText = ev.text; finalError = ev.error === true; }
    const line = renderEvent(ev, p, who);
    if (line) out(`${p.dim(elapsed(Date.now() - started))}  ${line}`);
  };

  out(`${p.bold('clawdcursor task')} · ${runner}${model ? ` · ${model}` : ''} · ${opts.granular ? 'granular' : 'compact'} tools · run ${runId}`);
  out(p.dim(`task: ${opts.task}`));

  // Ctrl-C: let the agent stop (it got the same Ctrl-C on a shared console, or SIGINT here), then stop its whole tree.
  let interrupted = false;
  let child: ChildProcess | null = null;
  const abort = new AbortController();
  const onSigint = () => {
    if (interrupted) { killTree(child?.pid); return; }
    interrupted = true;
    out(p.red('stopping (Ctrl-C)…'));
    log.write({ type: 'interrupted' });
    if (child?.pid) {
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGINT'); } catch { /* gone */ } }
      const pid = child.pid;
      setTimeout(() => killTree(pid), 1500).unref();
    }
    abort.abort();
  };
  process.on('SIGINT', onSigint);

  let exitCode: number | null = null;
  let stderrTail = '';
  let command: CliCommand | null = null;
  try {
    if (runner === 'claude' || runner === 'codex') {
      const exe = picked.cli!.exe!;
      const lastMessagePath = path.join(workDir, 'last-message.txt');
      if (runner === 'claude') {
        const mcpConfigPath = path.join(workDir, 'mcp.json');
        fs.writeFileSync(mcpConfigPath, claudeMcpConfig(entry), { flag: 'wx', mode: 0o600 });
        command = claudeTaskCommand({ exe, model, mcpConfigPath, task: opts.task });
      } else {
        command = codexTaskCommand({ exe, model, entry, workDir, lastMessagePath, task: opts.task });
      }
      log.write({ type: 'run', id: runId, task: opts.task, runner, model: model ?? null, command: displayCommand(command), coreVersion: ctx.coreVersion,
        surface: opts.granular ? 'granular' : 'compact' });
      const parseLine = runner === 'claude' ? claudeEvents : codexEvents;
      exitCode = await runCli(command, {
        cwd: workDir,
        signal: new AbortController().signal,   // Ctrl-C is handled above: a grace period, then the tree
        onChild: c => { child = c; },
        onLine: line => {
          let data: unknown = line;
          try { data = withoutImages(JSON.parse(line)); } catch { /* not JSON: kept as text */ }
          log.write({ type: 'event', src: runner, data });
          for (const ev of parseLine(line)) show(ev);
        },
        onErr: text => { log.write({ type: 'stderr', text }); stderrTail = (stderrTail + text).slice(-2000); },
      });
      if (runner === 'codex') {
        try { finalText = fs.readFileSync(lastMessagePath, 'utf8').trim() || lastText; } catch { finalText = lastText; }
      }
    } else {
      log.write({ type: 'run', id: runId, task: opts.task, runner, model, baseUrl: baseUrl ?? null, coreVersion: ctx.coreVersion,
        surface: opts.granular ? 'granular' : 'compact' });
      const emit = (ev: TraceEvent) => { log.write({ type: 'event', src: 'api', data: withoutImages(ev) }); show(ev); };
      const r = await runApi({ kind: runner, model: model!, apiKey, baseUrl, entry, task: opts.task, emit, signal: abort.signal });
      finalText = r.text;
      if (r.error) { emit({ kind: 'error', text: r.error }); finalError = true; }
      exitCode = r.error ? 1 : 0;
    }
  } catch (e) {
    if (!interrupted) { const text = (e as Error).message; show({ kind: 'error', text }); log.write({ type: 'error', text }); }
  } finally {
    process.removeListener('SIGINT', onSigint);
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 2 });
  }

  const verdict = interrupted ? null : verdictOf(finalText);
  let reason: string | undefined;
  if (interrupted) reason = 'stopped with Ctrl-C';
  else if (serverState && serverState !== 'connected') reason = `the clawdcursor MCP server did not connect (${serverState})`;
  else if (!verdict && !finalText && command) reason = `${runner} exited with code ${exitCode}${stderrTail.trim() ? `: ${stderrTail.trim().split('\n').slice(-3).join(' ').slice(0, 300)}` : ''}`;
  else if (!verdict) reason = finalError ? 'the agent ended with an error' : 'the agent gave no PASS/FAIL line';
  const code = interrupted ? 130 : verdict === 'PASS' ? 0 : 1;
  const session = sessionOfRun(sessionsDir(ctx.dataDir), runId, started);
  log.write({ type: 'end', verdict, exitCode: code, agentExitCode: exitCode, ...(reason ? { reason } : {}), ...(session ? { session: session.id } : {}), ms: Date.now() - started });

  const tag = verdict === 'PASS' ? p.green(p.bold('PASS')) : verdict === 'FAIL' ? p.red(p.bold('FAIL')) : p.red(p.bold(interrupted ? 'STOPPED' : 'NO VERDICT'));
  const last = finalText.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';
  out('');
  out(`${tag}  ${verdict ? last.replace(/^[\s*_`>#"'-]*(?:verdict:\s*)?(PASS|FAIL)\b[:\s-]*/i, '') : reason ?? ''}`);
  out(p.dim(`run log ${log.file}${session ? ` · clawdcursor session ${session.id}` : ''} · ${((Date.now() - started) / 1000).toFixed(1)} s · clawdcursor logs --run ${runId}`));
  return { exitCode: code, verdict, runId, runFile: log.file, session: session?.id ?? null, finalText, ...(reason ? { reason } : {}) };
}
