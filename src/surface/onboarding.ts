/**
 * Onboarding — first-run consent flow for desktop control.
 *
 * On first run, warns the user about desktop control capabilities
 * and requires explicit consent before tools become active.
 * Consent is stored in ~/.clawdcursor/consent.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import pc from 'picocolors';
import { VERSION } from './version';

const CONSENT_DIR = path.join(os.homedir(), '.clawdcursor');
const CONSENT_FILE = path.join(CONSENT_DIR, 'consent');

export function hasConsent(): boolean {
  return fs.existsSync(CONSENT_FILE);
}

function saveConsent(source?: string): void {
  if (!fs.existsSync(CONSENT_DIR)) {
    fs.mkdirSync(CONSENT_DIR, { recursive: true });
  }
  fs.writeFileSync(CONSENT_FILE, JSON.stringify({
    accepted: true,
    timestamp: new Date().toISOString(),
    platform: process.platform,
    version: VERSION,
    ...(source ? { source } : {}),
  }, null, 2));
}

/**
 * Accept consent from the environment — set by a host that collected it in
 * its own UI. The Claude Desktop extension (.mcpb) asks the user to tick
 * "Allow clawdcursor to control this computer" at install and passes it as
 * CLAWDCURSOR_CONSENT=true; an extension user never opens a terminal to run
 * `clawdcursor consent --accept`. Anything that can set this variable could
 * already run that command, so it grants nothing new. Returns true when it
 * recorded consent.
 */
export function acceptConsentFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (hasConsent()) return false;
  if (!/^(true|1)$/i.test((env.CLAWDCURSOR_CONSENT ?? '').trim())) return false;
  saveConsent('host-setting:CLAWDCURSOR_CONSENT');
  return true;
}

/** Write consent file directly (for --accept flag / CI / scripted use, or a host prompt) */
export function writeConsentFile(source?: string): void {
  saveConsent(source);
}

/** Print the big ASCII banner — only called during first-run onboarding */
function printBanner(): void {
  const cat =
    `   /\\___/\\\n` +
    `  ( >^.^< )   claw\n` +
    `   )     (    claw\n` +
    `  (_)_(_)_)`;

  const clawBlock =
    `  ██████╗██╗      █████╗ ██╗    ██╗██████╗\n` +
    ` ██╔════╝██║     ██╔══██╗██║    ██║██╔══██╗\n` +
    ` ██║     ██║     ███████║██║ █╗ ██║██║  ██║\n` +
    ` ██║     ██║     ██╔══██║██║███╗██║██║  ██║\n` +
    ` ╚██████╗███████╗██║  ██║╚███╔███╔╝██████╔╝\n` +
    `  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═════╝`;

  const cursorBlock =
    `  ██████╗██╗   ██╗██████╗ ███████╗ ██████╗ ██████╗\n` +
    ` ██╔════╝██║   ██║██╔══██╗██╔════╝██╔═══██╗██╔══██╗\n` +
    ` ██║     ██║   ██║██████╔╝█████╗  ██║   ██║██████╔╝\n` +
    ` ██║     ██║   ██║██╔══██╗╚════██╗██║   ██║██╔══██╗\n` +
    ` ╚██████╗╚██████╔╝██║  ██║███████║╚██████╔╝██║  ██║\n` +
    `  ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝`;

  const footer =
    `  OS-level Desktop Automation Server\n` +
    `  ─────────────────────────────────────────────`;

  process.stdout.write(
    `\n${pc.green(cat)}\n\n` +
    `${pc.bold(pc.green(clawBlock))}\n` +
    `${pc.green(cursorBlock)}\n\n` +
    `${pc.gray(footer)}\n\n`,
  );
}

