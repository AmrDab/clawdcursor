/**
 * Windows PowerShell leaves Microsoft/Windows/PowerShell/ModuleAnalysisCache in the working directory when its environment has
 * no LOCALAPPDATA, and `git add -A` then commits it (it reached #334 and #336). clawdcursor's own PowerShell children now run from
 * the temp dir; this fails the run if one still lands at the repo root, so it is caught before it is committed.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const root = path.resolve(__dirname, '..');

describe('the repo root', () => {
  it('has no Microsoft/ directory (a stray PowerShell module cache)', () => {
    expect(fs.existsSync(path.join(root, 'Microsoft')), 'delete Microsoft/ at the repo root, and do not commit it').toBe(false);
  });

  it('tracks no such file', () => {
    let tracked = '';
    try { tracked = execFileSync('git', ['ls-files', 'Microsoft'], { cwd: root, encoding: 'utf8' }); } catch { /* not a git checkout: nothing to check */ }
    expect(tracked.trim()).toBe('');
  });
});
