/**
 * The bridge's capture-window, run for real: `system ocr` with processId reads that process's window BY ITSELF, so a
 * window behind others is read without what covers it, and nothing is raised or focused.
 *
 * A child PowerShell shows two windows of its own, neither activated, click-through and at 1% opacity (a window off every
 * monitor draws black): a white one with "QUOKKA 4462" and a red one on top of it, covering its left part. The real bridge captures the child's largest window: the white one,
 * with its text and without a single red pixel. Nothing of the user's desktop is captured or shown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { powershellExe, psOpts } from '../platform/ps-spawn';

const BRIDGE = path.join(__dirname, '..', '..', 'scripts', 'ps-bridge.ps1');

const FORMS = String.raw`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
public class QuietForm : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  // Click-through (WS_EX_TRANSPARENT) and never activated (WS_EX_NOACTIVATE): the user's clicks and focus are untouched.
  protected override System.Windows.Forms.CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x20 | 0x08000000; return p; } }
}
'@
# On screen (a window off every monitor draws black), in the primary monitor's bottom-right corner, at 1% opacity.
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$x = $wa.Right - 700; $y = $wa.Bottom - 300
function New-Quiet($w, $h, $color) {
  $f = New-Object QuietForm
  $f.StartPosition = 'Manual'; $f.ShowInTaskbar = $false; $f.FormBorderStyle = 'None'
  $f.Opacity = 0.01; $f.BackColor = $color; $f.Size = New-Object System.Drawing.Size $w, $h; $f.Location = New-Object System.Drawing.Point $x, $y
  return $f
}
$page = New-Quiet 640 240 ([System.Drawing.Color]::White)
$label = New-Object System.Windows.Forms.Label
$label.Text = 'QUOKKA 4462'; $label.AutoSize = $true; $label.ForeColor = [System.Drawing.Color]::Black
$label.Font = New-Object System.Drawing.Font('Arial', 36); $label.Location = New-Object System.Drawing.Point 220, 80
$page.Controls.Add($label)
$cover = New-Quiet 200 240 ([System.Drawing.Color]::Red)
$page.Show(); $cover.Show()
[Console]::Out.WriteLine("READY $PID"); [Console]::Out.Flush()
# Pump messages until the test is done (a file next to this script): PrintWindow waits for this thread to draw.
$done = Join-Path $PSScriptRoot 'done'
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 90 -and -not (Test-Path $done)) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 15 }
`;

function lines(proc: ChildProcess) {
  const rl = readline.createInterface({ input: proc.stdout! });
  const queue: string[] = [];
  const waiters: Array<(l: string) => void> = [];
  rl.on('line', l => { const w = waiters.shift(); if (w) w(l); else queue.push(l); });
  return (ms: number) => new Promise<string>((resolve, reject) => {
    const q = queue.shift();
    if (q !== undefined) return resolve(q);
    const t = setTimeout(() => reject(new Error('no reply in time')), ms);
    waiters.push(l => { clearTimeout(t); resolve(l); });
  });
}

describe.runIf(process.platform === 'win32')('ps-bridge capture-window (run for real, windows of a child process)', () => {
  let dir: string;
  let forms: ChildProcess;
  let bridge: ChildProcess;
  let reply: { success: boolean; x: number; y: number; width: number; height: number; imageWidth: number; imageHeight: number; title: string; png: string; reason?: string };
  let ocrText = '';
  let ocrReady = false;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-window-'));
    const script = path.join(dir, 'forms.ps1');
    fs.writeFileSync(script, FORMS);
    forms = spawn(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], psOpts({ stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    let err = '';
    forms.stderr!.on('data', d => { err += d; });
    const formLine = lines(forms);
    let pid = 0;
    const seen: string[] = [];
    while (!pid) {
      const l = await formLine(60_000).catch(() => { throw new Error(`the test windows did not start: ${seen.join(' | ')} ${err}`); });
      seen.push(l);
      pid = Number(/^READY (\d+)/.exec(l)?.[1] ?? 0);
    }

    bridge = spawn(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE], psOpts({ stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    const next = lines(bridge);
    for (;;) { const l = await next(60_000); try { if (JSON.parse(l).ready) break; } catch { /* a log line */ } }
    const ask = async (cmd: object) => { bridge.stdin!.write(JSON.stringify(cmd) + '\n'); return JSON.parse(await next(60_000)); };
    await new Promise(r => setTimeout(r, 500));   // the child has painted
    reply = await ask({ cmd: 'capture-window', pid });
    if (reply.success) {
      const png = path.join(dir, 'window.png');
      fs.writeFileSync(png, Buffer.from(reply.png, 'base64'));
      ocrReady = !!(await ask({ cmd: 'ocr', warm: true }))?.ready;
      if (ocrReady) {
        const r = await ask({ cmd: 'ocr', path: png });
        ocrText = String(r?.fullText ?? (r?.elements ?? []).map((e: { text: string }) => e.text).join(' '));
      }
    }
  }, 180_000);

  afterAll(() => {
    try { fs.writeFileSync(path.join(dir, 'done'), ''); } catch { /* gone */ }
    forms?.kill(); bridge?.kill();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('captures the largest window of the process, where it is, at its own size', () => {
    expect(reply).toMatchObject({ success: true });
    expect(reply.width).toBeGreaterThan(0);
    expect(reply.height).toBeGreaterThan(0);
    // The window's own size: the physical rect, or less for a window that is not DPI-aware (scaled up by the system).
    expect(reply.imageWidth).toBeGreaterThan(0);
    expect(reply.imageWidth).toBeLessThanOrEqual(reply.width);
    expect(reply.imageWidth / reply.imageHeight).toBeCloseTo(640 / 240, 1);
  });

  it('draws the window by itself: its text is there, the window on top of it is not', async () => {
    const { data, info } = await sharp(Buffer.from(reply.png, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let red = 0, dark = 0, white = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 200 && g < 60 && b < 60) red++;
      if (r < 60 && g < 60 && b < 60) dark++;
      if (r > 230 && g > 230 && b > 230) white++;
    }
    const all = info.width * info.height;
    expect(red).toBe(0);
    expect(white / all).toBeGreaterThan(0.5);        // the page itself (a window that did not draw is black)
    expect(dark).toBeGreaterThan(200);                // its text
    expect(dark / all).toBeLessThan(0.3);
  });

  it('the capture reads as text (when this machine has a Windows OCR language)', () => {
    if (!ocrReady) return;
    expect(ocrText.toUpperCase()).toContain('QUOKKA');
  });
});
