# window-outline.ps1 - a thin border around the window the agent is working in.
#
# Spawned/killed by src/core/banner.ts in lockstep with the control-banner pill. It draws ONLY the border: the window is
# cut to a hollow frame (a window region), so there is nothing over the content and nothing on the rest of the screen.
#
# stdin, from the parent:
#   TARGET <hwnd> <pid>   the window to outline (the pid is for the macOS drawer; ignored here)
#   TARGET                no window: draw nothing
# The border is shown while that window is the one in front and not minimized, and follows it as it moves or resizes
# (polled every 100 ms). It starts with no window. The parent kills this process to remove it.
#
# Extended window styles (the pill's zero-focus contract, plus click-through - it is up WHILE the agent types/clicks):
#   WS_EX_LAYERED      0x00080000  with WS_EX_TRANSPARENT: input falls through to the app below
#   WS_EX_TRANSPARENT  0x00000020  click-through
#   WS_EX_NOACTIVATE   0x08000000  never steals focus (agent keeps typing)
#   WS_EX_TOOLWINDOW   0x00000080  no taskbar / alt-tab entry
#   WS_EX_TOPMOST      0x00000008  stays above the window it outlines
#
# The Windows drawer; macOS and Linux use scripts/mac/overlay.swift and scripts/linux/overlay.py (`outline`).

param(
    [string]$Color     = '#f59e0b',  # border colour (amber - "in progress"; the paused form passes blue)
    [int]   $Thickness = 3           # px at 100% scaling; scaled by the DPI of the window's monitor
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class WindowOutline : Form {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, int flags);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x00080000; // WS_EX_LAYERED
            cp.ExStyle |= 0x00000020; // WS_EX_TRANSPARENT (click-through)
            cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
            cp.ExStyle |= 0x00000008; // WS_EX_TOPMOST
            return cp;
        }
    }
    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        SetLayeredWindowAttributes(Handle, 0, 255, 2); // LWA_ALPHA, opaque: a layered window draws nothing until told how
        // For the person at the screen only: WDA_EXCLUDEFROMCAPTURE (0x11) keeps the border out of screenshots and OCR
        // (Windows 10 2004+; older Windows ignores it).
        try { SetWindowDisplayAffinity(Handle, 0x11); } catch { }
    }

    IntPtr target = IntPtr.Zero;   // written by the stdin thread, read by the timer
    RECT last;
    bool shown;
    int thickness;
    Timer poll;

    public void Start(int thicknessAt96) {
        thickness = thicknessAt96;
        IntPtr created = Handle;   // the window exists (hidden) before the timer or stdin touch it
        var t = new System.Threading.Thread(() => {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    string[] p = line.Trim().Split(' ');
                    long h = 0;
                    if (p[0] != "TARGET") continue;
                    if (p.Length > 1) long.TryParse(p[1], out h);
                    target = new IntPtr(h);
                }
            } catch { }
        });
        t.IsBackground = true;
        t.Start();
        poll = new Timer();
        poll.Interval = 100;
        poll.Tick += (s, e) => Follow();
        poll.Start();
    }

    void Follow() {
        IntPtr t = target;
        RECT r = new RECT();
        // The visible frame (DWMWA_EXTENDED_FRAME_BOUNDS = 9), not GetWindowRect, which includes invisible resize borders.
        bool on = t != IntPtr.Zero && GetForegroundWindow() == t && !IsIconic(t)
            && DwmGetWindowAttribute(t, 9, out r, 16) == 0 && r.Right > r.Left && r.Bottom > r.Top;
        if (!on) {
            if (shown) { ShowWindow(Handle, 0); shown = false; } // SW_HIDE
            return;
        }
        if (shown && r.Left == last.Left && r.Top == last.Top && r.Right == last.Right && r.Bottom == last.Bottom) return;
        int w = r.Right - r.Left, h = r.Bottom - r.Top;
        uint dpi, dpiY;
        if (GetDpiForMonitor(MonitorFromWindow(t, 2), 0, out dpi, out dpiY) != 0) dpi = 96; // MONITOR_DEFAULTTONEAREST, MDT_EFFECTIVE_DPI
        int b = Math.Max(2, (int)Math.Round(thickness * dpi / 96.0));
        // Just inside the frame, so a maximized window's border is on screen too. The middle is not part of this window.
        Region frame = new Region(new Rectangle(0, 0, w, h));
        if (w > 2 * b && h > 2 * b) frame.Exclude(new Rectangle(b, b, w - 2 * b, h - 2 * b));
        Region = frame;
        SetWindowPos(Handle, new IntPtr(-1), r.Left, r.Top, w, h, 0x0050); // HWND_TOPMOST; SWP_NOACTIVATE | SWP_SHOWWINDOW
        last = r;
        shown = true;
    }
}
'@

# Per-monitor-v2, like ps-bridge.ps1: the frame bounds and this window's position are PHYSICAL pixels on every monitor.
[void][WindowOutline]::SetThreadDpiAwarenessContext([IntPtr](-4))

$hex  = $Color.TrimStart('#')
$form = New-Object WindowOutline
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar   = $false
$form.StartPosition   = 'Manual'
$form.BackColor       = [System.Drawing.Color]::FromArgb(
    [Convert]::ToInt32($hex.Substring(0,2),16), [Convert]::ToInt32($hex.Substring(2,2),16), [Convert]::ToInt32($hex.Substring(4,2),16))
$form.Start($Thickness)
[System.Windows.Forms.Application]::Run()
