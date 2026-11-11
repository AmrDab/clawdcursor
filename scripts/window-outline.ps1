# window-outline.ps1 - a thin "beam" border around the window the agent is working in.
#
# Spawned/killed by src/core/banner.ts in lockstep with the control-banner pill. It draws ONLY the border: four thin
# strip windows (top, right, bottom, left) along the frame, so there is nothing over the content and nothing on the
# rest of the screen.
#
# The look (#392): the border is faint (about 35%), and ONE soft highlight travels slowly around it (a 3.5 s loop) with
# a subtle glow just outside. Paused (-Paused, blue): no travel, a gentle 2 s breathe. Where Windows is set to show no
# animations (SPI_GETCLIENTAREAANIMATION off) the border is the plain steady one. The idea is the "border beam" of
# libraries.dev by Jakub Antalik (MIT): a highlight going round a masked border with a soft glow. Nothing of it is
# copied: here the strips are per-pixel-alpha layered windows, filled from a table made once per size (how much of each
# pixel is border, how much glow, and where along the border it is), so a frame is one pass over a few hundred
# thousand pixels and the desktop compositor does the blending.
#
# stdin, from the parent:
#   TARGET <hwnd> <pid>   the window to outline (the pid is for the macOS drawer; ignored here)
#   TARGET MONITOR        the agent works with no window (the desktop): outline the monitor the pointer is on
#   TARGET                draw nothing
#   HIDE <ms>             step aside for a screen capture (only sent after OUTLINE_CAPTURABLE)
# The border is shown while that window is the one in front and not minimized, and follows it as it moves or resizes
# (polled every 100 ms). A target that is the desktop itself (Progman / WorkerW) is outlined as the monitor.
# It starts with no window. The parent kills this process to remove it; when stdin closes (the parent is gone without
# doing so) it exits by itself.
#
# stdout: OUTLINE_CAPTURABLE, once, where Windows cannot keep this window out of a capture (before Windows 10 2004).
#
# Extended window styles (the pill's zero-focus contract, plus click-through - it is up WHILE the agent types/clicks):
#   WS_EX_LAYERED      0x00080000  per-pixel alpha (UpdateLayeredWindow); with WS_EX_TRANSPARENT input falls through
#   WS_EX_TRANSPARENT  0x00000020  click-through
#   WS_EX_NOACTIVATE   0x08000000  never steals focus (agent keeps typing)
#   WS_EX_TOOLWINDOW   0x00000080  no taskbar / alt-tab entry
#   WS_EX_TOPMOST      0x00000008  stays above the window it outlines. (Only an always-on-top window can be put over
#                                  the window in front by another process: placed just above it, or at the top of the
#                                  ordinary windows, the border ended up behind that window's own popups or was
#                                  re-placed on every poll - measured 2026-11-10.)
#
# The Windows drawer; macOS and Linux use scripts/mac/overlay.swift and scripts/linux/overlay.py (`outline`).

