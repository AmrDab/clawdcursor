<#
.SYNOPSIS
  Windows canvas probe for the own-window plan: does a BACKGROUND canvas/viewport accept a properly-formed posted
  mouse click and drag (no focus steal, no cursor move)?

.DESCRIPTION
  Measurement only. See eval/own-window/README.md ("Canvas probe"). Windows PowerShell 5.1.
  NO injection, NO hooking, NO DLL loaded into another process: only PostMessage / SendMessageTimeout.
  Opens a fake user window "ClawdUser" (kept in front) and, one at a time: our own cooperative canvas
  (a WinForms Panel compiled from C# with csc.exe, logging every mouse message it receives), and mspaint.exe.
  Siemens NX: only noted when ugraf.exe runs, never driven (TODO: drive it with its own empty part).
  Closes everything it opened in finally.

.PARAMETER DryRun
  Print the plan and what is installed; launch nothing, compile nothing, send nothing.
.PARAMETER Targets
  Subset of: canvas, mspaint, nx.
.PARAMETER OutDir
  Where results\canvas-windows-<timestamp>.jsonl goes (default: results\ next to this script).
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [ValidateSet('canvas', 'mspaint', 'nx')]
    [string[]]$Targets = @('canvas', 'mspaint', 'nx'),
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$SettleMs = 400
$StepMs = 20               # pause between posted events
$DragPoints = 12
$Ops = @('click', 'drag')
$Modes = @('post', 'send') # PostMessage / SendMessageTimeout (SMTO_ABORTIFHUNG, 1500 ms)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutDir) { $OutDir = Join-Path $here 'results' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$PlanText = [ordered]@{
    canvas  = 'our own WinForms canvas "ClawdCanvas" (Panel logging every mouse message to a file), compiled with csc.exe into a temp dir'
    mspaint = 'a new mspaint.exe window; the canvas region is read back with PrintWindow before/after'
    nx      = 'Siemens NX (ugraf.exe): noted only if running, NEVER driven (TODO: own empty part)'
}
$CscPath = Join-Path ([System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'

if ($DryRun) {
    Write-Host 'DRY RUN: nothing will be opened, compiled or sent.'
    Write-Host 'It would open the fake user window "ClawdUser", then one target at a time:'
    foreach ($n in $Targets) {
        $why = switch ($n) {
            'canvas'  { if (Test-Path $CscPath) { $null } else { 'csc.exe not found' } }
            'mspaint' { if (Get-Command mspaint.exe -ErrorAction SilentlyContinue) { $null } else { 'not installed' } }
            'nx'      { $null }
        }
        $state = if ($why) { "SKIP ($why)" } else { 'would run' }
        Write-Host ('  - {0,-8} {1}: {2}' -f $n, $state, $PlanText[$n])
    }
    if ($Targets -contains 'nx') {
        $nxState = if (Get-Process -Name ugraf -ErrorAction SilentlyContinue) { 'ugraf.exe is running: would record "NX present, not driven"' } else { 'ugraf.exe not running: would record "NX not running"' }
        Write-Host ('  nx detail: ' + $nxState)
    }
    Write-Host ('Per target (not nx): ops {0} x modes {1}; each row records received / effect / foreground stolen / cursor moved.' -f ($Ops -join ','), ($Modes -join ','))
    Write-Host ('Click = WM_MOUSEACTIVATE, WM_SETCURSOR, WM_MOUSEMOVE, WM_LBUTTONDOWN(MK_LBUTTON), WM_LBUTTONUP at the deepest child HWND, client coordinates.')
    Write-Host ('Drag  = the same prelude, WM_LBUTTONDOWN, {0} WM_MOUSEMOVE with MK_LBUTTON, WM_LBUTTONUP.' -f $DragPoints)
    Write-Host ('Output would go to {0}\canvas-windows-{1}.jsonl' -f $OutDir, $stamp)
    return
}

Write-Host 'This probe will now OPEN windows and POST mouse messages to them. Hands off mouse and keyboard until it finishes (about 1 minute).'
foreach ($n in $Targets) { Write-Host ('  - {0}: {1}' -f $n, $PlanText[$n]) }
Write-Host 'Everything it opens is closed at the end.'

# ---------------------------------------------------------------- win32 (subset of probe-windows.ps1 ClawdW32, plus child resolve and PrintWindow)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ([System.Management.Automation.PSTypeName]'ClawdCW').Type) {
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public class ClawdSnap { public int W; public int H; public byte[] D; }

public static class ClawdCW {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] struct PT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] struct RC { public int L; public int T; public int R; public int B; }

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", EntryPoint = "PostMessageW")] static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint m, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeoutB(IntPtr h, uint m, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out PT p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref PT p);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RC r);
    [DllImport("user32.dll")] static extern IntPtr RealChildWindowFromPoint(IntPtr parent, PT p);
    [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr parent, PT p, uint flags);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    public static void DpiAware() { SetProcessDPIAware(); }
    public static long Fg() { return GetForegroundWindow().ToInt64(); }
    public static long Root(long h) { return GetAncestor(new IntPtr(h), 2).ToInt64(); }
    public static string Cls(long h) { StringBuilder sb = new StringBuilder(256); GetClassName(new IntPtr(h), sb, 256); return sb.ToString(); }
    public static string Txt(long h) { StringBuilder sb = new StringBuilder(512); GetWindowText(new IntPtr(h), sb, 512); return sb.ToString(); }
    public static uint Pid(long h) { uint p; GetWindowThreadProcessId(new IntPtr(h), out p); return p; }
    public static int[] Cursor() { PT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
    public static int[] Rect(long h) { RC r; GetWindowRect(new IntPtr(h), out r); return new int[] { r.L, r.T, r.R, r.B }; }
    public static int[] ToClient(long h, int x, int y) { PT p = new PT(); p.X = x; p.Y = y; ScreenToClient(new IntPtr(h), ref p); return new int[] { p.X, p.Y }; }
    public static long LParam(int x, int y) { return (long)(uint)(((y & 0xFFFF) << 16) | (x & 0xFFFF)); }

    // true when the post was queued / the send was answered inside 1500 ms (SMTO_ABORTIFHUNG)
    public static bool Msg(long h, uint m, long w, long l, bool send) {
        if (!send) return PostMessageW(new IntPtr(h), m, new IntPtr(w), new IntPtr(l));
        IntPtr res;
        return SendMessageTimeoutW(new IntPtr(h), m, new IntPtr(w), new IntPtr(l), 2, 1500, out res) != IntPtr.Zero;
    }

    // Deepest child HWND under a screen point: {hwnd, clientX, clientY}
    public static long[] Deepest(long top, int sx, int sy) {
        IntPtr cur = new IntPtr(top);
        for (int i = 0; i < 16; i++) {
            PT p = new PT(); p.X = sx; p.Y = sy; ScreenToClient(cur, ref p);
            IntPtr c = RealChildWindowFromPoint(cur, p);
            if (c == IntPtr.Zero || c == cur) c = ChildWindowFromPointEx(cur, p, 5);   // CWP_SKIPINVISIBLE | CWP_SKIPDISABLED
            if (c == IntPtr.Zero || c == cur) break;
            cur = c;
        }
        PT q = new PT(); q.X = sx; q.Y = sy; ScreenToClient(cur, ref q);
        return new long[] { cur.ToInt64(), q.X, q.Y };
    }

    public static long[] TopLevel() {
        List<long> lst = new List<long>();
        EnumWindows(delegate(IntPtr h, IntPtr l) { if (IsWindowVisible(h)) lst.Add(h.ToInt64()); return true; }, IntPtr.Zero);
        return lst.ToArray();
    }

    public static string GetText(long h) {
        StringBuilder sb = new StringBuilder(4096); IntPtr res;
        SendMessageTimeoutB(new IntPtr(h), 0x000D, new IntPtr(4096), sb, 2, 1500, out res);
        return sb.ToString();
    }
    public static long DescendantLike(long root, string part) {
        long found = 0;
        EnumChildWindows(new IntPtr(root), delegate(IntPtr h, IntPtr l) {
            if (Cls(h.ToInt64()).Contains(part)) { found = h.ToInt64(); return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // PrintWindow (PW_RENDERFULLCONTENT) of a top-level window into BGRA bytes; origin = the window rect's top-left
    public static ClawdSnap Capture(long hv) {
        RC r; GetWindowRect(new IntPtr(hv), out r);
        int w = r.R - r.L, h = r.B - r.T;
        ClawdSnap s = new ClawdSnap(); s.W = w; s.H = h;
        using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
            using (Graphics g = Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); PrintWindow(new IntPtr(hv), dc, 2); g.ReleaseHdc(dc); }
            BitmapData d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            s.D = new byte[d.Stride * h];
            Marshal.Copy(d.Scan0, s.D, 0, s.D.Length);
            bmp.UnlockBits(d);
        }
        return s;
    }
    // pixels inside [x0,x1) x [y0,y1) (bitmap coordinates) whose colour differs by more than 8; -1 when the sizes differ
    public static int Diff(ClawdSnap a, ClawdSnap b, int x0, int y0, int x1, int y1) {
        if (a.W != b.W || a.H != b.H) return -1;
        x0 = Math.Max(0, x0); y0 = Math.Max(0, y0); x1 = Math.Min(a.W, x1); y1 = Math.Min(a.H, y1);
        int n = 0;
        for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) {
            int i = (y * a.W + x) * 4;
            if (Math.Abs(a.D[i] - b.D[i]) > 8 || Math.Abs(a.D[i + 1] - b.D[i + 1]) > 8 || Math.Abs(a.D[i + 2] - b.D[i + 2]) > 8) n++;
        }
        return n;
    }

    public static bool ForceFg(long hv) {
        IntPtr h = new IntPtr(hv);
        IntPtr fg = GetForegroundWindow();
        uint dummy;
        uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out dummy);
        uint me = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        if (IsIconic(h)) ShowWindow(h, 9);
        keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);   // Alt tap lifts the foreground lock
        SetForegroundWindow(h);
        if (attached) AttachThreadInput(me, fgThread, false);
        return GetForegroundWindow() == h;
    }
}
'@
}
[ClawdCW]::DpiAware()

