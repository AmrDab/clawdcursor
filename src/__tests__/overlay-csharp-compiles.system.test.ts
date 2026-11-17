/**
 * The Windows drawers are C# compiled at run time: Add-Type in scripts/window-outline.ps1 (the outline) and
 * scripts/banner.ps1 (the pill and its orb). Their spawn errors go nowhere, so a compile error means no outline or no
 * pill, and nothing says so. Here the C# of each is compiled the way the script compiles it (WinForms and System.Drawing
 * referenced), into a DLL in a temp folder. The types are only built, never used: no form, nothing on screen.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { powershellExe, psOpts } from '../platform/ps-spawn';

/** The C# of a script: the single-quoted here-string that `opener` (ending in @') starts. */
function csharp(file: string, opener: string): string {
  const ps = readFileSync(join(__dirname, '..', '..', 'scripts', file), 'utf8').replace(/\r\n/g, '\n');
  const at = ps.indexOf(`${opener}\n`);
  if (at < 0) throw new Error(`${file} has no ${opener}`);
  const start = at + opener.length + 1;
  return ps.slice(start, ps.indexOf("\n'@", start));
}

/** Add-Type, as the drawers call it, from a .cs file to a .dll in a temp folder that is removed afterwards. */
function compile(source: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'clawdcursor-overlay-cs-'));
  try {
    const cs = join(dir, 'overlay.cs');
    writeFileSync(cs, source, 'utf8');
    const quote = (p: string) => `'${p.replace(/'/g, "''")}'`;
    const command = `$ErrorActionPreference = 'Stop'; try { Add-Type -TypeDefinition ([System.IO.File]::ReadAllText(${quote(cs)})) `
      + `-ReferencedAssemblies System.Windows.Forms, System.Drawing -OutputType Library -OutputAssembly ${quote(join(dir, 'overlay.dll'))} } `
      + 'catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }';
    const r = spawnSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      psOpts({ encoding: 'utf8' as const, timeout: 60_000, windowsHide: true }));
    return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.runIf(process.platform === 'win32')('the Windows drawers\' C# compiles', () => {
  it('scripts/window-outline.ps1: the outline', () => {
    const source = csharp('window-outline.ps1', "$source = @'");
    expect(source).toContain('public class WindowOutline : Form');
    const r = compile(source);
    expect(r.status, r.output).toBe(0);
    expect(r.output).not.toMatch(/error|exception/i);
  }, 60_000);

  it('scripts/banner.ps1: the pill and its orb', () => {
    const source = csharp('banner.ps1', "-TypeDefinition @'");
    expect(source).toContain('public class NoActivateBannerForm : Form');
    expect(source).toContain('public class Orb : Control');
    const r = compile(source);
    expect(r.status, r.output).toBe(0);
    expect(r.output).not.toMatch(/error|exception/i);
  }, 60_000);
});
