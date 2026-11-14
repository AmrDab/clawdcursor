/**
 * `clawdcursor uninstall`: stop the daemon, then remove clawdcursor's config, data, skill registrations, MCP entries and
 * build output.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { execSync } from 'child_process';
import { e } from './format';
import { getPackageRoot } from '../paths';
import { privateRunDir } from '../platform/ps-spawn';
import { authHeaders, readToken } from './auth';
import { daemonPortForClient, sweepAllLocks } from './pidfile';
import { ourSkillRegistrations } from './skill-register';

/**
 * Stop the daemon on the port it recorded (before the data dir and its token go), then every clawdcursor a lock proves.
 * Before, this always asked :3847, so a daemon on another port kept running.
 */
export async function stopRunningDaemon(): Promise<void> {
  try {
    if (readToken()) {
      const resp = await fetch(`http://127.0.0.1:${daemonPortForClient()}/stop`, { method: 'POST', headers: authHeaders() });
      if (resp.ok) {
        console.log(`   ${e('🛑', '[STOP]')}  Stopped running server`);
        await new Promise(r => setTimeout(r, 1000));   // give it a moment to shut down
      }
    }
  } catch { /* server not running — that's fine */ }
  // Only a holder its lock proves is clawdcursor is signalled; a stale lock is just deleted (sweepAllLocks).
  for (const r of await sweepAllLocks()) {
    if (r.outcome === 'stopped') console.log(`   ${e('🛑', '[STOP]')}  Killed running ${r.mode} process (pid ${r.pid})`);
  }
}

export async function runUninstall(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`\n${e('❌', '[ERR]')}  clawdcursor uninstall requires an interactive terminal.\n`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`\n${e('⚠️', '[WARN]')}  This will remove all Clawd Cursor config and data. Continue? (y/N) `, resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== 'y') {
    console.log('Cancelled.');
    return;
  }

  console.log(`\n${e('🗑️', '[DEL]')}  Uninstalling Clawd Cursor...\n`);
  const clawdRoot = getPackageRoot();
  const homeDir = os.homedir();
  let removed = 0;
  const failed: string[] = [];

  // Resilient remove: never let one locked / permission-denied path abort the
  // whole uninstall. On Windows a file handle (a running daemon, the logger's
  // current log file, AV/indexer) can briefly hold a path open → EPERM/EBUSY.
  // rmSync's maxRetries rides out the transient lock; the try/catch downgrades
  // a hard failure to a warning + manual-cleanup hint and CONTINUES to the next
  // step (the old code threw here, crashing as an unhandledRejection and
  // leaving the install half-removed).
  const safeRemove = (target: string, label: string): void => {
    try {
      if (!fs.existsSync(target)) return;
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || stat.isFile()) fs.unlinkSync(target);
      else fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      console.log(`   ${e('🗑️', '[DEL]')}  Removed ${label}`);
      removed++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code || (err as Error).message;
      failed.push(`${target} (${code})`);
      console.log(`   ${e('⚠️', '[WARN]')}  Could not remove ${label} (${code}) — close any running clawdcursor, then delete manually: ${target}`);
    }
  };

  await stopRunningDaemon();

  // 1. Remove config files in project root
  const configFiles = [
    path.join(clawdRoot, '.clawdcursor-config.json'),
    path.join(clawdRoot, '.clawdcursor-favorites.json'),   // written by installs before 1.6
    path.join(clawdRoot, '.env'),
  ];
  for (const f of configFiles) safeRemove(f, path.basename(f));

  // 2. Remove ~/.clawdcursor data directory (token, consent, task logs, pid)
  safeRemove(path.join(homeDir, '.clawdcursor'), path.join(homeDir, '.clawdcursor'));
  // Also remove legacy data directory
  safeRemove(path.join(homeDir, '.clawd-cursor'), `legacy ${path.join(homeDir, '.clawd-cursor')}`);

  // 3. Remove debug folder
  safeRemove(path.join(clawdRoot, 'debug'), 'debug/');

  // 4. Remove the skill registrations clawdcursor wrote (skill-register.ts), in every host it registers with.
  for (const sp of ourSkillRegistrations(homeDir)) safeRemove(sp, `skill registration: ${sp}`);

  // 5. Remove MCP server entries from known config files
  const mcpConfigs = [
    // Claude Code
    path.join(homeDir, '.claude', 'settings.json'),
    path.join(homeDir, '.claude', 'settings.local.json'),
    // Cursor
    path.join(homeDir, '.cursor', 'mcp.json'),
    // Windsurf
    path.join(homeDir, '.windsurf', 'mcp.json'),
    path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
    // VS Code / Continue
    path.join(homeDir, '.vscode', 'mcp.json'),
  ];
  for (const configPath of mcpConfigs) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const raw = fs.readFileSync(configPath, 'utf-8');
      const json = JSON.parse(raw);
      // Look for "clawdcursor" or "clawd-cursor" key in mcpServers
      const servers = json.mcpServers || json.servers || {};
      let found = false;
      for (const key of Object.keys(servers)) {
        if (key.toLowerCase().includes('clawdcursor') || key.toLowerCase().includes('clawd-cursor')) {
          delete servers[key];
          found = true;
        }
      }
      if (found) {
        fs.writeFileSync(configPath, JSON.stringify(json, null, 2) + '\n');
        console.log(`   ${e('🗑️', '[DEL]')}  Removed MCP entry from ${configPath}`);
        removed++;
      }
    } catch { /* skip unreadable configs */ }
  }

  // 6. Remove dist folder
  safeRemove(path.join(clawdRoot, 'dist'), 'dist/');
  // macOS native helper build output — regenerable, not tracked (#155).
  safeRemove(path.join(clawdRoot, 'native', '.build'), 'native/.build/');
  safeRemove(path.join(clawdRoot, 'native', 'ClawdCursor.app'), 'native/ClawdCursor.app/');

  // 7. Unlink global npm command
  try {
    // Left on PATH on purpose: the user runs this uninstall themselves, and npm is theirs to resolve (not a system program).
    execSync('npm unlink -g clawdcursor', { stdio: 'pipe', timeout: 15000, cwd: privateRunDir() });
    console.log(`   ${e('🗑️', '[DEL]')}  Removed global clawdcursor command`);
    removed++;
  } catch { /* may not be linked globally */ }

  if (removed === 0 && failed.length === 0) {
    console.log('   Nothing to clean up.');
  }

  if (failed.length > 0) {
    console.log(`\n${e('⚠️', '[WARN]')}  ${failed.length} item(s) could not be removed (a running process likely held a file open). Close any clawdcursor process, then delete these manually:`);
    for (const f of failed) console.log(`   ${f}`);
  }

  console.log(`\n${e('🐾', '>')} ${failed.length > 0 ? 'Uninstall finished with warnings' : 'Fully uninstalled'}. To remove the source code, delete:`);
  console.log(`   ${clawdRoot}`);

  // Closing the reinstall dead-end: this command just removed the global
  // `clawdcursor` shim, so `clawdcursor install` can't work afterwards — and
  // the natural next step shouldn't be a guess. Point the user at the package
  // manager (works everywhere) plus the turnkey one-liner for their OS.
  const reinstallOneLiner = process.platform === 'win32'
    ? 'irm https://clawdcursor.com/install.ps1 | iex'
    : 'curl -fsSL https://clawdcursor.com/install.sh | bash';
  console.log(`\n${e('📦', '>')} To reinstall:  npm i -g clawdcursor`);
  console.log(`   or:           ${reinstallOneLiner}\n`);
}
