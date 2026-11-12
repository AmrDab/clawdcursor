/**
 * Windows PowerShell leaves Microsoft/Windows/PowerShell/ModuleAnalysisCache in its working directory when it cannot resolve
 * LocalAppData (a USERPROFILE that is not an absolute Windows path, e.g. one with forward slashes), and `git add -A` then
 * commits it (it reached #334 and #336). Every PowerShell child, in the sources and in the tests, runs from the private run
 * directory psOpts gives (#369). The first check fails the run if one still lands at the repo root; the scan fails as soon as
 * a spawn without psOpts is written, whatever order the tests run in.
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

describe('every PowerShell child', () => {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
    }
  })(path.join(root, 'src'));
  files.push(...fs.readdirSync(path.join(root, 'tests')).filter(f => f.endsWith('.ts')).map(f => path.join(root, 'tests', f)));

  it('runs from the private run directory (psOpts), never from wherever the caller stands', () => {
    const call = /\b(spawn|spawnSync|execFile|execFileSync|execFileAsync)\(\s*(powershellExe\(\)|['"](powershell|pwsh)(\.exe)?['"])/g;
    const bad: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(call)) {
        // The call's own argument list: from its "(" to the matching ")".
        let i = m.index! + m[1].length, depth = 0;
        do { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++; } while (depth > 0 && i < src.length);
        if (!src.slice(m.index!, i).includes('psOpts(')) bad.push(`${path.relative(root, f)}:${src.slice(0, m.index!).split('\n').length}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
