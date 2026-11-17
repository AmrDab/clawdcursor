<#
.SYNOPSIS
  Helper for eval/own-window/live-windows.mjs (Windows PowerShell 5.1). Not meant to be run by hand.

.DESCRIPTION
  Reads one JSON command per line on stdin, answers one JSON line on stdout.
    start  -> opens the fake user window "ClawdUser" (in front), the "ClawdTarget" form and a new Notepad; returns handles
    read   -> the text of every control it started (WM_GETTEXT) and the foreground window
    front  -> makes ClawdUser the foreground window again (setup only, never during a measured step)
    stop   -> closes everything it started, then exits
  Acts only on windows it started: every handle it touches is checked against the windows and pids it recorded.
  Notepad: used only when it is a NEW process with no restored text (the user's own Notepad windows are never touched).
#>
param([Parameter(Mandatory = $true)][string]$TempDir)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

if (-not ([System.Management.Automation.PSTypeName]'LwW32').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class LwW32 {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", EntryPoint = "PostMessageW")] static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)] static extern IntPtr SendMsgS(IntPtr h, uint m, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)] static extern IntPtr SendMsgB(IntPtr h, uint m, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
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
    public static string Title(long h) { StringBuilder sb = new StringBuilder(512); GetWindowText(new IntPtr(h), sb, 512); return sb.ToString(); }
    public static uint Pid(long h) { uint p; GetWindowThreadProcessId(new IntPtr(h), out p); return p; }
    public static bool Post(long h, uint m) { return PostMessageW(new IntPtr(h), m, IntPtr.Zero, IntPtr.Zero); }
    public static bool SetText(long h, string s) { IntPtr r; return SendMsgS(new IntPtr(h), 0x000C, IntPtr.Zero, s, 2, 1500, out r) != IntPtr.Zero; }
    // A control's text in another process: WM_GETTEXT.
    public static string GetText(long h) {
        StringBuilder sb = new StringBuilder(8192); IntPtr r;
        SendMsgB(new IntPtr(h), 0x000D, new IntPtr(8192), sb, 2, 1500, out r);
        return sb.ToString();
    }
    public static long[] TopLevel() {
        List<long> lst = new List<long>();
        EnumWindows(delegate(IntPtr h, IntPtr l) { if (IsWindowVisible(h)) lst.Add(h.ToInt64()); return true; }, IntPtr.Zero);
        return lst.ToArray();
    }
    // every descendant whose class contains `part` (WinForms classes carry a per-build suffix), in z-order
    public static long[] DescendantsLike(long root, string part) {
        List<long> lst = new List<long>();
        EnumChildWindows(new IntPtr(root), delegate(IntPtr h, IntPtr l) { if (Cls(h.ToInt64()).Contains(part)) lst.Add(h.ToInt64()); return true; }, IntPtr.Zero);
        return lst.ToArray();
    }
    // setup only: bring h to the front (a key event from this process lifts the foreground lock)
    public static bool ForceFg(long hv) {
        IntPtr h = new IntPtr(hv);
        IntPtr fg = GetForegroundWindow();
        uint dummy;
        uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out dummy);
        uint me = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        if (IsIconic(h)) ShowWindow(h, 9);
        keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(h);
        if (attached) AttachThreadInput(me, fgThread, false);
        return GetForegroundWindow() == h;
    }
}
'@
}
[LwW32]::DpiAware()

$out = [Console]::Out
function Reply($o) { $out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6)); $out.Flush() }

# what this helper started: top-level handles and pids it may touch
$S = @{ UserHwnd = 0L; UserPid = 0; UserEdit = 0L
        TargetHwnd = 0L; TargetPid = 0; Edit1 = 0L; Edit2 = 0L; Button = 0L; Label = 0L
        NotepadHwnd = 0L; NotepadPid = 0; NotepadEdit = 0L; NotepadOwned = $false
        Kill = (New-Object System.Collections.ArrayList); Roots = @{} }

function Assert-Mine($h) {
    $root = [LwW32]::Root($h)
    if ($root -eq $S.UserHwnd) { throw 'refused: that is the user window' }
    if (-not $S.Roots.ContainsKey([int64]$root)) { throw 'refused: window was not started by this helper' }
}

function Wait-NewWindow($before, [scriptblock]$match, $ms) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $ms) {
        foreach ($h in [LwW32]::TopLevel()) {
            if ($before.ContainsKey([int64]$h)) { continue }
            if (& $match $h) { return [int64]$h }
        }
        Start-Sleep -Milliseconds 150
    }
    return 0L
}