$UIA = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]

# ---------------------------------------------------------------- the cooperative canvas (C#), written to the temp dir and compiled
$CanvasSource = @'
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

class Pane : Panel {
    public StreamWriter Log;
    Bitmap bmp = new Bitmap(1600, 1200);
    Point last; bool down;
    public Pane() {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        using (Graphics g = Graphics.FromImage(bmp)) g.Clear(Color.White);
    }
    protected override void OnPaint(PaintEventArgs e) { e.Graphics.DrawImage(bmp, 0, 0); }
    void Dot(Point p) { using (Graphics g = Graphics.FromImage(bmp)) g.FillRectangle(Brushes.Black, p.X - 3, p.Y - 3, 7, 7); }
    protected override void WndProc(ref Message m) {
        long lp = m.LParam.ToInt64(), wp = m.WParam.ToInt64();
        Point pt = new Point((short)(lp & 0xFFFF), (short)((lp >> 16) & 0xFFFF));
        string name = null;
        switch (m.Msg) {
            case 0x21: name = "MOUSEACTIVATE"; break;
            case 0x20: name = "SETCURSOR"; break;
            case 0x200: name = "MOUSEMOVE"; break;
            case 0x201: name = "LBUTTONDOWN"; break;
            case 0x202: name = "LBUTTONUP"; break;
        }
        if (name != null) Log.WriteLine(name + " w=" + wp + " x=" + pt.X + " y=" + pt.Y + " lp=" + lp);
        if (m.Msg == 0x201) { down = true; last = pt; Dot(pt); Invalidate(); }
        else if (m.Msg == 0x200 && down && (wp & 1) != 0) {
            using (Graphics g = Graphics.FromImage(bmp)) g.DrawLine(new Pen(Color.Black, 5), last, pt);
            last = pt; Invalidate();
        }
        else if (m.Msg == 0x202) down = false;
        base.WndProc(ref m);
    }
}

