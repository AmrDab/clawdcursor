# window-outline.ps1 - a thin border around each window the agent works in.
#
# Spawned/killed by src/core/banner.ts in lockstep with the control-banner pill. It draws ONLY the border: the window is
# cut to a hollow frame (a window region), so there is nothing over the content and nothing on the rest of the screen.
#
# stdin, from the parent:
#   TARGET <hwnd> <pid> [<hwnd> <pid> ...]   the windows to outline (the pid is for the macOS drawer; ignored here)
#   TARGET                no window: draw nothing
#   HIDE <ms>             step aside for a screen capture (only sent after OUTLINE_CAPTURABLE)
#   GHOST <x> <y>         draw the agent's pointer at this screen point, if it is inside one of the outlined windows
#   GHOST                 hide it (it hides by itself 1.5 s after the last GHOST)
# The ghost pointer is only drawn: it never moves or touches the real cursor. Like a border it is click-through, never
# takes focus, is kept out of captures, and sits in the z-order directly above the window it is in.
# Each border is shown while its window is visible and not minimized, in front or not, and follows it as it moves or
# resizes (polled every 100 ms). A window that Windows does not show (hidden, or cloaked: on another virtual desktop) gets
# no border. It starts with no window. The parent kills this process to remove it; when stdin closes
# (the parent is gone without doing so) it exits by itself.
#
# stdout: OUTLINE_CAPTURABLE, once, where Windows cannot keep this window out of a capture (before Windows 10 2004).
#
# Extended window styles (the pill's zero-focus contract, plus click-through - it is up WHILE the agent types/clicks):
#   WS_EX_LAYERED      0x00080000  with WS_EX_TRANSPARENT: input falls through to the app below
#   WS_EX_TRANSPARENT  0x00000020  click-through
#   WS_EX_NOACTIVATE   0x08000000  never steals focus (agent keeps typing)
#   WS_EX_TOOLWINDOW   0x00000080  no taskbar / alt-tab entry
# Not WS_EX_TOPMOST (0x00000008): a border sits in the z-order directly above its window, so the window the user has in
# front covers it and it never draws over the user's window. (Its window's own popups, which sit above it, cover it too.)
#
# The Windows drawer; macOS and Linux use scripts/mac/overlay.swift and scripts/linux/overlay.py (`outline`).

param(
    [string]$Color     = '#f59e0b',  # border colour (amber - "in progress"; the paused form passes blue)
    [int]   $Thickness = 3,          # px at 100% scaling; scaled by the DPI of the window's monitor
    [switch]$Paused                  # sent by the paused form (banner.ts outlineFlags), which is just the blue -Color
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// A window that is click-through, never takes focus, and is kept out of captures: the base of every drawing here.
public class OverlayForm : Form {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] protected static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] protected static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] protected static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);
    [DllImport("dwmapi.dll")] protected static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);

    public static long hideUntil;  // DateTime ticks (UTC); written by the stdin thread
    public static IntPtr ghost;    // the ghost pointer's window: a border may sit just below it, still directly above its window

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x00080000; // WS_EX_LAYERED
            cp.ExStyle |= 0x00000020; // WS_EX_TRANSPARENT (click-through)
            cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
            return cp;
        }
    }
    static bool told;
    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        SetLayeredWindowAttributes(Handle, 0, 255, 2); // LWA_ALPHA, opaque: a layered window draws nothing until told how
        // For the person at the screen only: WDA_EXCLUDEFROMCAPTURE (0x11) keeps the border out of screenshots and OCR.
        // Before Windows 10 2004 the call fails: the parent is told, and sends HIDE before each capture instead.
        bool excluded = false;
        try { excluded = SetWindowDisplayAffinity(Handle, 0x11); } catch { }
        if (!excluded && !told) { told = true; try { Console.Out.WriteLine("OUTLINE_CAPTURABLE"); Console.Out.Flush(); } catch { } }
    }

    // Does Windows show this window, and where is its frame? Not hidden (not WS_VISIBLE), minimized, or cloaked
    // (DWMWA_CLOAKED = 14: on another virtual desktop; a cloak that cannot be read counts as shown), and not stepping
    // aside for a capture. The visible frame is DWMWA_EXTENDED_FRAME_BOUNDS = 9, not GetWindowRect, which includes
    // invisible resize borders.
    protected static bool IsShown(IntPtr t, out RECT r) {
        int cloaked;
        r = new RECT();
        return t != IntPtr.Zero && DateTime.UtcNow.Ticks >= Interlocked.Read(ref hideUntil)
            && !IsIconic(t) && IsWindowVisible(t)
            && (DwmGetWindowAttribute(t, 14, out cloaked, 4) != 0 || cloaked == 0)
            && DwmGetWindowAttribute(t, 9, out r, 16) == 0 && r.Right > r.Left && r.Bottom > r.Top;
    }
}

