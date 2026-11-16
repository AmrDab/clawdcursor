/**
 * `clawdcursor doctor --setup`: sets up the test agent behind `clawdcursor task`.
 *   1. finds Claude Code and Codex, and whether each is signed in (and how, when the CLI says);
 *   2. picks the default runner and model;
 *   3. optionally adds an API runner: the key typed as stars and stored owner-only, or the name of the variable holding it;
 *   4. a test call that does nothing on the desktop: the agent asks clawdcursor for the system time.
 */
import * as path from 'path';
import { ask, askSecret, yesNo } from './prompt';
import { writePrivateJson } from './store';

/** The parts of clawdcursor-agent (same version) that setup uses. Core loads it and passes it in. */
export interface CliStatus { id: 'claude' | 'codex'; exe: string | null; version: string | null; signedIn: boolean | null; detail: string | null; fix: string | null }
type Runner = 'claude' | 'codex' | 'anthropic' | 'openai-compatible';
interface ApiKeySource { apiKey?: string; apiKeyEnv?: string }
export interface AgentConfig { runner?: Runner; model?: string; anthropic?: ApiKeySource & { model?: string }; openaiCompatible?: ApiKeySource & { baseUrl?: string; model?: string } }
export interface AgentApi {
  detectClaude(): Promise<CliStatus>;
  detectCodex(): Promise<CliStatus>;
  readConfig(dataDir: string): AgentConfig;
  configPath(dataDir: string): string;
  ANTHROPIC_DEFAULT_MODEL: string;
  runTask(opts: { task: string; with?: string; model?: string }, ctx: CoreContext): Promise<{ exitCode: number; verdict: 'PASS' | 'FAIL' | null; reason?: string }>;
}
export interface CoreContext { coreVersion: string; coreEntry: string; node: string; dataDir: string }
export interface SetupContext extends CoreContext { agent: AgentApi; hasConsent(): boolean }

/** The test call's task: one read-only tool call. */
export const TEST_TASK = 'Call clawdcursor\'s system tool with action "system_time" (on the granular surface the tool is get_system_time) '
  + 'and report the time it returns. Do nothing else on this computer: no other tool call.';

const out = (l = '') => process.stdout.write(`${l}\n`);

function cliLine(s: CliStatus): string {
  if (!s.exe) return `  ${s.id.padEnd(7)} not found · ${s.fix ?? ''}`;
  const state = s.signedIn === true ? `signed in${s.detail ? ` (${s.detail})` : ''}` : s.signedIn === false ? 'NOT signed in' : 'sign-in unknown';
  return `  ${s.id.padEnd(7)} ${s.version ?? 'version unknown'} · ${state}${s.fix ? ` · ${s.fix}` : ''}`;
}

async function keySource(label: string, envName: string, optional: boolean): Promise<ApiKeySource> {
  const choices = optional ? '1) store it in agent.json  2) read it from an environment variable  3) none (a local server)' : '1) store it in agent.json  2) read it from an environment variable';
  out(`  ${label} key: ${choices}`);
  const pick = (await ask(`  Key [2]: `)) || '2';
  if (pick === '3' && optional) return {};
  if (pick === '1') {
    const apiKey = await askSecret('  Paste the key (shown as *): ');
    return apiKey ? { apiKey } : {};
  }
  const name = (await ask(`  Variable name [${envName}]: `)) || envName;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { out(`  "${name}" is not a variable name: using ${envName}.`); return { apiKeyEnv: envName }; }
  if (!process.env[name]) out(`  (${name} is not set in this shell: set it before \`clawdcursor task --with ${label === 'Anthropic' ? 'anthropic' : 'openai-compatible'}\`.)`);
  return { apiKeyEnv: name };
}

async function anthropicSettings(agent: AgentApi, prev?: AgentConfig['anthropic']): Promise<NonNullable<AgentConfig['anthropic']>> {
  const model = (await ask(`  Anthropic model [${prev?.model ?? agent.ANTHROPIC_DEFAULT_MODEL}]: `)) || prev?.model || agent.ANTHROPIC_DEFAULT_MODEL;
  return { model, ...(await keySource('Anthropic', 'ANTHROPIC_API_KEY', false)) };
}

