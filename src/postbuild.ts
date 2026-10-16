/**
 * Post-build script — runs after tsc.
 *
 * Does two things:
 *  1. Copies non-TS assets into dist/ (bundled app-knowledge guides and any
 *     other static files tsc doesn't touch). tsc only emits JS/d.ts; static
 *     files must be copied explicitly or they're missing at runtime.
 *  2. Prints available commands.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function copyDir(srcDir: string, dstDir: string): number {
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(dstDir, { recursive: true });
  let count = 0;
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const dst = path.join(dstDir, name);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      count += copyDir(src, dst);
    } else {
      fs.copyFileSync(src, dst);
      count += 1;
    }
  }
  return count;
}

const repoRoot  = path.join(__dirname, '..');
const srcGuides = path.join(repoRoot, 'src', 'llm', 'knowledge', 'guides');
const dstGuides = path.join(repoRoot, 'dist', 'llm', 'knowledge', 'guides');
const guideCount = copyDir(srcGuides, dstGuides);

// Suppress "Run consent" / "Run doctor" hints if the user already did them
// on this machine. The build script can detect prior state from $HOME and
// the package's own config file.
const consentGiven = fs.existsSync(path.join(os.homedir(), '.clawdcursor', 'consent'));
const configPresent = fs.existsSync(path.join(repoRoot, '.clawdcursor-config.json'));

const startBlock = consentGiven
  ? `  [OK] Consent already accepted from a previous run.\n\n  Pick a path:`
  : `  Start here:\n    clawdcursor consent     One-time desktop control authorization\n\n  Then pick a path:`;

const doctorLine = configPresent
  ? `clawdcursor doctor   (optional) Re-check / change AI provider + models`
  : `clawdcursor doctor   Configure AI provider + models`;

console.log(`
🐾 Clawd Cursor built successfully!
   (bundled ${guideCount} app-knowledge guides → dist/llm/knowledge/guides/)

${startBlock}
    Autonomous agent →  ${doctorLine}
                        clawdcursor agent    Start the daemon (HTTP + MCP on :3847)

    MCP-only         →  clawdcursor mcp      stdio MCP for editor integration
                                             (Claude Code, Cursor, Windsurf, Zed)

  Other:
    clawdcursor status      Check setup readiness
    clawdcursor versions    List every installed copy (global, Desktop extension, plugin)
    clawdcursor stop        Stop a running daemon
    clawdcursor uninstall   Remove all config and data
`);
