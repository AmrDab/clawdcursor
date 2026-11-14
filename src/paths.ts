/**
 * Paths — central data directory for Clawd Cursor.
 *
 * All persistent data lives under ~/.clawdcursor/. task-logs/ is only read (report.ts): old installs wrote it.
 *
 * Migrates from legacy paths if found:
 *   ~/.openclaw/clawd-cursor/ (v0.5.x)
 *   ~/.clawd-cursor/ (v0.6.x–v0.7.0 pre-rename)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Root data directory: ~/.clawdcursor */
export const DATA_DIR = path.join(os.homedir(), '.clawdcursor');

export const TASK_LOGS_DIR = path.join(DATA_DIR, 'task-logs');
export const REPORTS_DIR = path.join(DATA_DIR, 'reports');

export const TOKEN_PATH = path.join(DATA_DIR, 'token');

/**
 * Find the package root (directory containing package.json) by walking up
 * from this module's directory. Cached after first call.
 */
let cachedPackageRoot: string | null = null;
export function getPackageRoot(): string {
  if (cachedPackageRoot) return cachedPackageRoot;
  let dir = __dirname;
  // Walk up at most 8 levels — package roots are never that deep.
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      cachedPackageRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }
  cachedPackageRoot = path.resolve(__dirname, '..', '..');
  return cachedPackageRoot;
}

/**
 * Migrate data from legacy directories to ~/.clawdcursor/.
 * Checks both ~/.openclaw/clawd-cursor/ (v0.5.x) and ~/.clawd-cursor/ (v0.6–v0.7 pre-rename).
 * Only runs once — if the new dir already has content, skips.
 * Safe: copies, doesn't delete originals.
 */
export function migrateFromLegacyDir(): void {
  // Try most recent legacy path first, then oldest
  const legacyCandidates = [
    path.join(os.homedir(), '.clawd-cursor'),       // v0.6.x–v0.7.0 pre-rename
    path.join(os.homedir(), '.openclaw', 'clawd-cursor'), // v0.5.x
  ];
  const legacyDir = legacyCandidates.find(d => fs.existsSync(d));
  if (!legacyDir) return;

  if (fs.existsSync(TASK_LOGS_DIR) && fs.readdirSync(TASK_LOGS_DIR).length > 0) return;

  try {
    fs.mkdirSync(TASK_LOGS_DIR, { recursive: true });
    fs.mkdirSync(REPORTS_DIR, { recursive: true });

    const legacyLogs = path.join(legacyDir, 'task-logs');
    if (fs.existsSync(legacyLogs)) {
      for (const file of fs.readdirSync(legacyLogs)) {
        const src = path.join(legacyLogs, file);
        const dst = path.join(TASK_LOGS_DIR, file);
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
        }
      }
    }

    const legacyReports = path.join(legacyDir, 'reports');
    if (fs.existsSync(legacyReports)) {
      for (const file of fs.readdirSync(legacyReports)) {
        const src = path.join(legacyReports, file);
        const dst = path.join(REPORTS_DIR, file);
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
        }
      }
    }

    console.log(`📦 Migrated data from ${legacyDir} → ${DATA_DIR}`);
  } catch {
    // Non-critical — old data still accessible at original path
  }
}