$UserForm = @'
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'ClawdUser'; $f.Width = 460; $f.Height = 160; $f.StartPosition = 'CenterScreen'
$t = New-Object System.Windows.Forms.TextBox
$t.Name = 'userBox'; $t.Left = 10; $t.Top = 10; $t.Width = 420; $t.Text = 'user-was-here'
$f.Controls.Add($t)
$f.Add_Shown({ $this.Activate(); $this.ActiveControl = $this.Controls['userBox']; $this.Controls['userBox'].Focus() })
[void][System.Windows.Forms.Application]::Run($f)
'@

# AccessibleName is what the accessibility tree calls the control, so the tools can address it by name.
$TargetForm = @'
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'ClawdTarget'; $f.Width = 460; $f.Height = 230; $f.StartPosition = 'CenterScreen'
$t1 = New-Object System.Windows.Forms.TextBox
$t1.Name = 'f1'; $t1.AccessibleName = 'ClawdField'; $t1.Left = 10; $t1.Top = 10; $t1.Width = 420; $t1.Text = 'start-one'
$t2 = New-Object System.Windows.Forms.TextBox
$t2.Name = 'f2'; $t2.AccessibleName = 'ClawdNote'; $t2.Left = 10; $t2.Top = 45; $t2.Width = 420; $t2.Text = 'start-two'
$b = New-Object System.Windows.Forms.Button
$b.Name = 'b'; $b.Text = 'ClawdGo'; $b.AccessibleName = 'ClawdGo'; $b.Left = 10; $b.Top = 85; $b.Width = 120
$l = New-Object System.Windows.Forms.Label
$l.Name = 'status'; $l.Text = 'idle'; $l.Left = 150; $l.Top = 90; $l.Width = 200
$b.Add_Click({ $this.FindForm().Controls['status'].Text = 'CLICKED' })
$f.Controls.Add($t1); $f.Controls.Add($t2); $f.Controls.Add($b); $f.Controls.Add($l)
[void][System.Windows.Forms.Application]::Run($f)
'@