// A thin border around one window, shown while that window is visible, in front or not. It is NOT topmost: it sits in the
// z-order directly above its window, so a window the user has in front of it covers it, and it never draws over that window.
public class WindowOutline : OverlayForm {
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, int flags);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr hWnd, IntPtr rgn, bool redraw);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int ellipseW, int ellipseH);
    [DllImport("gdi32.dll")] static extern int CombineRgn(IntPtr dest, IntPtr a, IntPtr b, int mode);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);

    // Windows 11 (build 22000 and later) rounds the corners of its windows; Windows 10 has square ones.
    static readonly bool roundedWindows = Environment.OSVersion.Version.Build >= 22000;

    // The corner radius of the target window, in px at 100% scaling: 8 on Windows 11, 0 (square) for a maximized
    // window and one that asked not to be rounded. DWMWA_WINDOW_CORNER_PREFERENCE (33) is read where Windows gives
    // it (1 = DONOTROUND, 3 = ROUNDSMALL, a 4 px radius); where the read fails the window has the default.
    static int CornerRadiusAt96(IntPtr t) {
        if (!roundedWindows || IsZoomed(t)) return 0;
        int pref;
        if (DwmGetWindowAttribute(t, 33, out pref, 4) != 0) return 8;
        return pref == 1 ? 0 : pref == 3 ? 4 : 8;
    }

    // A rectangle with rounded corners (radius 0: a plain one). The far edges of a GDI rounded region are exclusive
    // and its ellipse is one pixel short of them: hence the + 1.
    static IntPtr RoundRgn(int left, int top, int right, int bottom, int radius) {
        return radius <= 0 ? CreateRectRgn(left, top, right, bottom)
                           : CreateRoundRectRgn(left, top, right + 1, bottom + 1, 2 * radius, 2 * radius);
    }

    readonly IntPtr target;
    public long Hwnd { get { return target.ToInt64(); } }
    RECT last;
    bool shown;
    int thickness;

    public WindowOutline(IntPtr t, Color color, int thicknessAt96) {
        target = t;
        thickness = thicknessAt96;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = color;
    }

    public IntPtr Above { get { return GetWindow(target, 3); } } // GW_HWNDPREV
    public bool Covers(int x, int y) { return shown && x >= last.Left && x < last.Right && y >= last.Top && y < last.Bottom; }

    public void Follow() {
        RECT r;
        if (!IsShown(target, out r)) {
            if (shown) { ShowWindow(Handle, 0); shown = false; } // SW_HIDE
            return;
        }
        // Directly above its window in the z-order: the window just above the target is this one.
        IntPtr above = GetWindow(target, 3); // GW_HWNDPREV
        bool placed = above == Handle || above == ghost;
        bool moved = !shown || r.Left != last.Left || r.Top != last.Top || r.Right != last.Right || r.Bottom != last.Bottom;
        if (placed && !moved) return;
        int w = r.Right - r.Left, h = r.Bottom - r.Top;
        if (moved) {
            uint dpi, dpiY;
            if (GetDpiForMonitor(MonitorFromWindow(target, 2), 0, out dpi, out dpiY) != 0) dpi = 96; // MONITOR_DEFAULTTONEAREST, MDT_EFFECTIVE_DPI
            int b = Math.Max(2, (int)Math.Round(thickness * dpi / 96.0));
            // Just inside the frame, so a maximized window's border is on screen too. The middle is not part of this window.
            // Its corners are rounded like the window's, or a wedge of what is behind shows at each one; the inner
            // radius is smaller by the border's width, so the band is as wide in the corners as along the sides.
            int radius = (int)Math.Round(CornerRadiusAt96(target) * dpi / 96.0);
            IntPtr frame = RoundRgn(0, 0, w, h, radius);
            if (w > 2 * b && h > 2 * b) {
                IntPtr hole = RoundRgn(b, b, w - b, h - b, radius - b);
                CombineRgn(frame, frame, hole, 4); // RGN_DIFF
                DeleteObject(hole);
            }
            // The window owns the region from here (and frees the one it had); it is ours to free only if it was refused.
            if (SetWindowRgn(Handle, frame, true) == 0) DeleteObject(frame);
        }
        // Placed after the window that is above the target (none: at the top), so it lands directly above the target.
        // SWP_NOACTIVATE 0x10 | SWP_SHOWWINDOW 0x40, SWP_NOZORDER 0x04 when it is already there, SWP_NOMOVE | SWP_NOSIZE 0x03 when it did not move.
        SetWindowPos(Handle, above, r.Left, r.Top, w, h, placed ? 0x0054u : moved ? 0x0050u : 0x0053u);
        last = r;
        shown = true;
    }
}