/** Run the onboarding consent flow (interactive terminal) */
export async function runOnboarding(context: 'start' | 'consent' = 'start', startPort: number = 3847): Promise<boolean> {
  // Non-interactive mode (piped stdin, CI, MCP stdio) — skip consent
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return true;
  }

  // Show the big banner — this is the one moment every user sees it
  printBanner();

  const contextNote = context === 'start'
    ? pc.gray('  You are starting:') + '\n' +
      `${pc.gray('  → MCP HTTP transport on ')}${pc.cyan(`localhost:${startPort}`)}\n` +
      pc.gray('  → Any local process with the bearer token can call tools') + '\n'
    : pc.gray('  This one-time consent covers both transports of clawdcursor:') + '\n' +
      `${pc.gray('  → stdio MCP   ')}${pc.gray('(Claude Code, Cursor, Windsurf, Zed — your editor spawns it)')}\n` +
      `${pc.gray('  → HTTP MCP    ')}${pc.gray('(')}${pc.cyan('clawdcursor agent')}${pc.gray(' — local daemon for HTTP-capable agents)')}\n`;

  const warningBox = pc.yellow(
    `  ╔${'═'.repeat(63)}╗\n` +
    `  ║                                                              ║\n` +
    `  ║           ⚠   DESKTOP CONTROL WARNING   ⚠                   ║\n` +
    `  ║                                                              ║\n` +
    `  ╚${'═'.repeat(63)}╝`,
  );

  const capabilities = [
    'Mouse clicks and keyboard input anywhere on screen',
    'Screenshot capture of your entire display',
    'Read and write OS clipboard',
    'Open, close, and switch between applications',
    'Browser DOM interaction via Chrome DevTools Protocol',
    'Read accessibility tree (window contents, UI elements)',
  ].map(line => `${pc.red('  ●')} ${line}`).join('\n');

  const safetyNotes = [
    '  ●  Only run on a machine you control',
    '  ●  Only connect AI models you trust',
    '  ●  Server binds to localhost only (127.0.0.1)',
    '  ●  It acts with your own permissions: what it does is up to the AI you connect and its permission prompts',
    '  ●  You can stop it at any time from the on-screen pill; it never locks the screen or logs you out',
    '  ●  To be asked on screen before Send / Delete / Pay / Close, set CLAWD_CONFIRM=1 in its environment (confirm mode)',
  ].map(line => pc.gray(line)).join('\n');

  const divider = '  ' + '─'.repeat(58);

  console.log(
    `\n${warningBox}\n\n` +
    `${pc.gray('  clawdcursor gives AI models full control of your desktop:')}\n\n` +
    `${capabilities}\n\n` +
    `${contextNote}` +
    `${pc.green('  SAFETY NOTES:')}\n` +
    `${safetyNotes}\n` +
    `${pc.gray('  ●  Run ')}${pc.cyan('clawdcursor stop')}${pc.gray(' to shut down when not in use')}\n\n` +
    `${pc.gray(divider)}\n`,
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question('  Accept and continue? (y/N) ', resolve);
  });
  rl.close();

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    saveConsent();
    console.log('\n  ✅ Consent saved. You won\'t be asked again.\n');
    // Most users need NO further commands: `doctor` is a diagnostic, not setup.
    console.log('  Next steps — pick your path:');
    console.log('');
    console.log('  ▸ Your own AI drives clawdcursor (Claude Code, Cursor, Windsurf, …):');
    if (process.platform === 'darwin') {
      console.log('      clawdcursor grant        # approve Accessibility + Screen Recording');
    }
    console.log('      …then add the MCP entry to your editor — that\'s ALL the setup:');
    console.log('      { "mcpServers": { "clawdcursor": { "command": "clawdcursor", "args": ["mcp", "--compact"] } } }');
    console.log('');
    console.log('  ▸ Any HTTP client:');
    console.log('      clawdcursor agent        # local daemon, MCP at POST /mcp');
    console.log('');
    console.log('  Something not working? clawdcursor doctor');
    return true;
  }

  console.log('\n  Declined. clawdcursor will not start.\n');
  return false;
}

/** Revoke consent (`clawdcursor consent --revoke`). */
export function revokeConsent(): void {
  if (fs.existsSync(CONSENT_FILE)) {
    fs.unlinkSync(CONSENT_FILE);
  }
}