function Start-FormProcess($name, $body) {
    $path = Join-Path $TempDir ($name + '.ps1')
    Set-Content -Path $path -Value $body -Encoding ASCII
    # powershell's own -WindowStyle hides only its console; Start-Process -WindowStyle Hidden would hide the form too.
    return (Start-Process powershell.exe -PassThru -ArgumentList @('-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $path))
}

function Cmd-Start {
    $r = [ordered]@{ ok = $true; notes = @() }
    $null = New-Item -ItemType Directory -Force -Path $TempDir

    $up = Start-FormProcess 'user' $UserForm
    $null = $S.Kill.Add([int]$up.Id); $S.UserPid = [int]$up.Id
    $S.UserHwnd = Wait-NewWindow @{} { param($h) [LwW32]::Pid($h) -eq $S.UserPid -and [LwW32]::Title($h) -eq 'ClawdUser' } 10000
    if (-not $S.UserHwnd) { throw 'the ClawdUser form did not appear' }
    $e = [LwW32]::DescendantsLike($S.UserHwnd, '.EDIT.')
    if ($e.Count -lt 1) { throw 'cannot find the ClawdUser text box' }
    $S.UserEdit = $e[0]

    $tp = Start-FormProcess 'target' $TargetForm
    $null = $S.Kill.Add([int]$tp.Id); $S.TargetPid = [int]$tp.Id
    $S.TargetHwnd = Wait-NewWindow @{} { param($h) [LwW32]::Pid($h) -eq $S.TargetPid -and [LwW32]::Title($h) -eq 'ClawdTarget' } 10000
    if (-not $S.TargetHwnd) { throw 'the ClawdTarget form did not appear' }
    $S.Roots[[int64]$S.TargetHwnd] = $true
    foreach ($h in [LwW32]::DescendantsLike($S.TargetHwnd, '.EDIT.')) {
        $t = [LwW32]::GetText($h)
        if ($t -eq 'start-one') { $S.Edit1 = $h } elseif ($t -eq 'start-two') { $S.Edit2 = $h }
    }
    $btn = [LwW32]::DescendantsLike($S.TargetHwnd, '.BUTTON.'); if ($btn.Count) { $S.Button = $btn[0] }
    $lab = [LwW32]::DescendantsLike($S.TargetHwnd, '.STATIC.'); if ($lab.Count) { $S.Label = $lab[0] }
    if (-not ($S.Edit1 -and $S.Edit2 -and $S.Button -and $S.Label)) { throw 'cannot find the ClawdTarget controls' }

    # Notepad: a NEW process only, with no restored text. Win11 Notepad can reuse a process or open a tab in a window
    # the user has: then the Notepad step is skipped rather than risk their text.
    $before = @{}; foreach ($h in [LwW32]::TopLevel()) { $before[[int64]$h] = $true }
    $pre = @{}; foreach ($p in (Get-Process -Name notepad -ErrorAction SilentlyContinue)) { $pre[[int]$p.Id] = $true }
    $null = Start-Process notepad.exe -PassThru
    $nh = Wait-NewWindow $before { param($h) [LwW32]::Cls($h) -eq 'Notepad' } 10000
    if (-not $nh) { $r.notes += 'no new Notepad window appeared (it may have opened as a tab of one the user has): Notepad step skipped' }
    else {
        $np = [int][LwW32]::Pid($nh)
        if ($pre.ContainsKey($np)) {
            $r.notes += "the new Notepad window belongs to process $np which already existed (yours): Notepad step skipped, that window is left open"
        } else {
            $S.NotepadHwnd = $nh; $S.NotepadPid = $np; $S.NotepadOwned = $true
            $null = $S.Kill.Add($np); $S.Roots[[int64]$nh] = $true
            $ed = @(([LwW32]::DescendantsLike($nh, 'RichEdit')) + ([LwW32]::DescendantsLike($nh, 'Edit')))
            if ($ed.Count) { $S.NotepadEdit = $ed[0] }
            if (-not $S.NotepadEdit) { $r.notes += 'cannot find the Notepad edit control: Notepad step skipped'; $S.NotepadOwned = $false }
            elseif (([LwW32]::GetText($S.NotepadEdit)).Trim() -ne '') {
                $r.notes += 'Notepad opened with restored text: Notepad step skipped, nothing of yours is overwritten'; $S.NotepadOwned = $false
            }
        }
    }
    $r.user = [ordered]@{ hwnd = $S.UserHwnd; pid = $S.UserPid; edit = $S.UserEdit; text = [LwW32]::GetText($S.UserEdit) }
    $r.target = [ordered]@{ hwnd = $S.TargetHwnd; pid = $S.TargetPid }
    $r.notepad = [ordered]@{ usable = $S.NotepadOwned; hwnd = $S.NotepadHwnd; pid = $S.NotepadPid }
    return $r
}

function Cmd-Read {
    $fg = [LwW32]::Fg()
    $r = [ordered]@{ ok = $true; fg = $fg; fgPid = [int][LwW32]::Pid($fg)
        userText = [LwW32]::GetText($S.UserEdit) }
    if ($S.TargetHwnd) {
        $r.f1 = [LwW32]::GetText($S.Edit1); $r.f2 = [LwW32]::GetText($S.Edit2)
        $r.label = [LwW32]::GetText($S.Label); $r.targetTitle = [LwW32]::Title($S.TargetHwnd)
    }
    if ($S.NotepadOwned) { $r.notepad = [LwW32]::GetText($S.NotepadEdit) }
    return $r
}

function Cmd-Front {
    for ($i = 0; $i -lt 6; $i++) {
        if ([LwW32]::Fg() -eq $S.UserHwnd) { return [ordered]@{ ok = $true; front = $true } }
        $null = [LwW32]::ForceFg($S.UserHwnd)
        Start-Sleep -Milliseconds 150
    }
    return [ordered]@{ ok = $true; front = ([LwW32]::Fg() -eq $S.UserHwnd) }
}

function Cmd-Stop {
    $left = @()
    try {
        if ($S.NotepadOwned) { try { Assert-Mine $S.NotepadEdit; $null = [LwW32]::SetText($S.NotepadEdit, '') } catch { } }   # no save prompt
        foreach ($h in @($S.NotepadHwnd, $S.TargetHwnd)) { if ($h) { try { Assert-Mine $h; $null = [LwW32]::Post($h, 0x10) } catch { } } }   # WM_CLOSE
        if ($S.UserHwnd) { $null = [LwW32]::Post($S.UserHwnd, 0x10) }
        Start-Sleep -Milliseconds 800
    } catch { }
    foreach ($id in $S.Kill) {
        try { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } } catch { }
    }
    foreach ($h in @($S.NotepadHwnd, $S.TargetHwnd, $S.UserHwnd)) {
        if ($h -and ([LwW32]::TopLevel() -contains [int64]$h)) { $left += ('"' + [LwW32]::Title($h) + '"') }
    }
    return [ordered]@{ ok = $true; stillOpen = $left }
}

try {
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        if (-not $line.Trim()) { continue }
        $isStop = $false
        try {
            $cmd = $line | ConvertFrom-Json
            $isStop = ($cmd.cmd -eq 'stop')
            switch ($cmd.cmd) {
                'start' { Reply (Cmd-Start) }
                'read'  { Reply (Cmd-Read) }
                'front' { Reply (Cmd-Front) }
                'stop'  { Reply (Cmd-Stop) }
                default { Reply ([ordered]@{ ok = $false; error = "unknown command $($cmd.cmd)" }) }
            }
        } catch { Reply ([ordered]@{ ok = $false; error = $_.Exception.Message }) }
        if ($isStop) { break }
    }
} finally {
    # stdin closed or a crash: still close what was started
    try { $null = Cmd-Stop } catch { }
}
