/**
 * Values reach PowerShell as data, never inside a script's source (GHSA-9ppf-38v8-h97v).
 *
 * Quoting cannot be made safe: besides ', PowerShell also ends a single-quoted string at ‘ ’ ‚ ‛
 * (U+2018–U+201B), so a value holding one ran the rest of it as code. A script reads its inputs from
 * $env:CLAWD_PS_* (short values: names, titles, paths) or stdin (clipboard text, any size) instead.
 */
import { execFile } from 'child_process';
import { psOpts } from './ps-spawn';

/** Reads base64 UTF-8 from stdin: ASCII on the wire, so no console codepage can mangle it. */
export const SET_CLIPBOARD_SCRIPT =
  '$b = [Console]::In.ReadToEnd(); Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b.Trim())))';

/** Run a PowerShell script with `input` on its stdin. */
export function runPsWithStdin(script: string, input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], psOpts({ timeout: timeoutMs }),
      (err, stdout) => (err ? reject(err) : resolve(String(stdout ?? ''))));
    // PowerShell may exit (or be killed at the timeout) before it has read everything: a closed pipe is not our error.
    child.stdin?.on('error', () => { /* reported by the exit callback */ });
    child.stdin?.end(input);
  });
}

/** Set the Windows clipboard to `text`. */
export async function setWindowsClipboard(text: string, timeoutMs: number): Promise<void> {
  await runPsWithStdin(SET_CLIPBOARD_SCRIPT, Buffer.from(text, 'utf8').toString('base64'), timeoutMs);
}
