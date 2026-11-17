# edge-glow.ps1 - the "an agent is in control" screen-edge glow.
#
# A click-through, never-activating glow along all four edges of every monitor, pulsing dim <-> bright while clawdcursor is
# driving the desktop. Spawned/killed by src/core/banner.ts in lockstep with the control-banner pill (the pill keeps the
# stop affordance); amber while the agent works, blue (-Color) while it waits for the user. Nothing is drawn on the
# middle of the screen.
#
# stdin, from the parent:
#   HIDE <ms>   step aside for a screen capture (only sent after GLOW_CAPTURABLE)
# When stdin closes (the parent is gone without having killed this process) it exits by itself: a glow must not outlive
# the host that started it. Run by hand for a demo from a terminal (stdin stays open): -DurationSec 12.
#
# stdout: GLOW_CAPTURABLE, once, where Windows cannot keep these windows out of a capture (before Windows 10 2004).
#
# Why per-pixel-alpha layered windows (UpdateLayeredWindow) and not a WinForms paint + TransparencyKey: a color key can
# knock out only ONE exact color, so a soft inward fade cannot be made click-through that way. Per-pixel alpha gives a real
# soft glow. Four narrow windows per monitor (one per edge) instead of one screen-sized one: the system blends a few hundred
# thousand pixels per frame, not a whole 4K screen's.
#
# Extended window styles (the pill's zero-focus contract, plus click-through - it is up WHILE the agent types/clicks):
#   WS_EX_LAYERED      0x00080000  per-pixel alpha compositing
#   WS_EX_TRANSPARENT  0x00000020  click-through (input falls to the app below)
#   WS_EX_NOACTIVATE   0x08000000  never steals focus (agent keeps typing)
#   WS_EX_TOOLWINDOW   0x00000080  no taskbar / alt-tab entry
#   WS_EX_TOPMOST      0x00000008  stays above normal windows; kept just BELOW the pill (-PillPid), which stays above it
#
# Per-monitor-v2 DPI: monitor bounds are physical pixels, and the depth of the glow is scaled by each monitor's DPI.
# WDA_EXCLUDEFROMCAPTURE keeps it out of screenshots and OCR.
#
# The Windows drawer; macOS and Linux use scripts/mac/overlay.swift and scripts/linux/overlay.py (`glow`).

