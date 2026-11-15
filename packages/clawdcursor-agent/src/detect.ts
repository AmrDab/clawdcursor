/** Is Claude Code / Codex installed here, and signed in? Asked of the CLIs themselves; nothing is changed. */
import { execFile } from 'child_process';
import * as os from 'os';
import { codexAppBinary, findShim, hostSessionEnv, which } from './hosts';

export interface CliStatus {
  id: 'claude' | 'codex';
  /** The native binary, when there is one. */
  exe: string | null;
  version: string | null;
  /** true / false when the CLI said; null when it could not be asked. */
  signedIn: boolean | null;
  /** How it is signed in, as the CLI reports it (e.g. "claude.ai, max" or "Logged in using ChatGPT"). Never the account's email. */
  detail: string | null;
  /** The one-line next step when it cannot run a task. */
  fix: string | null;
}

/** Run a program by argument array (no shell) and return what it printed; null when it is missing or timed out. */
export function capture(cmd: string, args: string[], o: { unsetEnv?: string[]; timeoutMs?: number } = {}): Promise<{ code: number; out: string } | null> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of o.unsetEnv ?? []) delete env[k];
  return new Promise(resolve => {
    execFile(cmd, args, { env, timeout: o.timeoutMs ?? 20_000, windowsHide: true, cwd: os.tmpdir(), shell: false }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean }) | null;
      if (e && (typeof e.code === 'string' || e.killed)) return resolve(null);   // not found, or timed out
      resolve({ code: e ? Number(e.code ?? 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

/** `claude auth status --json` -> signed in, and how (auth method, subscription when it reports one). */
export function parseClaudeAuth(out: string): { signedIn: boolean | null; detail: string | null } {
  const start = out.indexOf('{');
  if (start < 0) return { signedIn: null, detail: null };
  try {
    const s = JSON.parse(out.slice(start)) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; apiProvider?: string };
    const detail = [s.authMethod, s.subscriptionType ? `${s.subscriptionType} subscription` : null, s.apiProvider && s.apiProvider !== 'firstParty' ? s.apiProvider : null]
      .filter(Boolean).join(', ');
    return { signedIn: s.loggedIn === true, detail: detail || null };
  } catch { return { signedIn: null, detail: null }; }
}

export async function detectClaude(): Promise<CliStatus> {
  const exe = which('claude');
  if (!exe) {
    const shim = findShim('claude');
    return { id: 'claude', exe: null, version: null, signedIn: null, detail: null,
      fix: shim ? `Only an npm launcher (${shim}) was found: run \`claude install\` once for the native build.`
        : 'Claude Code is not installed: install it (https://claude.com/claude-code), then run `claude` once and sign in.' };
  }
  const unsetEnv = hostSessionEnv();
  const [v, auth] = await Promise.all([capture(exe, ['--version'], { unsetEnv }), capture(exe, ['auth', 'status', '--json'], { unsetEnv })]);
  const a = auth ? parseClaudeAuth(auth.out) : { signedIn: null, detail: null };
  return { id: 'claude', exe, version: v?.out.trim().split('\n')[0] || null, signedIn: a.signedIn, detail: a.detail,
    fix: a.signedIn === false ? 'Claude Code is not signed in: run `claude` once and sign in.' : null };
}

/** `codex login status` prints one line such as "Logged in using ChatGPT", and exits non-zero when it is not. */
export function parseCodexLogin(r: { code: number; out: string } | null): { signedIn: boolean | null; detail: string | null } {
  if (!r) return { signedIn: null, detail: null };
  const line = r.out.split('\n').map(l => l.trim()).find(l => /logged in|not logged/i.test(l)) ?? null;
  const signedIn = r.code === 0 && !!line && !/not logged/i.test(line);
  return { signedIn, detail: signedIn ? line : null };
}

export async function detectCodex(): Promise<CliStatus> {
  const exe = which('codex') ?? codexAppBinary();
  if (!exe) {
    const shim = findShim('codex');
    return { id: 'codex', exe: null, version: null, signedIn: null, detail: null,
      fix: shim ? `Only an npm launcher (${shim}) was found: install the native Codex CLI or the Codex app.`
        : 'Codex is not installed: install the Codex CLI, then run `codex login`.' };
  }
  const [v, login] = await Promise.all([capture(exe, ['--version']), capture(exe, ['login', 'status'])]);
  const l = parseCodexLogin(login);
  return { id: 'codex', exe, version: v?.out.trim().split('\n')[0] || null, signedIn: l.signedIn, detail: l.detail,
    fix: l.signedIn === false ? 'Codex is not signed in: run `codex login`.' : null };
}