param(
    [string]$Color     = '#f59e0b',  # border colour (amber - "in progress"; the paused form passes blue)
    [int]   $Thickness = 3,          # px at 100% scaling; scaled by the DPI of the window's monitor
    [switch]$Paused                  # the paused form: no travelling highlight, a slow breathe
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// One side of the border: a layered window whose pixels are set with UpdateLayeredWindow.
public class BeamStrip : Form {
    [StructLayout(LayoutKind.Sequential)] struct PT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct BLEND { public byte Op, Flags, Alpha, Format; }
    [StructLayout(LayoutKind.Sequential)] struct BMI {
        public int Size, Width, Height; public short Planes, BitCount; public int Compression, SizeImage, XPpm, YPpm, ClrUsed, ClrImportant;
    }
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
    [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr hWnd, IntPtr dst, ref PT at, ref PT size, IntPtr src, ref PT from, int key, ref BLEND blend, int flags);
    [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr hWnd, IntPtr dst, IntPtr at, IntPtr size, IntPtr src, IntPtr from, int key, ref BLEND blend, int flags);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BMI info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);

    public static bool Capturable;   // Windows could not keep a strip out of captures

    public BeamStrip() {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
    }
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
        // For the person at the screen only: WDA_EXCLUDEFROMCAPTURE (0x11) keeps the border out of screenshots and OCR.
        // Before Windows 10 2004 the call fails: the parent is told, and sends HIDE before each capture instead.
        bool excluded = false;
        try { excluded = SetWindowDisplayAffinity(Handle, 0x11); } catch { }
        if (!excluded) Capturable = true;
    }

    // Where the strip is, relative to the outlined frame, and its size; all zero: not used at this size.
    public int X, Y, W, H;
    // Per pixel, made once per size: how much of it is border and how much glow (0-255), and its place along the border.
    public byte[] Border, Glow;
    public int[] Along;
    // Per line across the border (a column of the top and bottom strips, a row of the side ones): the part of the
    // border it lies on. A frame fills only the lines the highlight is on, or has just left.
    public int[] From, To;
    public int[] Pixels;   // premultiplied ARGB, copied to the bitmap on every frame
    IntPtr dc, bitmap, bits;

    public void SetSize(int x, int y, int w, int h) {
        X = x; Y = y;
        if (w == W && h == H) return;
        W = Math.Max(0, w); H = Math.Max(0, h);
        if (dc == IntPtr.Zero) dc = CreateCompatibleDC(IntPtr.Zero);
        int n = W * H;
        Border = new byte[n]; Glow = new byte[n]; Along = new int[n]; Pixels = new int[n];
        From = new int[Math.Max(W, H)]; To = new int[Math.Max(W, H)];
        IntPtr old = bitmap;
        bitmap = IntPtr.Zero; bits = IntPtr.Zero;
        if (n > 0) {
            BMI info = new BMI();
            info.Size = 40; info.Width = W; info.Height = -H; info.Planes = 1; info.BitCount = 32;   // top-down, 32-bit
            bitmap = CreateDIBSection(dc, ref info, 0, out bits, IntPtr.Zero, 0);
            if (bitmap != IntPtr.Zero) SelectObject(dc, bitmap);
        }
        if (old != IntPtr.Zero) DeleteObject(old);
    }

    // Put the pixels on screen, with the strip at its place for a frame whose top left is (left, top).
    public void Push(int left, int top) {
        if (bits == IntPtr.Zero) return;
        Marshal.Copy(Pixels, 0, bits, Pixels.Length);
        PT at = new PT(); at.X = left + X; at.Y = top + Y;
        PT size = new PT(); size.X = W; size.Y = H;
        PT from = new PT();
        BLEND blend = new BLEND(); blend.Alpha = 255; blend.Format = 1;   // AC_SRC_OVER, AC_SRC_ALPHA
        UpdateLayeredWindow(Handle, IntPtr.Zero, ref at, ref size, dc, ref from, 0, ref blend, 2);   // ULW_ALPHA
    }

    // The same pixels at another opacity (the paused form's breathe): nothing is drawn again.
    public void Fade(byte alpha) {
        if (bits == IntPtr.Zero) return;
        BLEND blend = new BLEND(); blend.Alpha = alpha; blend.Format = 1;
        UpdateLayeredWindow(Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref blend, 2);
    }
}

