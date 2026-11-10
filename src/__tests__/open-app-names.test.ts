/**
 * open_app takes an application NAME (security review of #344). On Windows the name reaches Start-Process -FilePath, on
 * macOS `open -a`, on Linux an exec: a path there runs that file. Running a file is what open_file is for, and open_file
 * is the tool announced as destructive — so a path is refused here, on every OS, and the agent is pointed to open_file.
 */
import { describe, it, expect, vi } from 'vitest';
import { appNameRefusal } from '../core/router/aliases';
import { getOrchestrationTools } from '../tools/orchestration';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import { resolveInstalledWindowsApp, isAppShapedStartEntry } from '../platform/win-app-resolve';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolContext } from '../tools/types';

const PATHS = [
  'C:\\Windows\\System32\\calc.exe', 'c:/tools/x.exe', 'C:evil.exe', '\\\\server\\share\\payload.exe', '.\\payload.exe', './payload', '../payload',
  '/usr/bin/gnome-calculator', '/Applications/Calculator.app', '~/Downloads/installer', 'Downloads/setup.exe', 'sub\\tool.exe',
  'file:///C:/x.exe', 'https://example.com/app', '%TEMP%\\x.exe', '$HOME/x',
];
// Security scan: a protocol handler is not an app name either. Start-Process / open / xdg-open hand `scheme:…` to the
// registered handler, which is what open_uri does — and open_uri is the tool announced as destructive.
const URIS = [
  'ms-settings:', 'ms-settings:privacy-webcam', 'search-ms:query=x&crumb=location:C%3A', 'file:x', 'javascript:alert(1)', 'shell:AppsFolder',
  'calculator:', 'mailto:a@b.c', 'vscode:extension/x', 'x-apple.systempreferences:com.apple.preference.security', 'Notepad:', ':x', 'a:b:c',
];
// Not names either: percent-encoded separators, wildcards (a lookup would expand them), option-like or quoted strings,
// control characters.
const ODD = ['a%5Cb.exe', 'a%2Fb', '%2e%2e%5Cx', 'ms-settings%3A', '*', 'note*', 'calc?', '[a-z]otepad', '-ArgumentList', '--help', '"calc"', 'a|b', 'a<b', 'a>b', 'calc\nnotepad', 'calc\u0000', 'a;b', 'a`b', '$(calc)'];
const NAMES = ['Designcenter', 'Calculator', 'Microsoft Edge', 'notepad', 'Notepad++', 'Visual Studio Code', 'calc.exe', 'Designcenter NX 2506', '7-Zip', 'Adobe Acrobat (64-bit)', 'TextEdit', 'gnome-calculator', 'AT&T Connect', "Sam's Notes", 'Zed', 'olk'];

describe('appNameRefusal', () => {
  it.each(PATHS)('refuses the path %s and points to open_file', (p) => {
    expect(appNameRefusal(p)).toMatch(/takes an application name.*open_file/);
  });

  it.each(URIS)('refuses the protocol handler %s and points to open_uri', (u) => {
    expect(appNameRefusal(u)).toMatch(/takes an application name.*open_uri/);
  });

  it.each(ODD)('refuses %j', (o) => {
    expect(appNameRefusal(o)).toMatch(/takes an application name/);
  });

  it.each(NAMES)('accepts the name %s', (n) => {
    expect(appNameRefusal(n)).toBeNull();
  });

  it('an empty name is not a path refusal', () => {
    expect(appNameRefusal('')).toBeNull();
  });
});

