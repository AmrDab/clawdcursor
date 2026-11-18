<#
.SYNOPSIS
  Overlay recorder for eval/own-window/full-windows.mjs (Windows PowerShell 5.1). Not meant to be run by hand.
.DESCRIPTION
  Every ~500 ms, one line with the visible top-level windows of the test server's overlay processes (the pill, the outline,
  the glow: children of -ServerPid running banner.ps1 / window-outline.ps1 / edge-glow.ps1) and of the agent's own windows
  (-Pids). Never any other window, so nothing of the owner's is recorded.
    R|<unix ms>|<pid>,<kind>,<x>,<y>,<w>,<h>;...
  kind: pill | outline | glow | glow-blue (a glow started with -Color: the pause's) | target (a window of -Pids).
  Bounds in physical pixels; a target's are its visible frame (DWMWA_EXTENDED_FRAME_BOUNDS), as the outline draws round it.
#>
param([int]$ServerPid, [string]$Pids = '', [int]$IntervalMs = 500)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OvRec {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    public static void Init() { SetProcessDPIAware(); }
    // kinds: pid -> kind for the overlay processes and the agent's windows
    public static string Snapshot(Dictionary<int, string> kinds) {
        var parts = new List<string>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            string kind;
            if (!kinds.TryGetValue((int)pid, out kind)) return true;
            RECT r;
            if (kind == "target") { if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r); }
            else GetWindowRect(h, out r);
            int w = r.R - r.L, hh = r.B - r.T;
            if (w <= 0 || hh <= 0) return true;
            parts.Add(pid + "," + kind + "," + r.L + "," + r.T + "," + w + "," + hh);
            return true;
        }, IntPtr.Zero);
        return string.Join(";", parts);
    }
}
'@
[OvRec]::Init()
$targets = @($Pids -split ',' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
$out = [Console]::Out
$out.WriteLine('READY'); $out.Flush()
$epoch = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
$tick = 0
$overlays = @{}
while ($true) {
    # The server's own overlay processes, looked up again every third snapshot (the lookup takes most of a second): a pause
    # respawns them.
    if ($tick % 3 -eq 0) {
        $overlays = @{}
        foreach ($p in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ServerPid" -ErrorAction SilentlyContinue)) {
            $cmd = [string]$p.CommandLine
            $kind = if ($cmd -match 'banner\.ps1') { 'pill' } elseif ($cmd -match 'window-outline\.ps1') { 'outline' }
                    elseif ($cmd -match 'edge-glow\.ps1') { if ($cmd -match '-Color') { 'glow-blue' } else { 'glow' } } else { $null }
            if ($kind) { $overlays[[int]$p.ProcessId] = $kind }
        }
    }
    $tick++
    $kinds = New-Object 'System.Collections.Generic.Dictionary[int,string]'
    foreach ($t in $targets) { $kinds[$t] = 'target' }
    foreach ($k in $overlays.Keys) { $kinds[[int]$k] = [string]$overlays[$k] }
    $ms = [long]([DateTime]::UtcNow - $epoch).TotalMilliseconds
    $out.WriteLine("R|$ms|" + [OvRec]::Snapshot($kinds)); $out.Flush()
    Start-Sleep -Milliseconds $IntervalMs
}
