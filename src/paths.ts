/**
 * Paths — central data directory for Clawd Cursor.
 *
 * All persistent data lives under ~/.clawdcursor/:
 *   task-logs/    — JSONL per-task execution logs
 *   reports/      — locally saved error reports
 *   consent       — first-run consent flag
 *   ui-knowledge/ — local app workflow instruction sets
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

/** Sub-directories */
export const TASK_LOGS_DIR = path.join(DATA_DIR, 'task-logs');
export const REPORTS_DIR = path.join(DATA_DIR, 'reports');

/** Persistent files */
export const TOKEN_PATH = path.join(DATA_DIR, 'token');

/**
 * Find the package root (directory containing package.json) by walking up
 * from the caller's `__dirname`. Cached after first call.
 *
 * Why: pre-v0.9 every source file lived directly under `src/` so compiled
 * output landed at `dist/<file>.js` and `__dirname/..` always pointed at the
 * package root. After v0.9 PR10's directory restructure, files now live at
 * `dist/<core|tools|platform|surface>/<file>.js`, so `__dirname/..` is
 * one level too shallow. This helper walks up until it finds package.json
 * regardless of how deeply nested the calling file is — so any future moves
 * don't break path resolution again.
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
  // Fallback: assume we're in dist/<subdir>/ and go up two levels.
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

  // If new dir already has task-logs, skip migration (already migrated)
  if (fs.existsSync(TASK_LOGS_DIR) && fs.readdirSync(TASK_LOGS_DIR).length > 0) return;

  try {
    // Ensure new dirs exist
    fs.mkdirSync(TASK_LOGS_DIR, { recursive: true });
    fs.mkdirSync(REPORTS_DIR, { recursive: true });

    // Copy task-logs
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

    // Copy reports
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
