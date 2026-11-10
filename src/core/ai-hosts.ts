/**
 * Apps that host an AI assistant, by process name on each OS. Synthetic input must never land in one by accident (an agent
 * that types before it has focused a window sends its text to the chat it is running in), and none is ever raised at a click
 * point on the agent's behalf. One list for both: scripts/ps-bridge.ps1 keeps a copy for the Windows raise guard, and
 * ai-hosts.test.ts fails when the two differ.
 *
 * Names are compared lower case, without a path, ".exe" or ".app". Windows and macOS report "Claude", "ChatGPT", "Codex",
 * "Cursor", "Code", "Windsurf", "Zed"; Linux packages use the lower-case or hyphenated forms.
 */
export const AI_HOST_PROCESSES: readonly string[] = [
  'claude', 'claude-desktop', 'chatgpt', 'codex', 'cursor', 'code', 'code-insiders', 'windsurf', 'zed', 'zeditor', 'zed-editor',
];

const normalize = (name: string) => (name.replace(/\\/g, '/').split('/').pop() ?? name).replace(/\.(exe|app)$/i, '').toLowerCase();

/** The extra names the user added with CLAWD_FOREGROUND_DENYLIST (comma separated), normalized. */
function extraHosts(): string[] {
  return (process.env.CLAWD_FOREGROUND_DENYLIST ?? '').split(',').map(s => normalize(s.trim())).filter(Boolean);
}

/** Does this process name belong to an AI-assistant host app? */
export function isAiHostProcess(name: string | undefined | null): boolean {
  if (!name) return false;
  const n = normalize(name);
  return AI_HOST_PROCESSES.includes(n) || extraHosts().includes(n);
}
