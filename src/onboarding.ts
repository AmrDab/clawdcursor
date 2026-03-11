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

/** Write consent file directly (for --accept flag / CI / scripted use) */
export function writeConsentFile(): void {
  saveConsent();
}

/** Print the big ASCII banner — only called during first-run onboarding */
function printBanner(): void {
  const G = '\x1b[32m', B = '\x1b[1m\x1b[32m', R = '\x1b[0m', D = '\x1b[90m';
  process.stdout.write(
    `\n${G}\n` +
    `   /\\___/\\\n` +
    `  ( >^.^< )   claw\n` +
    `   )     (    claw\n` +
    `  (_)_(_)_)\n` +
    `${R}\n` +
    `${B}\n` +
    `  \u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2557      \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557    \u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2557\n` +
    ` \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d\u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551    \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\n` +
    ` \u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551 \u2588\u2557 \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551\n` +
    ` \u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551\n` +
    ` \u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551  \u2588\u2588\u2551\u255a\u2588\u2588\u2588\u2554\u2588\u2588\u2588\u2554\u255d\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d\n` +
    `  \u255a\u2550\u2550\u2550\u2550\u2550\u255d\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d\u255a\u2550\u255d  \u255a\u2550\u255d \u255a\u2550\u2550\u255d\u255a\u2550\u2550\u255d \u255a\u2550\u2550\u2550\u2550\u2550\u255d\n` +
    `${R}${G}\n` +
    `  \u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557\n` +
    ` \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d\u2588\u2588\u2554\u2550\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\n` +
    ` \u2588\u2588\u2551     \u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d\n` +
    ` \u2588\u2588\u2551     \u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u255a\u2550\u2550\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\n` +
    ` \u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d\u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d\u2588\u2588\u2551  \u2588\u2588\u2551\n` +
    `  \u255a\u2550\u2550\u2550\u2550\u2550\u255d \u255a\u2550\u2550\u2550\u2550\u2550\u255d \u255a\u2550\u255d  \u255a\u2550\u255d\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d \u255a\u2550\u2550\u2550\u2550\u2550\u255d \u255a\u2550\u255d  \u255a\u2550\u255d\n` +
    `${R}\n` +
    `${D}  OS-level Desktop Automation Server${R}\n` +
    `${D}  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${R}\n\n`
  );
}

/** Run the onboarding consent flow (interactive terminal) */
export async function runOnboarding(context: 'start' | 'consent' = 'start'): Promise<boolean> {
  // Non-interactive mode (piped stdin, CI, MCP stdio) — skip consent
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return true;
  }

  // Show the big banner — this is the one moment every user sees it
  printBanner();

  const contextNote = context === 'start'
    ? `\x1b[90m  You are starting:\x1b[0m\n` +
      `\x1b[90m  \u2192 AI Agent + REST API on \x1b[0m\x1b[36mlocalhost:3847\x1b[0m\n` +
      `\x1b[90m  \u2192 Any local process can call tool endpoints on that port\x1b[0m\n`
    : `\x1b[90m  This one-time consent covers all transport modes:\x1b[0m\n` +
      `\x1b[90m  \u2192 MCP server (Claude Code, Cursor, Windsurf, Zed)\x1b[0m\n` +
      `\x1b[90m  \u2192 REST API (clawdcursor start)\x1b[0m\n` +
      `\x1b[90m  \u2192 Direct agent tasks\x1b[0m\n`;

  console.log(`
\x1b[33m
  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
  \u2551                                                              \u2551
  \u2551           \u26a0   DESKTOP CONTROL WARNING   \u26a0                   \u2551
  \u2551                                                              \u2551
  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d
\x1b[0m
\x1b[90m  clawd-cursor gives AI models full control of your desktop:\x1b[0m

\x1b[31m  ●\x1b[0m Mouse clicks and keyboard input anywhere on screen
\x1b[31m  ●\x1b[0m Screenshot capture of your entire display
\x1b[31m  ●\x1b[0m Read and write OS clipboard
\x1b[31m  ●\x1b[0m Open, close, and switch between applications
\x1b[31m  ●\x1b[0m Browser DOM interaction via Chrome DevTools Protocol
\x1b[31m  ●\x1b[0m Read accessibility tree (window contents, UI elements)

${contextNote}
\x1b[32m  SAFETY NOTES:\x1b[0m
\x1b[90m  ●  Only run on a machine you control\x1b[0m
\x1b[90m  ●  Only connect AI models you trust\x1b[0m
\x1b[90m  ●  Server binds to localhost only (127.0.0.1)\x1b[0m
\x1b[90m  ●  Dangerous key combos (Alt+F4, Ctrl+Alt+Del) are blocked\x1b[0m
\x1b[90m  ●  Run \x1b[0m\x1b[36mclawdcursor stop\x1b[0m\x1b[90m to shut down when not in use\x1b[0m

\x1b[90m  ──────────────────────────────────────────────────────────\x1b[0m
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
