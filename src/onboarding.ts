/**
 * Onboarding — first-run consent flow for desktop control.
 *
 * On first run, warns the user about desktop control capabilities
 * and requires explicit consent before tools become active.
 * Consent is stored in ~/.clawd-cursor/consent.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

const CONSENT_DIR = path.join(os.homedir(), '.clawd-cursor');
const CONSENT_FILE = path.join(CONSENT_DIR, 'consent');

/** Check if the user has already given consent */
export function hasConsent(): boolean {
  return fs.existsSync(CONSENT_FILE);
}

/** Save consent to disk */
function saveConsent(): void {
  if (!fs.existsSync(CONSENT_DIR)) {
    fs.mkdirSync(CONSENT_DIR, { recursive: true });
  }
  fs.writeFileSync(CONSENT_FILE, JSON.stringify({
    accepted: true,
    timestamp: new Date().toISOString(),
    platform: process.platform,
    version: '0.7.0',
  }, null, 2));
}

/** Run the onboarding consent flow (interactive terminal) */
export async function runOnboarding(): Promise<boolean> {
  // Non-interactive mode (piped stdin, CI, MCP stdio) — skip consent
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return true;
  }

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                   DESKTOP CONTROL WARNING                    ║
╚══════════════════════════════════════════════════════════════╝

clawd-cursor gives AI models full control of your desktop:

  - Mouse clicks and keyboard input anywhere on screen
  - Screenshot capture of your entire display
  - Read and write OS clipboard
  - Open, close, and switch between applications
  - Browser DOM interaction via Chrome DevTools Protocol
  - Read accessibility tree (window contents, UI elements)

This is an OS-level automation server. Any AI model that connects
to it can perform these actions on your machine.

SAFETY RECOMMENDATIONS:
  - Only run on a machine you control
  - Only connect AI models you trust
  - The server binds to localhost only (127.0.0.1)
  - Dangerous key combos (Alt+F4, Ctrl+Alt+Del) are blocked
  - Use clawd-cursor stop to shut down when not in use
`);

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
    console.log('\n  Consent saved. You won\'t be asked again.\n');
    return true;
  }

  console.log('\n  Declined. clawd-cursor will not start.\n');
  return false;
}

/** Revoke consent (for uninstall) */
export function revokeConsent(): void {
  if (fs.existsSync(CONSENT_FILE)) {
    fs.unlinkSync(CONSENT_FILE);
  }
}