describe('open_app refuses a path before anything is launched, on every OS', () => {
  const launchApp = vi.fn(async () => ({ pid: 1, title: 'x' }));
  const ctx = { ensureInitialized: async () => {}, platform: { platform: process.platform, launchApp }, a11y: { invalidateCache: () => {} } } as unknown as ToolContext;
  const mcp = getOrchestrationTools().find(t => t.name === 'open_app')!;
  const agent = buildUnifiedTools().find(t => t.name === 'open_app')!;

  it.each([...PATHS, ...URIS, ...ODD])('MCP open_app: %j', async (p) => {
    launchApp.mockClear();
    const r = await mcp.handler({ name: p }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/open_file/);
    expect(r.text).toMatch(/open_uri/);
    expect(launchApp).not.toHaveBeenCalled();
  });

  it.each([...PATHS, ...URIS, ...ODD])('agent-loop open_app: %j', async (p) => {
    launchApp.mockClear();
    const r = await agent.execute({ name: p }, { platform: { platform: process.platform, launchApp } } as never);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/open_file/);
    expect(r.text).toMatch(/open_uri/);
    expect(launchApp).not.toHaveBeenCalled();
  });

  it.each(['Designcenter', 'Calculator', 'Microsoft Edge'])('a normal name still launches: %s', async (n) => {
    launchApp.mockClear();
    const r = await mcp.handler({ name: n }, ctx);
    expect(r.isError).toBeFalsy();
    expect(launchApp).toHaveBeenCalledTimes(1);
  });
});