param(
    [string]$Color       = '#f59e0b',  # glow color (amber - "in progress"; the paused form passes blue)
    [int]   $Thickness   = 80,         # px at 100% scaling the glow fades in from each edge
    [int]   $PeriodMs    = 1600,       # full dim->bright->dim cycle
    [int]   $MinAlpha    = 60,         # dim floor (0-255); lower = dims more
    [int]   $PeakAlpha   = 200,        # per-pixel alpha at the very edge (0-255)
    [int]   $DurationSec = 0,          # 0 = run until killed; >0 = self-close (demo)
    [int]   $PillPid     = 0           # the pill's process: its windows stay above the glow
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class GlowEdge : Form {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; public SIZE(int x, int y) { cx = x; cy = y; } }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
    delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);
    delegate bool WindowEnumProc(IntPtr hWnd, IntPtr data);

    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowEnumProc cb, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")]  static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll")]  static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")]  static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
    [DllImport("gdi32.dll")]  static extern bool DeleteObject(IntPtr ho);
    [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(
        IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
        IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);

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

    static bool reported;
    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        // For the person at the screen only: WDA_EXCLUDEFROMCAPTURE (0x11) keeps the glow out of screenshots and OCR.
        // Before Windows 10 2004 the call fails: the parent is told, and sends HIDE before each capture instead.
        bool excluded = false;
        try { excluded = SetWindowDisplayAffinity(Handle, 0x11); } catch { }
        if (!excluded && !reported) { reported = true; try { Console.Out.WriteLine("GLOW_CAPTURABLE"); Console.Out.Flush(); } catch { } }
    }

    int px, py;
    Bitmap bmp;
    IntPtr screenDc, memDc, hBitmap, oldBitmap;

    // side: 0 top, 1 bottom, 2 left, 3 right. The corners overlap (the glow pools there, as it always did).
    static GlowEdge Make(int x, int y, int w, int h, int side, Color baseColor, int peak) {
        Color edge = Color.FromArgb(peak, baseColor), fade = Color.FromArgb(0, baseColor);
        var b = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(b)) {
            g.Clear(Color.FromArgb(0, 0, 0, 0));
            bool vertical = side < 2, edgeFirst = side == 0 || side == 2;
            using (var br = new LinearGradientBrush(new Rectangle(0, 0, w, h), edgeFirst ? edge : fade, edgeFirst ? fade : edge,
                       vertical ? LinearGradientMode.Vertical : LinearGradientMode.Horizontal)) {
                br.WrapMode = WrapMode.TileFlipXY;
                g.FillRectangle(br, 0, 0, w, h);
            }
        }
        var f = new GlowEdge();
        f.FormBorderStyle = FormBorderStyle.None;
        f.ShowInTaskbar = false;
        f.StartPosition = FormStartPosition.Manual;
        f.Bounds = new Rectangle(x, y, w, h);
        f.px = x; f.py = y; f.bmp = b;
        return f;
    }

    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        screenDc = GetDC(IntPtr.Zero);
        memDc = CreateCompatibleDC(screenDc);
        hBitmap = bmp.GetHbitmap(Color.FromArgb(0)); // ARGB DIB for UpdateLayeredWindow
        oldBitmap = SelectObject(memDc, hBitmap);
    }

    // Re-push the same bitmap with a new global alpha: the pulse. Also puts the window where it belongs.
    void Push(byte alpha) {
        if (memDc == IntPtr.Zero) return;
        SIZE size = new SIZE(bmp.Width, bmp.Height);
        POINT src = new POINT(0, 0);
        POINT dst = new POINT(px, py);
        BLENDFUNCTION blend = new BLENDFUNCTION();
        blend.BlendOp = 0;        // AC_SRC_OVER
        blend.SourceConstantAlpha = alpha;
        blend.AlphaFormat = 1;    // AC_SRC_ALPHA
        UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref blend, 2); // ULW_ALPHA
    }

    // Every monitor: {left, top, right, bottom, dpi}, in physical pixels (this thread is per-monitor-v2).
    static List<int[]> Monitors() {
        var list = new List<int[]>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr mon, IntPtr hdc, ref RECT r, IntPtr data) => {
            uint dx = 96, dy = 96;
            if (GetDpiForMonitor(mon, 0, out dx, out dy) != 0) dx = 96; // MDT_EFFECTIVE_DPI
            list.Add(new int[] { r.Left, r.Top, r.Right, r.Bottom, (int)dx });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // The lowest always-on-top window of the pill's process (EnumWindows runs from the top of the z-order down): the glow
    // sits directly under it, so the pill and its pause card stay over the glow. Hidden ones count: a window that is
    // hidden for a click comes back where it was.
    static IntPtr PillWindow(uint pid) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((IntPtr h, IntPtr data) => {
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (p == pid && (GetWindowLong(h, -20) & 0x8) != 0) found = h; // GWL_EXSTYLE, WS_EX_TOPMOST
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static bool IsAbove(IntPtr upper, IntPtr h) {
        IntPtr w = GetWindow(h, 3); // GW_HWNDPREV
        for (int i = 0; w != IntPtr.Zero && i < 1000; i++, w = GetWindow(w, 3)) if (w == upper) return true;
        return false;
    }

    static long hideUntil; // DateTime ticks (UTC); written by the stdin thread

    public static void Run(int cr, int cg, int cb, int thickness, int periodMs, int minAlpha, int peak, int durationSec, int pillPid) {
        SetThreadDpiAwarenessContext(new IntPtr(-4)); // per-monitor-v2, before any window exists
        Color c = Color.FromArgb(cr, cg, cb);
        var forms = new List<GlowEdge>();
        foreach (int[] m in Monitors()) {
            int w = m[2] - m[0], h = m[3] - m[1];
            int t = Math.Min((int)Math.Round(thickness * m[4] / 96.0), Math.Min(w / 2, h / 2));
            if (t < 1) continue;
            forms.Add(Make(m[0], m[1], w, t, 0, c, peak));
            forms.Add(Make(m[0], m[3] - t, w, t, 1, c, peak));
            forms.Add(Make(m[0], m[1], t, h, 2, c, peak));
            forms.Add(Make(m[2] - t, m[1], t, h, 3, c, peak));
        }
        if (forms.Count == 0) return;
        foreach (GlowEdge f in forms) { f.Show(); f.Push((byte)minAlpha); }

        int start = Environment.TickCount;
        bool shown = true;
        Action update = () => {
            int elapsed = Environment.TickCount - start;
            if (durationSec > 0 && elapsed >= durationSec * 1000) { Application.Exit(); return; }
            bool want = DateTime.UtcNow.Ticks >= Interlocked.Read(ref hideUntil);
            if (want != shown) { foreach (GlowEdge f in forms) ShowWindow(f.Handle, want ? 4 : 0); shown = want; } // SW_SHOWNOACTIVATE / SW_HIDE
            if (!shown) return;
            // Cosine ease between minAlpha and 255 (smooth dim <-> bright).
            double wave = (1 - Math.Cos((elapsed % periodMs) / (double)periodMs * 2 * Math.PI)) / 2;
            int a = (int)(minAlpha + wave * (255 - minAlpha));
            byte alpha = (byte)Math.Max(0, Math.Min(255, a));
            foreach (GlowEdge f in forms) f.Push(alpha);
        };
        var pulse = new System.Windows.Forms.Timer();
        pulse.Interval = 30;
        pulse.Tick += (s, e) => update();
        pulse.Start();

        if (pillPid > 0) {
            var z = new System.Windows.Forms.Timer();
            z.Interval = 250;
            z.Tick += (s, e) => {
                IntPtr pill = PillWindow((uint)pillPid);
                if (pill == IntPtr.Zero) return;
                // SWP_NOSIZE 0x1 | SWP_NOMOVE 0x2 | SWP_NOACTIVATE 0x10: directly under the pill, still in the topmost band.
                foreach (GlowEdge f in forms) if (!IsAbove(pill, f.Handle)) SetWindowPos(f.Handle, pill, 0, 0, 0, 0, 0x13);
            };
            z.Start();
        }

        var first = forms[0];
        var reader = new Thread(() => {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    string[] p = line.Trim().Split(' ');
                    long n;
                    // EndsWith: a parent that puts a byte-order mark in front of its first line must not lose it.
                    if (p.Length > 1 && p[0].EndsWith("HIDE") && long.TryParse(p[1], out n)) {
                        Interlocked.Exchange(ref hideUntil, DateTime.UtcNow.AddMilliseconds(Math.Max(50, Math.Min(n, 10000))).Ticks);
                        // At once, not on the next tick: the parent waits only 90 ms after HIDE before it captures.
                        try { first.BeginInvoke(update); } catch { }
                    }
                }
                Environment.Exit(0);   // stdin closed: the parent is gone, and a glow must not outlive it
            } catch { }
        });
        reader.IsBackground = true;
        reader.Start();

        Application.Run();
        foreach (GlowEdge f in forms) f.Cleanup();
    }

    void Cleanup() {
        if (memDc != IntPtr.Zero) SelectObject(memDc, oldBitmap);
        if (hBitmap != IntPtr.Zero) { DeleteObject(hBitmap); hBitmap = IntPtr.Zero; }
        if (memDc != IntPtr.Zero) { DeleteDC(memDc); memDc = IntPtr.Zero; }
        if (screenDc != IntPtr.Zero) { ReleaseDC(IntPtr.Zero, screenDc); screenDc = IntPtr.Zero; }
    }
}
'@