async function openaiSettings(prev?: AgentConfig['openaiCompatible']): Promise<NonNullable<AgentConfig['openaiCompatible']>> {
  out('  Any /chat/completions endpoint: OpenAI https://api.openai.com/v1, Ollama http://localhost:11434/v1,');
  out('  LM Studio http://localhost:1234/v1, OpenRouter https://openrouter.ai/api/v1.');
  const baseUrl = (await ask(`  Base URL [${prev?.baseUrl ?? 'https://api.openai.com/v1'}]: `)) || prev?.baseUrl || 'https://api.openai.com/v1';
  let model = '';
  while (!model) model = (await ask(`  Model${prev?.model ? ` [${prev.model}]` : ''}: `)) || prev?.model || '';
  return { baseUrl, model, ...(await keySource('OpenAI-compatible', 'OPENAI_API_KEY', true)) };
}

export async function runSetup(ctx: SetupContext): Promise<number> {
  const { agent } = ctx;
  out('\n🧪 Test agent setup (clawdcursor task)\n');
  out('Agent CLIs on this computer:');
  const [claude, codex] = await Promise.all([agent.detectClaude(), agent.detectCodex()]);
  out(cliLine(claude));
  out(cliLine(codex));
  out('');

  const prev = agent.readConfig(ctx.dataDir);
  const runners: Array<{ id: Runner; what: string; ok: boolean }> = [
    { id: 'claude', what: 'your Claude Code sign-in, no API key', ok: !!claude.exe && claude.signedIn !== false },
    { id: 'codex', what: 'your Codex sign-in, no API key', ok: !!codex.exe && codex.signedIn !== false },
    { id: 'anthropic', what: 'an Anthropic API key', ok: true },
    { id: 'openai-compatible', what: 'OpenAI, Ollama, LM Studio, OpenRouter: base URL + key + model', ok: true },
  ];
  out('Runners:');
  runners.forEach((r, i) => out(`  ${i + 1}) ${r.id.padEnd(18)} ${r.what}${r.ok ? '' : ' (not available here)'}`));
  const def = Math.max(1, runners.findIndex(r => r.id === prev.runner) + 1 || runners.findIndex(r => r.ok) + 1);
  let n = 0;
  while (!(n >= 1 && n <= runners.length)) n = Number((await ask(`Default runner [${def}]: `)) || def);
  const runner = runners[n - 1].id;
  if (!runners[n - 1].ok) out(`  ${runner} is not ready yet: ${(runner === 'claude' ? claude : codex).fix ?? ''}`);

  const cfg: AgentConfig = { ...prev, runner };
  delete cfg.model;
  if (runner === 'claude' || runner === 'codex') {
    const keep = prev.runner === runner && prev.model ? prev.model : '';
    const model = (await ask(`Model (Enter = ${keep || `${runner}'s own default`}): `)) || keep;
    if (model) cfg.model = model;
    if (await yesNo('Also add an API runner (for --with anthropic / --with openai-compatible)?')) {
      const which = (await ask('  1) anthropic  2) openai-compatible [1]: ')) || '1';
      if (which === '2') cfg.openaiCompatible = await openaiSettings(prev.openaiCompatible);
      else cfg.anthropic = await anthropicSettings(agent, prev.anthropic);
    }
  } else if (runner === 'anthropic') cfg.anthropic = await anthropicSettings(agent, prev.anthropic);
  else cfg.openaiCompatible = await openaiSettings(prev.openaiCompatible);

  const file = agent.configPath(ctx.dataDir);
  try { writePrivateJson(file, cfg); }
  catch (e) { out(`❌ ${(e as Error).message}`); return 1; }
  out(`\nSaved ${file.replace(path.dirname(ctx.dataDir), '~')} (only you can read it).`);

  if (!ctx.hasConsent()) {
    out('Skipping the test call: clawdcursor needs your one-time consent first. Run `clawdcursor consent`, then `clawdcursor doctor --setup`.');
    return 1;
  }
  out('\nTest call: the agent asks clawdcursor for the system time. Nothing on the desktop is touched.\n');
  const r = await agent.runTask({ task: TEST_TASK, with: runner, ...(cfg.model ? { model: cfg.model } : {}) }, ctx);
  out(r.verdict === 'PASS'
    ? '\n✅ The test agent works. Try: clawdcursor task "Open a text editor and type hello"'
    : `\n❌ The test call did not pass${r.reason ? `: ${r.reason}` : ''}. Fix that, then run \`clawdcursor doctor --setup\` again.`);
  return r.exitCode;
}
