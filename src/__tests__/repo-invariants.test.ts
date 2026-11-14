/**
 * Rules for the whole repo that no single module owns, checked by scanning files: how programs are started, how keys and
 * temp files are written, what the scripts are encoded in, which copies must stay the same, which files must (not) exist.
 * Behaviour belongs in the module's own test; only a rule that is a property of the source goes here. Two simple ones are
 * eslint rules instead (eslint.config.js): no PowerShell value quoted by doubling apostrophes, and no pause gate in the
 * input layer.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { TextDecoder } from 'node:util';
import { AI_HOST_PROCESSES } from '../core/ai-hosts';

const SRC = path.join(__dirname, '..');
const ROOT = path.join(SRC, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, '/');

/** Every .ts under `dir`; the tests only when asked. */
function tsFiles(dir: string, withTests = false): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' && !withTests ? [] : tsFiles(p, withTests);
    return p.endsWith('.ts') ? [p] : [];
  });
}
const PRODUCTION = tsFiles(SRC);
/** Production source lines, comment lines left out. */
const CODE = PRODUCTION.flatMap(f => fs.readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f: rel(f), n: i + 1, l })))
  .filter(x => !/^\s*(\/\/|\*|\/\*)/.test(x.l));

describe('programs are started by absolute path, PowerShell from the private run directory', () => {
  // The only bare names allowed in spawn / exec / execFile calls: tools that exist on macOS or Linux alone (their calls sit on
  // non-Windows code paths), and `npm`, resolved from PATH by the user's own uninstall command (run with a private cwd).
  // Anything for Windows (PowerShell, reg, tasklist, explorer, ...) is named by absolute path through ps-spawn.ts.
  const NON_WINDOWS = new Set([
    'ydotool', 'osascript', 'wmctrl', 'python3', 'xdotool', 'which', 'xrandr', 'open', 'wtype', 'sh', 'pbpaste', 'pbcopy', 'xwininfo',
    'xdg-open', 'xcode-select', 'wlr-randr', 'wl-paste', 'wl-copy', 'system_profiler', 'sysctl', 'swiftc', 'swift', 'swaymsg', 'ps',
    'pkill', 'kill', 'grim', 'gtk-launch', 'command', 'lsof', 'lsappinfo', 'ioreg', 'xclip', 'xsel', 'gsettings', 'dbus-send',
    'npm', 'git', 'node', 'tar', 'unzip', 'security', 'codesign', 'killall', 'defaults', 'screencapture', 'uname', 'xset', 'id',
  ]);

  it('no spawn / exec / execFile call names a program that Windows would find in the working directory', () => {
    const call = /\b(spawn|spawnSync|execFile|execFileSync|execFileAsync|execSync|execAsync|exec|spawnExec)\(\s*([`'"])([^`'"\s$]+)/;
    const bad = CODE.flatMap(x => {
      const m = call.exec(x.l);
      if (!m) return [];
      return NON_WINDOWS.has(path.basename(m[3]).toLowerCase()) ? [] : [`${x.f}:${x.n} ${m[3]}`];
    });
    expect(bad).toEqual([]);
  });

  it('exec() / execSync() with a command string is for macOS / Linux tools only (never a powershell string through a shell)', () => {
    const call = /\b(execSync|execAsync|exec)\(\s*([`'"])([^`'"]*)/;
    const bad = CODE.flatMap(x => {
      const m = call.exec(x.l);
      if (!m) return [];
      const first = (m[3].trim().split(/\s+/)[0] ?? '').toLowerCase();
      return NON_WINDOWS.has(first) ? [] : [`${x.f}:${x.n} ${m[3].slice(0, 40)}`];
    });
    expect(bad).toEqual([]);
  });

  // Windows PowerShell leaves Microsoft/Windows/PowerShell/ModuleAnalysisCache in its working directory when it cannot
  // resolve LocalAppData, and `git add -A` then commits it (#334, #336). Every PowerShell child, in the sources and in the
  // tests, runs from the private run directory psOpts gives (#369).
  it('every PowerShell child, in the sources and the tests, runs from psOpts\' private directory', () => {
    const files = [...tsFiles(SRC, true), ...tsFiles(path.join(ROOT, 'tests'))];
    const call = /\b(spawn|spawnSync|execFile|execFileSync|execFileAsync)\(\s*(powershellExe\(\)|['"](powershell|pwsh)(\.exe)?['"])/g;
    const bad: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(call)) {
        // The call's own argument list: from its "(" to the matching ")".
        let i = m.index! + m[1].length, depth = 0;
        do { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++; } while (depth > 0 && i < src.length);
        if (!src.slice(m.index!, i).includes('psOpts(')) bad.push(`${path.relative(ROOT, f)}:${src.slice(0, m.index!).split('\n').length}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the repo root has no Microsoft/ directory (a stray PowerShell module cache), on disk or tracked', () => {
    expect(fs.existsSync(path.join(ROOT, 'Microsoft')), 'delete Microsoft/ at the repo root, and do not commit it').toBe(false);
    let tracked = '';
    try { tracked = execFileSync('git', ['ls-files', 'Microsoft'], { cwd: ROOT, encoding: 'utf8' }); } catch { /* not a git checkout: nothing to check */ }
    expect(tracked.trim()).toBe('');
  });
});

describe('PowerShell built by windows.ts (#153)', () => {
  // setWindowState / setWindowBounds run one concatenated line through `powershell.exe -Command`. A here-string header (`@"`)
  // must end its line, so in a single-line command the whole script fails to parse and minimize / resize silently did nothing.
  const windowsSrc = read('src', 'platform', 'windows.ts');

  it('no `@"` here-string header inside a concatenated PS string', () => {
    const offenders = windowsSrc.split('\n').map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /-MemberDefinition\s+@"/.test(line) || /@"'\s*\+/.test(line));
    expect(offenders.map(o => `L${o.n}: ${o.line.trim()}`)).toEqual([]);
  });

  it('Add-Type -MemberDefinition uses a single-quoted C# block', () => {
    const emitted = windowsSrc.split('\n').filter(line => !line.trim().startsWith('//')).filter(line => line.includes('-MemberDefinition'));
    expect(emitted.length).toBeGreaterThan(0);
    for (const line of emitted) expect({ line: line.trim(), opensWith: line.match(/-MemberDefinition\s+(\S)/)?.[1] }).toMatchObject({ opensWith: "'" });
  });
});

describe('keys', () => {
  // Per-OS adapters and their tables are where a literal modifier belongs (the shortcut table has its own test).
  const PER_OS = /[\\/]platform[\\/](windows|macos|linux|wayland-backend|native-desktop|keys|hard-keys|mac-[a-z-]+|pointer-guard)\.ts$|[\\/]src[\\/]shortcuts\.ts$/;
  const shared = PRODUCTION.filter(p => !PER_OS.test(p));

  it('no built-in key press hardcodes ctrl / control outside the per-OS adapters (Ctrl+Tab tab cycling excepted)', () => {
    const offenders: string[] = [];
    for (const p of shared) {
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        // A press or hold of a literal chord that starts with Ctrl, however it is quoted.
        const m = /key(?:Press|Down)\(\s*[^)]*?['"`](?:ctrl|control)\+([^'"`]+)['"`]/i.exec(line);
        if (m && !/^(shift\+)?tab$/i.test(m[1])) offenders.push(`${rel(p)}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('no built-in combo is chosen by an inline darwin check: one helper (`mod`) decides', () => {
    const offenders: string[] = [];
    for (const p of shared) {
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (/(darwin|IS_MAC)[^\n]{0,20}\?\s*['"`](cmd|super|command|meta)\+[a-z]['"`]\s*:\s*['"`](ctrl|control)\+/i.test(line)) offenders.push(`${rel(p)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('hardKeyRefusal is called from exactly one place (GHSA-35pc: every key path goes through it)', () => {
    const callers = PRODUCTION.filter(p => !p.endsWith('hard-keys.ts') && /hardKeyRefusal\(/.test(fs.readFileSync(p, 'utf8')));
    expect(callers.map(rel)).toEqual(['platform/pointer-guard.ts']);
    expect(fs.readFileSync(callers[0], 'utf8').match(/hardKeyRefusal\(/g)).toHaveLength(1);
  });
});

describe('temp files', () => {
  // A temp file at a PREDICTABLE path in the world-writable OS temp dir (a fixed name, or one keyed only on Date.now() /
  // process.pid) is a symlink / race window (CWE-377). fs.mkdtemp() or a crypto.randomUUID() name is the safe form.
  it('no production .ts builds a tmpdir() path from a predictable token', () => {
    const predictable = /tmpdir\(\)[^\n]*\$\{\s*(?:Date\.now\(\)|process\.pid)\s*\}/;
    // A pid / timestamp used only as a readable prefix next to real randomness is fine.
    const sanctioned = /mkdtemp|randomUUID|randomBytes/;
    const offenders = PRODUCTION.flatMap(f => fs.readFileSync(f, 'utf8').split('\n').flatMap((l, i) =>
      predictable.test(l) && !sanctioned.test(l) ? [`${rel(f)}:${i + 1}`] : []));
    expect(offenders, 'Predictable temp-file path(s) in the OS temp dir. Use fs.mkdtemp() or a crypto.randomUUID() filename instead').toEqual([]);
  });
});

describe('scripts/** encoding', () => {
  // scripts/mac/find-element.jxa was committed as UTF-16LE, which osascript and git treat as binary. Line endings are
  // .gitattributes' job (eol=lf).
  const walk = (dir: string): string[] => fs.readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name);
    return fs.statSync(p).isDirectory() ? walk(p) : /\.(jxa|ps1|py|sh|swift)$/.test(name) ? [p] : [];
  });
  const files = walk(path.join(ROOT, 'scripts'));

  it('finds the bridge scripts', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)('%s is valid UTF-8 without a UTF-16 BOM', (file) => {
    const buf = fs.readFileSync(file);
    const bom16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
    expect(bom16, 'UTF-16 BOM').toBe(false);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(buf), 'valid UTF-8').not.toThrow();
  });
});

describe('copies that must stay the same', () => {
  it('the Windows bridge raises none of the AI host apps: its denylist is AI_HOST_PROCESSES', () => {
    const m = /\$script:ForegroundDenylistProcs = @\(([^)]*)\)/.exec(read('scripts', 'ps-bridge.ps1'));
    expect(m, 'ForegroundDenylistProcs not found in ps-bridge.ps1').not.toBeNull();
    const names = [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1].toLowerCase());
    expect(names.sort()).toEqual([...AI_HOST_PROCESSES].sort());
  });
});

describe('files that must (not) be there', () => {
  it('every repo file linked from README, the site and llms.txt exists (docs/ is published as clawdcursor.com)', () => {
    const links = [
      ...[...read('README.md').matchAll(/\]\(([^)#:\s]+)[)#]/g)].map(m => m[1]),
      ...['README.md', 'docs/index.html', 'docs/llms.txt'].flatMap(f =>
        [...read(f).matchAll(/github\.com\/AmrDab\/clawdcursor\/(?:blob|tree)\/main\/([^\s"')<>#]+)/g)].map(m => m[1])),
    ];
    expect(links.length).toBeGreaterThan(5);
    expect(links.filter(l => !fs.existsSync(path.join(ROOT, l)))).toEqual([]);
  });

  it('the glow drawer is gone and nothing spawns it', () => {
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'edge-glow.ps1'))).toBe(false);
    for (const src of [read('src', 'core', 'banner.ts'), read('scripts', 'mac', 'overlay.swift'), read('scripts', 'linux', 'overlay.py')]) {
      expect(src).not.toMatch(/edge-glow|['"]glow['"]|CLAWD_NO_GLOW/);
    }
  });

  it('the beam and the orb carry the library\'s licence notice (#392)', () => {
    const ps = read('scripts', 'window-outline.ps1');
    expect(ps).toContain('Border Beam - MIT License - Copyright (c) 2026 Jakub Antalik');
    expect(ps).toContain('The above copyright notice and this permission notice shall be included in all copies or substantial portions of');
    expect(read('scripts', 'mac', 'overlay.swift')).toContain('MIT License,\n// Copyright (c) 2026 Jakub Antalik');
    expect(read('scripts', 'banner.ps1')).toContain('MIT License, Copyright (c) 2026 Jakub');
  });
});
