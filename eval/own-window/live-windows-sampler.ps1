<#
.SYNOPSIS
  Sampler for eval/own-window/live-windows.mjs (Windows PowerShell 5.1). Not meant to be run by hand.
.DESCRIPTION
  Prints READY, then one line every ~50 ms until it is killed:  S|<unix ms>|<foreground hwnd>|<pid>|<cursor x>|<cursor y>
  Read-only: it looks at the foreground window and the real cursor and does nothing else.
#>
param([int]$IntervalMs = 50)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LwSample {
    [StructLayout(LayoutKind.Sequential)] struct PT { public int X; public int Y; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out PT p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    public static void Init() { SetProcessDPIAware(); }
    public static string Line(long ms) {
        IntPtr h = GetForegroundWindow(); uint pid = 0; PT p;
        if (h != IntPtr.Zero) GetWindowThreadProcessId(h, out pid);
        GetCursorPos(out p);
        return "S|" + ms + "|" + h.ToInt64() + "|" + pid + "|" + p.X + "|" + p.Y;
    }
}
'@
[LwSample]::Init()
$out = [Console]::Out
$out.WriteLine('READY'); $out.Flush()
$epoch = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
$sw = [Diagnostics.Stopwatch]::StartNew()
$next = 0
while ($true) {
    $ms = [long]([DateTime]::UtcNow - $epoch).TotalMilliseconds
    $out.WriteLine([LwSample]::Line($ms)); $out.Flush()
    $next += $IntervalMs
    $wait = $next - $sw.ElapsedMilliseconds
    if ($wait -gt 0) { [Threading.Thread]::Sleep([int]$wait) } else { $next = $sw.ElapsedMilliseconds }
}