public class WindowOutline {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int Size; public RECT Monitor, Work; public int Flags; }
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, int flags);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT p, int flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, out bool value, uint flags);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);

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

    // The desktop itself: clicking it puts Progman (or the WorkerW that holds the icons) in front. There is no window
    // to go around, so the monitor is outlined.
    static bool IsDesktop(IntPtr t) {
        if (t == GetShellWindow()) return true;
        StringBuilder name = new StringBuilder(32);
        GetClassName(t, name, 32);
        string c = name.ToString();
        return c == "Progman" || c == "WorkerW";
    }

    const int LoopMs = 3500;      // one trip of the highlight round the border
    const int BreatheMs = 2000;   // the paused form's breathe
    const int Faint = 90;         // the border away from the highlight: 35% (of 256)
    const int GlowMax = 110;      // the glow at the highlight, right at the border: 43% (of 256)

    volatile IntPtr target = IntPtr.Zero;   // written by the stdin thread, read by the timer
    volatile bool monitor;                  // TARGET MONITOR
    long hideUntil;                         // DateTime ticks (UTC); written by the stdin thread
    RECT last;
    bool shown;
    int thickness;
    int[] shade = new int[256];   // the colour at every opacity, premultiplied as UpdateLayeredWindow wants it
    bool paused;
    bool still;                 // Windows is set to show no animations: the steady border
    string layout = "";         // what the tables were made for
    int perimeter = 1;
    int[] level = new int[1];   // the highlight along the border, 0-256, made again for every frame
    double lastHead;            // where the highlight was in the frame before
    BeamStrip[] strips = new BeamStrip[4];   // top, right, bottom, left
    Stopwatch clock = Stopwatch.StartNew();
    System.Windows.Forms.Timer poll, frame;

    IntPtr Handle { get { return strips[0].Handle; } }
    void BeginInvoke(Action a) { strips[0].BeginInvoke(a); }

    public void Start(int r, int g, int b, int thicknessAt96, bool pausedForm) {
        thickness = thicknessAt96; paused = pausedForm;
        for (int a = 0; a < 256; a++) shade[a] = (a << 24) | ((r * a / 255) << 16) | ((g * a / 255) << 8) | (b * a / 255);
        for (int i = 0; i < 4; i++) {
            strips[i] = new BeamStrip();
            IntPtr created = strips[i].Handle;   // the windows exist (hidden) before the timers or stdin touch them
        }
        if (BeamStrip.Capturable) { try { Console.Out.WriteLine("OUTLINE_CAPTURABLE"); Console.Out.Flush(); } catch { } }
        var t = new Thread(() => {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    string[] p = line.Trim().Split(' ');
                    long n = 0;
                    if (p.Length > 1) long.TryParse(p[1], out n);
                    // EndsWith: a parent that puts a byte-order mark in front of its first line must not lose it.
                    if (p[0].EndsWith("TARGET")) { monitor = p.Length > 1 && p[1] == "MONITOR"; target = new IntPtr(n); }
                    else if (p[0].EndsWith("HIDE")) Interlocked.Exchange(ref hideUntil, DateTime.UtcNow.AddMilliseconds(Math.Max(50, Math.Min(n, 10000))).Ticks);
                    else continue;
                    // At once, not on the next poll: the parent waits only 90 ms after HIDE before it captures.
                    try { BeginInvoke((Action)Follow); } catch { }
                }
                Environment.Exit(0);   // stdin closed: the parent is gone, and a border must not outlive it
            } catch { }
        });
        t.IsBackground = true;
        t.Start();
        poll = new System.Windows.Forms.Timer();
        poll.Interval = 100;
        poll.Tick += (s, e) => Follow();
        poll.Start();
        // About 22 frames a second (enough for a slow, soft highlight; each frame costs a wake-up), and only while the
        // border is on screen and moving.
        frame = new System.Windows.Forms.Timer();
        frame.Interval = 45;
        frame.Tick += (s, e) => { if (shown && !still) Paint(false); };
        frame.Start();
    }

    // Is this window somewhere above `t` in the z-order? (Walks up from `t`: few windows are above the one in front;
    // the cap is for a z-order that changes under the walk.)
    bool Above(IntPtr t) {
        IntPtr h = GetWindow(t, 3); // GW_HWNDPREV
        for (int i = 0; h != IntPtr.Zero && i < 1000; i++, h = GetWindow(h, 3)) if (h == Handle) return true;
        return false;
    }

    void Follow() {
        IntPtr t = target;
        RECT r = new RECT();
        IntPtr screen = IntPtr.Zero;
        bool on = DateTime.UtcNow.Ticks >= Interlocked.Read(ref hideUntil);
        // No window, or the desktop in front: the monitor the pointer is on, where the agent's last click went.
        bool desk = on && (monitor || (t != IntPtr.Zero && GetForegroundWindow() == t && IsDesktop(t)));
        if (desk) {
            POINT at;
            MONITORINFO info = new MONITORINFO();
            info.Size = 40;
            on = GetCursorPos(out at) && GetMonitorInfo(screen = MonitorFromPoint(at, 2), ref info); // MONITOR_DEFAULTTONEAREST
            r = info.Monitor;
        } else {
            // The visible frame (DWMWA_EXTENDED_FRAME_BOUNDS = 9), not GetWindowRect, which includes invisible resize borders.
            on = on && t != IntPtr.Zero && GetForegroundWindow() == t && !IsIconic(t)
                && DwmGetWindowAttribute(t, 9, out r, 16) == 0;
            if (on) screen = MonitorFromWindow(t, 2);
        }
        on = on && r.Right > r.Left && r.Bottom > r.Top;
        if (!on) {
            if (shown) { foreach (BeamStrip s in strips) ShowWindow(s.Handle, 0); shown = false; } // SW_HIDE
            return;
        }
        bool animate;
        bool wasStill = still;
        still = SystemParametersInfo(0x1042, 0, out animate, 0) && !animate;   // SPI_GETCLIENTAREAANIMATION
        bool placed = desk ? shown : Above(t);
        bool moved = !shown || still != wasStill || r.Left != last.Left || r.Top != last.Top || r.Right != last.Right || r.Bottom != last.Bottom;
        // A window that became maximized or not, or rounded or not, at the same size: the tables are made again.
        bool inward = desk || IsZoomed(t);
        int radius = desk ? 0 : CornerRadiusAt96(t);
        string shape = (desk ? "desk" : inward ? "max" : "win") + radius;
        if (!layout.EndsWith(shape)) moved = true;
        if (placed && !moved) return;
        if (moved) {
            uint dpi, dpiY;
            if (GetDpiForMonitor(screen, 0, out dpi, out dpiY) != 0) dpi = 96; // MDT_EFFECTIVE_DPI
            // A monitor or a maximized window has nothing visible outside it: the glow goes inside, and is narrower
            // (the pill sits 8 px below the top edge and must stay clear of it).
            Layout(r.Right - r.Left, r.Bottom - r.Top, dpi / 96.0, radius, inward, shape);
            last = r;
            Paint(true);
        }
        // HWND_TOPMOST (-1), raised again only when the target (itself always-on-top, then) has come over it.
        // SWP_NOSIZE 0x01 | SWP_NOMOVE 0x02 | SWP_NOACTIVATE 0x10 | SWP_SHOWWINDOW 0x40, and SWP_NOZORDER 0x04 when it
        // is already above the target. (Paint has put the strips where they belong.)
        foreach (BeamStrip s in strips) {
            if (s.W > 0 && s.H > 0) SetWindowPos(s.Handle, new IntPtr(-1), 0, 0, 0, 0, placed ? 0x0057u : 0x0053u);
            else ShowWindow(s.Handle, 0);
        }
        shown = true;
    }

    static double Clamp(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

    // The four strips for a w x h frame, and for each of their pixels: how much of it is border, how much glow, and how
    // far along the border it is (clockwise from the top left corner). The border is the `b` px just inside the frame,
    // rounded like the window; the glow fades over `g` px outside it (inside it for a monitor or a maximized window).
    void Layout(int w, int h, double scale, int radiusAt96, bool inward, string shape) {
        string key = w + "x" + h + "@" + scale + (inward ? "in" : "out") + shape;
        if (key == layout) return;
        layout = key;
        int b = Math.Max(2, (int)Math.Round(thickness * scale));
        int g = (int)Math.Round((inward ? 4 : 6) * scale);
        int outer = inward ? 0 : g, inner = inward ? g : 0;
        double rad = Math.Min(Math.Round(radiusAt96 * scale), Math.Min(w, h) / 2.0);
        int corner = Math.Min(Math.Max(b + inner, (int)rad), h / 2);   // rows the top and bottom strips take from the frame
        int side = Math.Min(b + inner, w / 2);
        strips[0].SetSize(-outer, -outer, w + 2 * outer, outer + corner);
        strips[1].SetSize(w - side, corner, side + outer, h - 2 * corner);
        strips[2].SetSize(-outer, h - corner, w + 2 * outer, outer + corner);
        strips[3].SetSize(-outer, corner, side + outer, h - 2 * corner);
        double across = w - 2 * rad, down = h - 2 * rad, arc = Math.PI * rad / 2;
        perimeter = Math.Max(1, (int)Math.Ceiling(2 * across + 2 * down + 4 * arc));
        level = new int[perimeter];
        for (int k = 0; k < 4; k++) {
            BeamStrip s = strips[k];
            for (int l = 0; l < s.From.Length; l++) { s.From[l] = int.MaxValue; s.To[l] = -1; }
            for (int j = 0; j < s.H; j++) {
                for (int i = 0; i < s.W; i++) {
                    double x = s.X + i + 0.5, y = s.Y + j + 0.5;
                    // Distance to the frame's rounded edge: negative inside it.
                    double qx = Math.Abs(x - w / 2.0) - (w / 2.0 - rad), qy = Math.Abs(y - h / 2.0) - (h / 2.0 - rad);
                    double ox = Math.Max(qx, 0), oy = Math.Max(qy, 0);
                    double d = Math.Sqrt(ox * ox + oy * oy) + Math.Min(Math.Max(qx, qy), 0) - rad;
                    double border = Clamp(0.5 - d, 0, 1) * Clamp(d + b + 0.5, 0, 1);
                    double fade = 0;
                    if (outer > 0 && d > 0) fade = 1 - d / outer;
                    else if (inner > 0 && d < -b) fade = 1 - (-b - d) / inner;
                    if (fade < 0) fade = 0;
                    // How far along: straight along the strip's own side, by angle in a rounded corner.
                    bool leftEnd = x < rad, rightEnd = x > w - rad;
                    double along;
                    if (k == 0) {
                        if (leftEnd) along = rad * Clamp(Math.Atan2(rad - y, rad - x), 0, Math.PI / 2);
                        else if (rightEnd) along = arc + across + rad * Clamp(Math.Atan2(x - (w - rad), rad - y), 0, Math.PI / 2);
                        else along = arc + Clamp(x, rad, w - rad) - rad;
                    } else if (k == 1) {
                        along = 2 * arc + across + Clamp(y, rad, h - rad) - rad;
                    } else if (k == 2) {
                        if (rightEnd) along = 2 * arc + across + down + rad * Clamp(Math.Atan2(y - (h - rad), x - (w - rad)), 0, Math.PI / 2);
                        else if (leftEnd) along = 3 * arc + 2 * across + down + rad * Clamp(Math.Atan2(rad - x, y - (h - rad)), 0, Math.PI / 2);
                        else along = 3 * arc + across + down + (w - rad) - Clamp(x, rad, w - rad);
                    } else {
                        along = 4 * arc + 2 * across + down + (h - rad) - Clamp(y, rad, h - rad);
                    }
                    int at = j * s.W + i;
                    s.Border[at] = (byte)Math.Round(255 * border);
                    s.Glow[at] = (byte)Math.Round(255 * fade * fade);
                    int place = Math.Min(perimeter - 1, Math.Max(0, (int)along));
                    s.Along[at] = place;
                    if (s.Border[at] != 0 || s.Glow[at] != 0) {
                        int l = k % 2 == 0 ? i : j;
                        if (place < s.From[l]) s.From[l] = place;
                        if (place > s.To[l]) s.To[l] = place;
                    }
                }
            }
        }
    }

    // One frame: where the highlight is now, then the strips' pixels from the tables. `all`: every pixel (a new size, a
    // new place, the first frame); otherwise only the lines the highlight is on now or was on in the frame before.
    void Paint(bool all) {
        int n = perimeter, glow = GlowMax;
        int[] lv = level, sh = shade;
        int start = 0, span = n;   // the part of the border to fill: `span` px on from `start` (n: all of it)
        if (still || paused) {
            // No travel. Without animations: the plain steady border. Paused: the whole border, with half the glow,
            // breathing slowly between 60% and 100% - one opacity for the whole strip, so no pixel is filled again.
            if (!all) {
                double phase = (clock.ElapsedMilliseconds % BreatheMs) / (double)BreatheMs;
                byte alpha = (byte)(255 * (0.8 + 0.2 * Math.Cos(2 * Math.PI * phase)));
                foreach (BeamStrip s in strips) s.Fade(alpha);
                return;
            }
            for (int i = 0; i < n; i++) lv[i] = 256;
            glow = still ? 0 : GlowMax / 2;
        } else {
            // One highlight: brightest at its head, a long soft tail behind it (30% of the way round), a short rise ahead.
            double head = (clock.ElapsedMilliseconds % LoopMs) / (double)LoopMs * n;
            double tail = 0.30 * n, lead = 0.04 * n;
            // What changes: from the end of the tail as it was in the last frame to the front of the rise now.
            double moved = head - lastHead;
            if (moved < 0) moved += n;
            if (!all && moved + tail + lead + 4 < n) {
                start = (int)Math.Floor(lastHead - tail) - 1;
                if (start < 0) start += n;
                span = (int)Math.Ceiling(moved + tail + lead) + 3;
            }
            lastHead = head;
            for (int k = 0, i = start; k <= span && k < n; k++, i++) {
                if (i >= n) i -= n;
                double behind = head - i;
                if (behind < 0) behind += n;
                double v = behind < tail ? 1 - behind / tail : (n - behind) < lead ? 1 - (n - behind) / lead : 0;
                lv[i] = (int)(256 * v * v);
            }
        }
        for (int k = 0; k < 4; k++) {
            BeamStrip s = strips[k];
            int w = s.W, h = s.H;
            if (w == 0 || h == 0) continue;
            // The lines of this strip that lie on that part of the border: the first and the last of them.
            bool rows = k % 2 == 1;   // a side strip: its lines are rows
            int lines = rows ? h : w, first = lines, final = -1;
            int[] from = s.From, to = s.To;
            for (int l = 0; l < lines; l++) {
                int f = from[l], t = to[l];
                if (t < f) continue;   // a line with nothing of the border on it
                if (span < n && t - f <= n / 2) {   // (a longer one is where the border's end meets its start)
                    int after = f - start;
                    if (after < 0) after += n;
                    if (after > span && after + (t - f) < n) continue;
                }
                if (l < first) first = l;
                final = l;
            }
            if (final < 0) continue;   // the highlight is elsewhere: this strip stays as it is
            byte[] border = s.Border, fade = s.Glow;
            int[] along = s.Along, px = s.Pixels;
            int x0 = rows ? 0 : first, x1 = rows ? w - 1 : final, y0 = rows ? first : 0, y1 = rows ? final : h - 1;
            for (int y = y0; y <= y1; y++) {
                for (int x = x0, i = y * w + x0; x <= x1; x++, i++) {
                    int bo = border[i], gl = fade[i];
                    if ((bo | gl) == 0) continue;   // never part of the border: stays clear
                    int v = lv[along[i]];
                    int a = ((bo * (Faint + (((256 - Faint) * v) >> 8))) >> 8) + ((gl * glow * v) >> 16);
                    px[i] = sh[a > 255 ? 255 : a];
                }
            }
            s.Push(last.Left, last.Top);
        }
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

# Per-monitor-v2, like ps-bridge.ps1: the frame bounds and the strips' positions are PHYSICAL pixels on every monitor.
[void][WindowOutline]::SetThreadDpiAwarenessContext([IntPtr](-4))

$hex = $Color.TrimStart('#')
$outline = New-Object WindowOutline
$outline.Start([Convert]::ToInt32($hex.Substring(0,2),16), [Convert]::ToInt32($hex.Substring(2,2),16), [Convert]::ToInt32($hex.Substring(4,2),16),
    $Thickness, [bool]$Paused)
[System.Windows.Forms.Application]::Run()