static class P {
    [STAThread] static void Main(string[] a) {
        Form f = new Form(); f.Text = "ClawdCanvas"; f.Width = 520; f.Height = 380;
        f.StartPosition = FormStartPosition.Manual; f.Location = new Point(140, 140);
        Pane p = new Pane(); p.Dock = DockStyle.Fill;
        p.Log = new StreamWriter(new FileStream(a[0], FileMode.Append, FileAccess.Write, FileShare.ReadWrite)); p.Log.AutoFlush = true;
        f.Controls.Add(p);
        Application.Run(f);
    }
}
'@

# ---------------------------------------------------------------- state
$script:Rows = New-Object System.Collections.ArrayList
$script:OwnedRoots = @{}
$script:OwnedPids = @{}
$script:UserHwnd = 0L
$script:UserPid = 0
$script:UserEdit = 0L
$script:TempDir = Join-Path $env:TEMP ('clawd-canvas-' + $stamp)
$null = New-Item -ItemType Directory -Force -Path $script:TempDir
$null = New-Item -ItemType Directory -Force -Path $OutDir
$script:OutFile = Join-Path $OutDir ("canvas-windows-$stamp.jsonl")
$utf8 = New-Object System.Text.UTF8Encoding($false)
$script:Stolen = $null
$script:CursorMoved = $false
$script:Cursor0 = $null
$script:Calls = 0
$script:Answered = 0

