/**
 * Open a link the CLI built itself in the user's default browser (`clawdcursor dashboard`). Not for anything an agent
 * asks for: open_url goes through the platform adapter. No shell: the URL is one argv element, and Windows programs are
 * named by absolute path.
 */
import { spawn } from 'child_process';
import { system32Exe } from './ps-spawn';

/** Only a plain http(s) URL is opened; false when nothing was started. Never throws. */
export function openInDefaultBrowser(url: string): boolean {
  if (!/^https?:\/\/[^\s"'`]+$/.test(url)) return false;
  try {
    const child = process.platform === 'win32'
      ? spawn(system32Exe('rundll32.exe'), ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : process.platform === 'darwin'
        ? spawn('open', [url], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* no opener: the link is printed */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
