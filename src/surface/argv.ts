/**
 * The command-line arguments after clawdcursor's own script, for any runtime.
 *
 * Under Electron, commander guesses the argv layout from `process.defaultApp`:
 * in a packaged app it drops only argv[0] and keeps the script path as the
 * first "argument". Claude Desktop runs extensions in an Electron utility
 * process (`utilityProcess.fork(cli.js, ['mcp', '--compact'])`), so every
 * launch of the .mcpb failed with `error: unknown command '…\cli.js'`
 * (reproduced 2026-10). Locate the script ourselves instead: everything after
 * it is the user's.
 */
import * as fs from 'fs';
import * as path from 'path';

function same(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function resolved(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** A `--port` value: an integer in 1..65535, else null ("4000abc", "0", "1e3" and "" are all refused). */
export function parsePort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

export function userArgs(argv: string[], scriptPath: string, isElectron = Boolean(process.versions.electron)): string[] {
  const here = resolved(scriptPath);
  // argv[0] is always the runtime binary; a symlinked bin (`/usr/local/bin/
  // clawdcursor`) resolves to the script too.
  const i = argv.findIndex((a, idx) => idx > 0 && same(resolved(a), here));
  if (i >= 0) return argv.slice(i + 1);
  return isElectron ? argv.slice(1) : argv.slice(2);
}