# Compiling the class costs a second or more on every start (csc.exe), so the glow came up late. The compiled assembly is
# kept in ~/.clawdcursor/bin (where the macOS helpers are cached) under a name made from the source, and loaded from there
# the next time. A cached file that does not load is built again and replaced; if that fails too, for any reason, the class
# is compiled in memory as before.
try {
    $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($source))
    $dir = Join-Path $env:USERPROFILE '.clawdcursor\bin'
    $dll = Join-Path $dir ('edge-glow-' + (-join ($sha[0..7] | ForEach-Object { $_.ToString('x2') })) + '.dll')
    $build = {
        [void](New-Item -ItemType Directory -Force $dir)
        Get-ChildItem $dir -Filter 'edge-glow-*.dll' | Remove-Item -Force -ErrorAction SilentlyContinue  # other versions
        Get-ChildItem $dir -Filter 'window-outline-*.dll' | Remove-Item -Force -ErrorAction SilentlyContinue  # the 2.x outline's
        Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition $source -OutputType Library -OutputAssembly "$dll.$PID.tmp"
        Move-Item -Force "$dll.$PID.tmp" $dll
    }
    # What a build that was killed half-way left behind (not one that is running now).
    Get-ChildItem $dir -Filter 'edge-glow-*.tmp' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-5) } | Remove-Item -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $dll)) { & $build }
    try { Add-Type -Path $dll } catch { & $build; Add-Type -Path $dll }
} catch {
    Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition $source
}

$hex = $Color.TrimStart('#')
[GlowEdge]::Run(
    [Convert]::ToInt32($hex.Substring(0,2),16), [Convert]::ToInt32($hex.Substring(2,2),16), [Convert]::ToInt32($hex.Substring(4,2),16),
    $Thickness, $PeriodMs, $MinAlpha, $PeakAlpha, $DurationSec, $PillPid)