// The agent's pointer: a small drawn arrow where it acts, in a colour the real cursor never is. Shown for 1.5 s after each
// GHOST, only inside an outlined window, directly above that window in the z-order. It is never the real cursor.
public class GhostCursor : OverlayForm {
    int x, y, lx, ly;
    long until;   // DateTime ticks (UTC) it is shown until
    bool shown;

    public GhostCursor() {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(236, 72, 153);
        Size = new Size(12, 20);
        var arrow = new System.Drawing.Drawing2D.GraphicsPath();
        arrow.AddPolygon(new Point[] { new Point(0, 0), new Point(0, 17), new Point(4, 13), new Point(7, 19), new Point(9, 18), new Point(6, 12), new Point(11, 12) });
        Region = new Region(arrow);   // the arrow's tip is the window's top-left corner: the point acted on
    }

    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        ghost = Handle;
    }

    public void MoveTo(int px, int py) { x = px; y = py; until = DateTime.UtcNow.AddMilliseconds(1500).Ticks; }
    public void Clear() { until = 0; }

    public void Follow(List<WindowOutline> outlines) {
        WindowOutline on = null;
        long now = DateTime.UtcNow.Ticks;
        if (now < until && now >= Interlocked.Read(ref hideUntil)) foreach (WindowOutline o in outlines) if (o.Covers(x, y)) { on = o; break; }
        if (on == null) {
            if (shown) { ShowWindow(Handle, 0); shown = false; } // SW_HIDE
            return;
        }
        IntPtr above = on.Above;
        bool placed = above == Handle;
        bool moved = !shown || x != lx || y != ly;
        if (placed && !moved) return;
        SetWindowPos(Handle, above, x, y, Width, Height, placed ? 0x0054u : moved ? 0x0050u : 0x0053u);
        lx = x; ly = y;
        shown = true;
    }
}

// One outline per window named on stdin, followed on a 100 ms poll.
public static class OutlineHost {
    static readonly List<WindowOutline> outlines = new List<WindowOutline>();
    static GhostCursor pointer;
    static Control sync;   // created on the UI thread: the stdin thread hands work to it
    static Color color;
    static int thickness;