// A launch name outside the alias table is resolved to an INSTALLED APP first, and only that is started. Nothing is
// handed to a shell that could read it as a URI or a file, and no launcher search is typed: Start-menu search and
// Spotlight open the best match for the text, which can be a document called "payload.exe" (security re-review).
describe('a name outside the alias table only ever starts an installed app', () => {
  const launchApp = vi.fn(async (..._a: unknown[]) => ({ pid: 1, title: 'x' }));
  const ctx = { ensureInitialized: async () => {}, platform: { platform: process.platform, launchApp }, a11y: { invalidateCache: () => {} } } as unknown as ToolContext;
  const mcp = getOrchestrationTools().find(t => t.name === 'open_app')!;
  const agent = buildUnifiedTools().find(t => t.name === 'open_app')!;
  const src = (file: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'platform', file), 'utf8');

  it('open_app marks a non-alias name as name-only, and an alias-table name as trusted', async () => {
    launchApp.mockClear();
    await mcp.handler({ name: 'Designcenter' }, ctx);
    await agent.execute({ name: 'payload.exe' }, { platform: { platform: process.platform, launchApp } } as never);
    await mcp.handler({ name: 'Calculator' }, ctx);
    expect(launchApp.mock.calls[0][1]).toMatchObject({ nameOnly: true });
    expect(launchApp.mock.calls[1][1]).toMatchObject({ nameOnly: true });
    expect((launchApp.mock.calls[2][1] as { nameOnly?: boolean }).nameOnly).toBeFalsy();
  });

  it('the Windows resolver never looks up a string the shell could read as a URI or a path', async () => {
    for (const n of [...URIS, ...PATHS, ...ODD]) expect(await resolveInstalledWindowsApp(n), n).toBeNull();
  });

  it.runIf(process.platform === 'win32')('live (read-only): a program on PATH resolves to its full path, a Start-menu app to its app id, anything else to nothing', async () => {
    const notepad = await resolveInstalledWindowsApp('notepad');
    expect(notepad?.path ?? notepad?.appId).toBeTruthy();
    if (notepad?.path) expect(notepad.path).toMatch(/^[A-Za-z]:\\.+\.exe$/i);
    expect(await resolveInstalledWindowsApp('no-such-app-clawdcursor-test')).toBeNull();
    expect(await resolveInstalledWindowsApp('payload.exe')).toBeNull();
  }, 60_000);

  // Security scan: the Start menu also lists URL and document shortcuts, and a loose match could pick an unrelated
  // entry ("a", "Uninstall"). An entry is accepted only if it has an app's shape, and only when its name IS the name asked for.
  it('a Start-menu entry is accepted only with an app\'s shape: a packaged app id, or a shortcut to a .exe / .com', () => {
    const BS = String.fromCharCode(92);
    const EXE = `C:${BS}Program Files${BS}App${BS}app.exe`;
    const ok: Array<[string, string | undefined]> = [
      ['Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', undefined],
      ['Microsoft.MicrosoftEdge.Stable_8wekyb3d8bbwe!App', undefined],
      ['MSEdge', EXE], ['Chrome', EXE], ['Microsoft.AutoGenerated.{DD5977FE-DFC1-BB68-CB35-4583CADF9119}', EXE],
      [`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}${BS}notepad.exe`, EXE], [EXE, EXE], ['Microsoft.Office.WINWORD.EXE.15', EXE.replace('.exe', '.COM')],
    ];
    for (const [id, target] of ok) expect(isAppShapedStartEntry(id, target), id).toBe(true);
    const bad: Array<[string, string | undefined]> = [
      ['MSEdge', undefined], ['MSEdge', ''],                           // a classic id with no program behind it
      ['Microsoft.AutoGenerated.{AAAA}', EXE.replace('app.exe', 'report.docx')], ['Docs', EXE.replace('.exe', '.lnk')], ['Script', EXE.replace('.exe', '.bat')],
      ['https://example.com/', EXE], ['Site', 'https://example.com/app.exe'], ['ms-settings:display', EXE], ['Settings', 'ms-settings:display'],
      ['file:///C:/x.exe', EXE], ['App', 'file:///C:/x.exe'], ['App', `${BS}${BS}server${BS}share${BS}x.exe`], ['App', `C:${BS}a:b${BS}x.exe`],
      ['a"b', EXE], ['a|b', EXE], ['a*b', EXE], ['a\nb', EXE], ['App', `${EXE} /evil`], ['App', `${EXE}"`], ['Pkg!App!x', undefined], ['!App', undefined], ['Pkg!', undefined],
      ['Pkg!App', 'https://x'], ['', EXE], [`D:${BS}x:y`, EXE],
    ];
    for (const [id, target] of bad) expect(isAppShapedStartEntry(id, target), `${id} → ${target}`).toBe(false);
  });

  it('Start-menu names match exactly (any case): no prefix, no substring', () => {
    const w = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'platform', 'win-app-resolve.ts'), 'utf8');
    expect(w).not.toMatch(/IndexOf\(|StartsWith\(|-like|-match \$n/);
    expect(w).toMatch(/\$_\.Name -eq \$n/);   // PowerShell -eq on strings ignores case
  });

  it.runIf(process.platform === 'win32')('live (read-only): the apps people ask for still resolve, to something app-shaped; a prefix or a fragment does not', async () => {
    for (const name of ['notepad', 'Calculator', 'Microsoft Edge', 'calculator', 'MICROSOFT EDGE']) {
      const hit = await resolveInstalledWindowsApp(name);
      expect(hit, name).not.toBeNull();
      if (hit?.appId) expect(isAppShapedStartEntry(hit.appId, hit.target), name).toBe(true);
    }
    for (const name of ['Calc', 'Microsoft', 'Uninstall', 'a', 'alculato']) {
      const hit = await resolveInstalledWindowsApp(name);
      expect(hit?.appId, name).toBeUndefined();   // only a real program of that name on PATH could answer
    }
  }, 120_000);

  it('Windows: a name-only launch starts the resolved program or app id, and never types into the Start menu', () => {
    const w = src('windows.ts');
    const nameOnly = w.slice(w.indexOf('// Name-only launch'), w.indexOf('// Route 1:'));
    expect(nameOnly).toMatch(/resolveInstalledWindowsApp\(name\)/);
    expect(nameOnly).toMatch(/if \(!app\) return \{\};/);
    expect(nameOnly).not.toMatch(/launchViaStartMenuSearch|CLAWD_PS_FILE: name\b/);
    // Everything after it is for trusted names only.
    expect(w.slice(w.indexOf('// Route 1:'), w.indexOf('private async foregroundLaunched')).match(/launchViaStartMenuSearch/g)?.length).toBeGreaterThan(0);
  });

  it('macOS: a name-only launch uses `open -a` (applications only) and never types into Spotlight', () => {
    const m = src('macos.ts');
    const tail = m.slice(m.indexOf("const args = ['-a', name];"), m.indexOf('const viaSpotlight = await this.launchViaSpotlight'));
    expect(tail).toMatch(/if \(opts\?\.nameOnly\) return \{\};/);
  });

  it('Linux: an app name is only ever an executable on PATH or a .desktop entry; xdg-open is for URLs and paths', () => {
    const l = src('linux.ts');
    expect(l).toMatch(/\(opts\?\.url \|\| \/\[\/:\]\/\.test\(name\)\) && await this\.hasBinary\('xdg-open'\)/);
  });
});
