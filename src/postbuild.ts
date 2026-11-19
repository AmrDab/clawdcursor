/**
 * Post-build script — runs after tsc. Prints available commands.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// The app-guide pack ships in the package: dist/guides/pack.json, built from docs/app-guides (a source checkout has both).
const root = path.resolve(__dirname, '..');
const packScript = path.join(root, 'scripts', 'build-guide-pack.mjs');
if (fs.existsSync(packScript) && fs.existsSync(path.join(root, 'docs', 'app-guides', 'index.json'))) {
  execFileSync(process.execPath, [packScript, '--out', path.join('dist', 'guides', 'pack.json')], { cwd: root, stdio: 'inherit' });
}

// Suppress the "Run consent" hint if the user already did it on this machine.
const consentGiven = fs.existsSync(path.join(os.homedir(), '.clawdcursor', 'consent'));

const startBlock = consentGiven
  ? `  [OK] Consent already accepted from a previous run.\n\n  Pick a path:`
  : `  Start here:\n    clawdcursor consent     One-time desktop control authorization\n\n  Then pick a path:`;

console.log(`
🐾 Clawd Cursor built successfully!

${startBlock}
    HTTP daemon      →  clawdcursor agent    Start the daemon (HTTP + MCP on :3847)

    MCP-only         →  clawdcursor mcp      stdio MCP for editor integration
                                             (Claude Code, Cursor, Windsurf, Zed)

  Other:
    clawdcursor status      Check setup readiness
    clawdcursor versions    List every installed copy (global, Desktop extension, plugin)
    clawdcursor update      Update the global install to the latest version
    clawdcursor stop        Stop a running daemon
    clawdcursor uninstall   Remove all config and data
`);