    public static void Start(int r, int g, int b, int thicknessAt96) {
        color = Color.FromArgb(r, g, b);
        thickness = thicknessAt96;
        sync = new Control();
        IntPtr created = sync.Handle;
        pointer = new GhostCursor();
        IntPtr pointerCreated = pointer.Handle;
        var t = new Thread(() => {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    string[] p = line.Trim().Split(' ');
                    long n = 0;
                    if (p.Length > 1) long.TryParse(p[1], out n);
                    // EndsWith: a parent that puts a byte-order mark in front of its first line must not lose it.
                    if (p[0].EndsWith("TARGET")) {
                        // TARGET <hwnd> <pid> [<hwnd> <pid> ...]: the windows to outline (the pid is for the macOS drawer).
                        var hs = new List<long>();
                        for (int i = 1; i < p.Length; i += 2) { long h; if (long.TryParse(p[i], out h) && h != 0) hs.Add(h); }
                        try { sync.BeginInvoke((Action)(() => SetTargets(hs))); } catch { }
                        continue;
                    }
                    else if (p[0].EndsWith("GHOST")) {
                        // GHOST <x> <y>: draw the pointer there; a bare GHOST hides it.
                        int gx = 0, gy = 0;
                        bool at = p.Length > 2 && int.TryParse(p[1], out gx) && int.TryParse(p[2], out gy);
                        try { sync.BeginInvoke((Action)(() => { if (at) pointer.MoveTo(gx, gy); else pointer.Clear(); FollowAll(); })); } catch { }
                        continue;
                    }
                    else if (p[0].EndsWith("HIDE")) Interlocked.Exchange(ref OverlayForm.hideUntil, DateTime.UtcNow.AddMilliseconds(Math.Max(50, Math.Min(n, 10000))).Ticks);
                    else continue;
                    // At once, not on the next poll: the parent waits only 90 ms after HIDE before it captures.
                    try { sync.BeginInvoke((Action)FollowAll); } catch { }
                }
                Environment.Exit(0);   // stdin closed: the parent is gone, and a border must not outlive it
            } catch { }
        });
        t.IsBackground = true;
        t.Start();
        var poll = new System.Windows.Forms.Timer();
        poll.Interval = 100;
        poll.Tick += (s, e) => FollowAll();
        poll.Start();
    }

    static void SetTargets(List<long> hs) {
        for (int i = outlines.Count - 1; i >= 0; i--) {
            if (hs.Contains(outlines[i].Hwnd)) continue;
            outlines[i].Dispose();
            outlines.RemoveAt(i);
        }
        foreach (long h in hs) if (!outlines.Exists(o => o.Hwnd == h)) outlines.Add(new WindowOutline(new IntPtr(h), color, thickness));
        FollowAll();
    }

    static void FollowAll() {
        foreach (WindowOutline o in outlines) o.Follow();
        pointer.Follow(outlines);
    }
}
'@

# Compiling the class costs a second or more on every start (csc.exe), so the border came up late. The compiled
# assembly is kept in ~/.clawdcursor/bin (where the macOS helpers are cached) under a name made from the source, and
# loaded from there the next time. A cached file that does not load is built again and replaced; if that fails too,
# for any reason, the class is compiled in memory as before.
try {
    $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($source))
    $dir = Join-Path $env:USERPROFILE '.clawdcursor\bin'
    $dll = Join-Path $dir ('window-outline-' + (-join ($sha[0..7] | ForEach-Object { $_.ToString('x2') })) + '.dll')
    $build = {
        [void](New-Item -ItemType Directory -Force $dir)
        Get-ChildItem $dir -Filter 'window-outline-*.dll' | Remove-Item -Force -ErrorAction SilentlyContinue  # other versions
        Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition $source -OutputType Library -OutputAssembly "$dll.$PID.tmp"
        Move-Item -Force "$dll.$PID.tmp" $dll
    }
    # What a build that was killed half-way left behind (not one that is running now).
    Get-ChildItem $dir -Filter 'window-outline-*.tmp' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-5) } | Remove-Item -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $dll)) { & $build }
    try { Add-Type -Path $dll } catch { & $build; Add-Type -Path $dll }
} catch {
    Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition $source
}

# Per-monitor-v2, like ps-bridge.ps1: the frame bounds and this window's position are PHYSICAL pixels on every monitor.
[void][OverlayForm]::SetThreadDpiAwarenessContext([IntPtr](-4))

$hex = $Color.TrimStart('#')
[OutlineHost]::Start([Convert]::ToInt32($hex.Substring(0,2),16), [Convert]::ToInt32($hex.Substring(2,2),16), [Convert]::ToInt32($hex.Substring(4,2),16), $Thickness)
[System.Windows.Forms.Application]::Run()