function Write-Jsonl($obj) {
    [System.IO.File]::AppendAllText($script:OutFile, (($obj | ConvertTo-Json -Compress -Depth 5) + "`n"), $utf8)
}

# ---------------------------------------------------------------- guards, sampling, helpers
function Add-Owned($h) { $script:OwnedRoots[[int64][ClawdCW]::Root($h)] = $true }
function Assert-Sendable($h) {
    $root = [ClawdCW]::Root($h)
    if ($root -eq $script:UserHwnd -or [ClawdCW]::Pid($h) -eq $script:UserPid) { throw 'refused: that is the user window' }
    if (-not ($script:OwnedRoots.ContainsKey([int64]$root) -or $script:OwnedPids.ContainsKey([int][ClawdCW]::Pid($h)))) { throw 'refused: window was not started by this script' }
}
function Send-M($h, $msg, $w, $l, $mode) {
    Assert-Sendable $h
    $script:Calls++
    if ([ClawdCW]::Msg([int64]$h, [uint32]$msg, [int64]$w, [int64]$l, ($mode -eq 'send'))) { $script:Answered++ }
}

# foreground + real cursor, the live script's 50 ms sampling
function Sample {
    $fg = [ClawdCW]::Fg()
    if ($fg -ne $script:UserHwnd -and -not $script:Stolen) { $script:Stolen = ([ClawdCW]::Cls($fg) + ' "' + [ClawdCW]::Txt($fg) + '"') }
    $c = [ClawdCW]::Cursor()
    if ($script:Cursor0 -and ($c[0] -ne $script:Cursor0[0] -or $c[1] -ne $script:Cursor0[1])) { $script:CursorMoved = $true }
}
function Nap($ms) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do { Sample; Start-Sleep -Milliseconds ([int][Math]::Min(50, [Math]::Max(1, $ms - $sw.ElapsedMilliseconds))) } while ($sw.ElapsedMilliseconds -lt $ms)
    Sample
}

function Wait-NewWindow($before, [scriptblock]$match, $ms) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $ms) {
        foreach ($h in [ClawdCW]::TopLevel()) {
            if ($before.ContainsKey([int64]$h)) { continue }
            if (& $match $h) { return [int64]$h }
        }
        Start-Sleep -Milliseconds 200
    }
    return 0L
}
function Get-TopSet { $s = @{}; foreach ($h in [ClawdCW]::TopLevel()) { $s[[int64]$h] = $true }; return $s }

