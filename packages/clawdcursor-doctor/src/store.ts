/**
 * Writing ~/.clawdcursor/agent.json, which can hold an API key: readable and writable by its owner only. On macOS and
 * Linux that is mode 0600; on Windows the file's ACL is cut down to the current user (inherited entries removed).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The icacls arguments that leave `user` as the file's only entry, with full control. */
export function icaclsArgs(file: string, user: string): string[] {
  return [file, '/inheritance:r', '/grant:r', `${user}:F`];
}

/** DOMAIN\\user on Windows, as icacls takes it. */
export function windowsUser(env: NodeJS.ProcessEnv = process.env): string {
  const name = os.userInfo().username;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name;
}

export type Run = (cmd: string, args: string[]) => void;
const icacls = (): string => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
const runQuiet: Run = (cmd, args) => { execFileSync(cmd, args, { stdio: 'ignore', windowsHide: true }); };

/** Make `file` owner-only. Throws when that cannot be done. */
export function restrictToOwner(file: string, o: { platform?: string; run?: Run; user?: string } = {}): void {
  if ((o.platform ?? process.platform) === 'win32') (o.run ?? runQuiet)(icacls(), icaclsArgs(file, o.user ?? windowsUser()));
  else fs.chmodSync(file, 0o600);
}

/**
 * Write the config owner-only. The file is created 0600 (where modes apply) and restricted before anything is in it,
 * then the content goes in: a key is never in a file others can read. When it cannot be restricted, nothing is written.
 */
export function writePrivateJson(file: string, data: unknown, o: { platform?: string; run?: Run; user?: string } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w', 0o600);
  fs.closeSync(fd);
  try { restrictToOwner(file, o); }
  catch (e) { fs.rmSync(file, { force: true }); throw new Error(`could not make ${file} private (${(e as Error).message}); nothing was saved`); }
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
