/**
 * Paths — central data directory for Clawd Cursor.
 *
 * All persistent data lives under ~/.clawd-cursor/:
 *   task-logs/    — JSONL per-task execution logs
 *   reports/      — locally saved error reports
 *   consent       — first-run consent flag
 *   ui-knowledge/ — local app workflow instruction sets
 *
 * Migrates from legacy ~/.openclaw/clawd-cursor/ if found.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Root data directory: ~/.clawd-cursor */
export const DATA_DIR = path.join(os.homedir(), '.clawd-cursor');

/** Sub-directories */
export const TASK_LOGS_DIR = path.join(DATA_DIR, 'task-logs');
export const REPORTS_DIR = path.join(DATA_DIR, 'reports');
export const UI_KNOWLEDGE_DIR = path.join(DATA_DIR, 'ui-knowledge');

/**
 * Migrate data from legacy ~/.openclaw/clawd-cursor/ to ~/.clawd-cursor/.
 * Only runs once — if the new dir already has content, skips.
 * Safe: copies, doesn't delete originals.
 */
export function migrateFromLegacyDir(): void {
  const legacyDir = path.join(os.homedir(), '.openclaw', 'clawd-cursor');
  if (!fs.existsSync(legacyDir)) return;

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