function Ensure-UserFront {
    for ($i = 0; $i -lt 6; $i++) {
        if ([ClawdCW]::Fg() -eq $script:UserHwnd) { return $true }
        $null = [ClawdCW]::ForceFg($script:UserHwnd)
        Start-Sleep -Milliseconds 150
    }
    return ([ClawdCW]::Fg() -eq $script:UserHwnd)
}

$UserFormScript = @'
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'ClawdUser'; $f.Width = 460; $f.Height = 160; $f.StartPosition = 'CenterScreen'
$t = New-Object System.Windows.Forms.TextBox
$t.Name = 'userBox'; $t.Left = 10; $t.Top = 10; $t.Width = 420; $t.Text = 'user-was-here'
$f.Controls.Add($t)
$f.Add_Shown({ $this.Activate(); $this.ActiveControl = $this.Controls['userBox']; $this.Controls['userBox'].Focus() })
[void][System.Windows.Forms.Application]::Run($f)
'@

function Start-FormProcess($name, $body) {
    $path = Join-Path $script:TempDir ($name + '.ps1')
    Set-Content -Path $path -Value $body -Encoding ASCII
    return (Start-Process powershell.exe -PassThru -ArgumentList @('-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $path))
}

# ---------------------------------------------------------------- targets
# Region = screen rectangle (l,t,r,b) where the clicks and drags go.
function Launch-Canvas($t) {
    if (-not (Test-Path $CscPath)) { $t.Skip = 'csc.exe not found'; return }
    $src = Join-Path $script:TempDir 'canvas.cs'; $exe = Join-Path $script:TempDir 'canvas.exe'
    Set-Content -Path $src -Value $CanvasSource -Encoding ASCII
    $out = & $CscPath /nologo /target:winexe "/out:$exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll $src 2>&1
    if (-not (Test-Path $exe)) { $t.Skip = 'canvas compile failed: ' + ($out -join ' '); return }
    $t.Log = Join-Path $script:TempDir 'canvas-events.log'
    Set-Content -Path $t.Log -Value '' -Encoding ASCII
    $p = Start-Process $exe -PassThru -ArgumentList ('"' + $t.Log + '"')
    $script:OwnedPids[[int]$p.Id] = $true; $t.KillPids += $p.Id
    $script:wPid = [uint32]$p.Id
    $h = Wait-NewWindow @{} { param($h) [ClawdCW]::Pid($h) -eq $script:wPid -and [ClawdCW]::Txt($h) -eq 'ClawdCanvas' } 10000
    if (-not $h) { $t.Skip = 'ClawdCanvas window did not appear'; return }
    $t.Top = $h; Add-Owned $h
    Start-Sleep -Milliseconds 500
    $r = [ClawdCW]::Rect($h)
    $d = [ClawdCW]::Deepest($h, [int](($r[0] + $r[2]) / 2), [int](($r[1] + $r[3]) / 2))
    $t.Region = [ClawdCW]::Rect($d[0])     # the panel's own rectangle
}

function Launch-Paint($t) {
    $pre = @{}; foreach ($p in (Get-Process -Name mspaint -ErrorAction SilentlyContinue)) { $pre[[int]$p.Id] = $true }
    $before = Get-TopSet
    $null = Start-Process mspaint.exe
    $h = Wait-NewWindow $before {
        param($h)
        if (-not [ClawdCW]::Txt($h)) { return $false }
        $q = Get-Process -Id ([int][ClawdCW]::Pid($h)) -ErrorAction SilentlyContinue
        return ($q -and $q.ProcessName -eq 'mspaint')
    } 15000
    if (-not $h) { $t.Skip = 'no new Paint window appeared'; return }
    $t.Top = $h; Add-Owned $h
    $pp = [int][ClawdCW]::Pid($h)
    if ($pre.ContainsKey($pp)) { $t.Note = 'Paint reused one of your running processes: window closed by WM_CLOSE only, process not killed' }
    else { $script:OwnedPids[$pp] = $true; $t.KillPids += $pp }
    Start-Sleep -Milliseconds 1500
    $r = [ClawdCW]::Rect($h)
    $w = $r[2] - $r[0]; $ht = $r[3] - $r[1]
    $region = @([int]($r[0] + 0.15 * $w), [int]($r[1] + 0.40 * $ht), [int]($r[0] + 0.45 * $w), [int]($r[1] + 0.65 * $ht))   # fallback: lower-left of the viewport
    try {   # prefer the largest UIA element whose name or id says "canvas"
        $root = $UIA::FromHandle([IntPtr]$h); $sw = [Diagnostics.Stopwatch]::StartNew(); $best = 0
        foreach ($e in $root.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
            if ($sw.ElapsedMilliseconds -gt 12000) { break }
            if (($e.Current.Name + ' ' + $e.Current.AutomationId) -notmatch 'canvas') { continue }
            $b = $e.Current.BoundingRectangle
            if ($b.IsEmpty -or [double]::IsInfinity($b.Width) -or $b.Width * $b.Height -le $best) { continue }
            $best = $b.Width * $b.Height
            $region = @([int]$b.Left, [int]$b.Top, [int]$b.Right, [int]$b.Bottom)
            $t.Note = 'canvas region from UIA element "' + $e.Current.Name + '"'
        }
    } catch { }
    if (-not $t.Note) { $t.Note = 'canvas region guessed (UIA found no element named canvas): tune if effect is no' }
    $t.Region = $region
}

function New-Target($name) { return @{ Name = $name; Skip = $null; Top = 0L; Region = $null; Log = $null; Note = ''; KillPids = @() } }

function Read-Log($t) {
    if (-not $t.Log) { return @() }
    $fs = [System.IO.File]::Open($t.Log, 'Open', 'Read', 'ReadWrite')
    try { $sr = New-Object System.IO.StreamReader($fs); return @(($sr.ReadToEnd() -split "`n") | Where-Object { $_ }) } finally { $fs.Dispose() }
}

# ---------------------------------------------------------------- one (target, op, mode) row
function Mk($lo, $hi) { return ([int64]$lo -bor ([int64]$hi -shl 16)) }

function Run-Op($t, $op, $mode, $idx) {
    $row = [ordered]@{ type = 'row'; ts = (Get-Date).ToString('o'); target = $t.Name; op = $op; mode = $mode
        received = 'n/a'; effect = 'unknown'; foregroundStolen = $false; cursorMoved = $false; detail = '' }
    try {
        if (-not (Ensure-UserFront)) { throw 'could not bring the user window to the front' }
        Start-Sleep -Milliseconds 100
        $script:Stolen = $null; $script:CursorMoved = $false; $script:Calls = 0; $script:Answered = 0
        $script:Cursor0 = [ClawdCW]::Cursor()
        $rg = $t.Region; $rw = $rg[2] - $rg[0]; $rh = $rg[3] - $rg[1]
        $dy = $idx * 18
        $top = $t.Top
        $wr = [ClawdCW]::Rect($top)
        $snapA = [ClawdCW]::Capture($top); Nap 100; $snapB = [ClawdCW]::Capture($top)
        $logBefore = (Read-Log $t).Count
        # points: click = one point; drag = a zigzag across the region (a different band per row so rows do not overdraw each other)
        if ($op -eq 'click') { $pts = @(, @(([int]($rg[0] + 0.5 * $rw)), ([int]($rg[1] + 0.55 * $rh + $dy)))) }
        else {
            $pts = @(); for ($i = 0; $i -lt $DragPoints; $i++) { $pts += , @(([int]($rg[0] + $rw * (0.2 + 0.6 * $i / ($DragPoints - 1)))), ([int]($rg[1] + 0.2 * $rh + $dy + ($i % 2) * 15))) }
        }
        $d = [ClawdCW]::Deepest($top, $pts[0][0], $pts[0][1])
        $h = $d[0]
        $row.detail = 'deepest child ' + [ClawdCW]::Cls($h) + '; '
        $lp0 = [ClawdCW]::LParam([int]$d[1], [int]$d[2])
        Send-M $h 0x21 $top (Mk 1 0x201) $mode        # WM_MOUSEACTIVATE (HTCLIENT, WM_LBUTTONDOWN)
        Send-M $h 0x20 $h (Mk 1 0x200) $mode          # WM_SETCURSOR (HTCLIENT, WM_MOUSEMOVE)
        Send-M $h 0x200 0 $lp0 $mode                  # WM_MOUSEMOVE
        Nap $StepMs
        Send-M $h 0x201 1 $lp0 $mode                  # WM_LBUTTONDOWN, MK_LBUTTON
        Nap $StepMs
        $lpLast = $lp0
        for ($i = 1; $i -lt $pts.Count; $i++) {
            $c = [ClawdCW]::ToClient($h, $pts[$i][0], $pts[$i][1])
            $lpLast = [ClawdCW]::LParam($c[0], $c[1])
            Send-M $h 0x200 1 $lpLast $mode           # WM_MOUSEMOVE with MK_LBUTTON held
            Nap $StepMs
        }
        Send-M $h 0x202 0 $lpLast $mode               # WM_LBUTTONUP
        Nap $SettleMs
        $row.foregroundStolen = [bool]$script:Stolen
        if ($script:Stolen) { $row.detail += 'foreground went to ' + $script:Stolen + '; ' }
        $row.cursorMoved = $script:CursorMoved
        $row.detail += ('{0}/{1} {2} calls ok; ' -f $script:Answered, $script:Calls, $(if ($mode -eq 'send') { 'sent' } else { 'posted' }))
        if ($t.Log) {
            $new = @((Read-Log $t) | Select-Object -Skip $logBefore)
            $cnt = { param($n) @($new | Where-Object { $_ -like "$n *" }).Count }
            $dn = & $cnt 'LBUTTONDOWN'; $up = & $cnt 'LBUTTONUP'; $mv = & $cnt 'MOUSEMOVE'
            $row.received = if ($dn -ge 1 -and $up -ge 1) { 'yes' } elseif ($new.Count) { 'partial' } else { 'no' }
            $row.detail += ('log: activate={0} setcursor={1} move={2} down={3} up={4}; ' -f (& $cnt 'MOUSEACTIVATE'), (& $cnt 'SETCURSOR'), $mv, $dn, $up)
        }
        $snapC = [ClawdCW]::Capture($top)
        $x0 = $rg[0] - $wr[0]; $y0 = $rg[1] - $wr[1]; $x1 = $rg[2] - $wr[0]; $y1 = $rg[3] - $wr[1]
        $noise = [ClawdCW]::Diff($snapA, $snapB, $x0, $y0, $x1, $y1)
        $changed = [ClawdCW]::Diff($snapB, $snapC, $x0, $y0, $x1, $y1)
        if ($changed -lt 0 -or $noise -lt 0) { $row.effect = 'unknown'; $row.detail += 'window size changed during the row; ' }
        else { $row.effect = if ($changed -gt $noise) { 'yes' } else { 'no' }; $row.detail += ('pixels changed {0} (noise {1}); ' -f $changed, $noise) }
        if ($row.received -eq 'n/a') { $row.received = 'n/a (inferred from effect)' }
    }
    catch { $row.effect = 'error'; $row.detail += $_.Exception.Message }
    [void]$script:Rows.Add($row); Write-Jsonl $row
}

function Close-Target($t) {
    try { if ($t.Top) { Send-M $t.Top 0x10 0 0 'post'; Start-Sleep -Milliseconds 1200 } } catch { }
    foreach ($id in $t.KillPids) { try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch { } }   # also dismisses a Paint save prompt
    if ($t.Top -and ([ClawdCW]::TopLevel() -contains [int64]$t.Top)) { Write-Host ('  note: window "' + [ClawdCW]::Txt($t.Top) + '" is still open (maybe a save prompt); close it by hand') }
}

function Run-Target($name) {
    Write-Host ("[{0}] starting" -f $name)
    if ($name -eq 'nx') {
        $nx = Get-Process -Name ugraf -ErrorAction SilentlyContinue
        $msg = if ($nx) { 'NX present, not driven' } else { 'NX not running' }
        Write-Host ('[nx] ' + $msg + ' (TODO: drive only an empty part of our own)')
        $row = [ordered]@{ type = 'row'; ts = (Get-Date).ToString('o'); target = 'nx'; op = '-'; mode = '-'; received = 'n/a'; effect = 'n/a'
            foregroundStolen = $false; cursorMoved = $false; detail = $msg + ' (skipped by design)' }
        [void]$script:Rows.Add($row); Write-Jsonl $row
        return
    }
    $t = New-Target $name
    try {
        switch ($name) {
            'canvas'  { Launch-Canvas $t }
            'mspaint' { if (Get-Command mspaint.exe -ErrorAction SilentlyContinue) { Launch-Paint $t } else { $t.Skip = 'not installed' } }
        }
        if (-not $t.Skip) {
            $i = 0
            foreach ($op in $Ops) { foreach ($m in $Modes) { Run-Op $t $op $m $i; $i++ } }
        }
    }
    catch { if (-not $t.Skip) { $t.Skip = 'setup error: ' + $_.Exception.Message } }
    finally { try { Close-Target $t } catch { } }
    if ($t.Note) { Write-Host ('  ' + $t.Note) }
    if ($t.Skip) {
        Write-Host ("[{0}] skipped: {1}" -f $name, $t.Skip)
        $row = [ordered]@{ type = 'row'; ts = (Get-Date).ToString('o'); target = $name; op = '-'; mode = '-'; received = 'n/a'; effect = 'n/a'
            foregroundStolen = $false; cursorMoved = $false; detail = 'skipped: ' + $t.Skip }
        [void]$script:Rows.Add($row); Write-Jsonl $row
    }
    elseif ($t.Note) { Write-Jsonl ([ordered]@{ type = 'note'; target = $name; note = $t.Note }) }
}

# ---------------------------------------------------------------- main
try {
    $up = Start-FormProcess 'user' $UserFormScript
    $script:UserPid = [int]$up.Id
    $script:wPid = [uint32]$up.Id
    $script:UserHwnd = Wait-NewWindow @{} { param($h) [ClawdCW]::Pid($h) -eq $script:wPid -and [ClawdCW]::Txt($h) -eq 'ClawdUser' } 10000
    if (-not $script:UserHwnd) { throw 'the ClawdUser form did not appear' }
    $script:UserEdit = [ClawdCW]::DescendantLike($script:UserHwnd, '.EDIT.')
    if (-not (Ensure-UserFront)) { throw 'cannot make ClawdUser the foreground window (Windows foreground lock); run from an interactive session' }
    Write-Host 'user window ready'
    foreach ($n in $Targets) { Run-Target $n }
}
finally {
    try { if ($script:UserPid) { Stop-Process -Id $script:UserPid -Force -ErrorAction SilentlyContinue } } catch { }
    try { Remove-Item -Recurse -Force -Path $script:TempDir -ErrorAction SilentlyContinue } catch { }
}

# ---------------------------------------------------------------- table
Write-Host ''
Write-Host '| app | op | mode | received | effect | foreground stolen | cursor moved |'
Write-Host '|---|---|---|---|---|---|---|'
foreach ($r in $script:Rows) {
    Write-Host ('| {0} | {1} | {2} | {3} | {4} | {5} | {6} |' -f $r.target, $r.op, $r.mode, $r.received, $r.effect,
        $(if ($r.foregroundStolen) { 'yes' } else { 'no' }), $(if ($r.cursorMoved) { 'yes' } else { 'no' }))
}
Write-Host ''
Write-Host ('JSON lines: ' + $script:OutFile)
