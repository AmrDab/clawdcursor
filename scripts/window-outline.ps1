# window-outline.ps1 - the "border beam" around the window the agent is working in.
#
# Spawned/killed by src/core/banner.ts in lockstep with the control-banner pill. It draws ONLY along the frame: four
# strip windows (top, right, bottom, left), each as deep as the beam's inner glow, so nothing lies over the middle of
# the window and nothing on the rest of the screen.
#
# THE LOOK IS A PORT of Border Beam by Jakub Antalik (libraries.dev, github.com/Jakubantalik/Libraries.dev,
# packages/border-beam, MIT - notice below): the default preset the site shows (type rotate, size md, dark theme),
# in OUR colours: amber while the agent works, blue while it waits for you. The colours are a variant made the way the
# library makes its own ("colorful", "ocean", "sunset": nine blob colours, the same places, the same filter).
# The numbers are its own, from spec/beam-spec.json (S), src/styles.ts (C) and the shader
# ports/react-native/border-beam-native/src/rotateShader.ts (R), which mirrors ports/ios/.../BeamShaders.metal:
#
#   what                      value                                                                source
#   ------------------------  -------------------------------------------------------------------  -----------------
#   turn                      a conic gradient about the centre, 0 at the top, clockwise; 1.96 s   S:35, R:44-48
#                             a turn, linear
#   beam window (mask)        0 until 30%, .1 at 36%, .35 at 44%, 1 from 52% to 80%, .35 at 86%,   S:1940, C:1803
#                             .1 at 92%, 0 from 95%
#   stroke ring               1 px band at the edge, opacity .26: the colour blobs under a white   S:92, C:1801-1838
#                             conic highlight (0 until 54%, .1 .3 .6 .75 .6 .3 .1 every 3%, 0      S:1736
#                             from 78%), inside the beam window
#   colour blobs              nine radial gradients, colour at the centre to clear at the radius,  S:1271, R:126-140
#                             the first on top, at fixed places on the edge. OURS, "amber" (around
#                             #f59e0b, from gold to orange as the library's variants range):
#                             (255,170,30) (255,200,60) (245,130,10) (255,215,90) (245,158,11)
#                             (255,190,50) (250,120,20) (255,205,70) (235,140,5)
#   inner glow                the whole rounded rect, opacity .42: the same blobs at .9 size and   S:2024-2033
#                             alpha .45, inside the beam window, fading out 28 px in from each     C:1840-1877
#                             edge; an inset white shadow, alpha .27, over 9 px                    R:150-156
#   bloom                     the 1 px ring with a second white conic (peak .85 at 70-70.5%),      S:1830, S:2034
#                             blurred 8 px (gaussian), opacity .24, clipped to the frame           C:1879-1900
#   colour filter             hue-rotate(-10..+10 deg, ease in and out over 12 s; the library's    S:37-44, C:1697-1707
#                             default is 30, which would take amber to green) brightness(1.3)
#                             saturate(1.2): the feColorMatrix arithmetic of colorMatrix.ts
#   fade                      in over .6 s when it appears (out over .5 s)                         S:41-42
#   pulse (our paused form)   no turn: the whole ring, stroke opacity .94, glow .34, brightness    S:124-143
#                             1.9, held still (#392: "blue and steady"; the library breathes it).  S:5187 (bop-*)
#                             "ocean" blobs: (100,80,220)                                          S:1401
#                             (60,120,255) (80,100,200) (50,140,220) (120,80,255) (70,130,255)
#                             (140,100,240) (90,110,230) (130,70,255); colours do not shift
#
# What is ours, because this is a desktop overlay and not a card on a page:
#   - Pixels are filled on the CPU into per-pixel-alpha layered windows (UpdateLayeredWindow); the desktop compositor
#     blends them. A frame fills only the lines where the beam window's edges are, and the thin rows under the white
#     highlight; a line's colours are filtered again (the hue shift) each time the beam has left it.
#   - The blobs were laid out for a card of about 350 x 140 px (the library's reference size, S: referenceSize). Here
#     each keeps its place and its reach ALONG its edge in proportion to the frame, and its reach ACROSS the edge in px,
#     so a window of any size has the card's colours all the way round and the card's glow depth.
#   - px above are CSS px. The strips are windows that are not DPI aware, so they are filled in CSS px and Windows
#     draws them at the monitor's scale (as a page at that zoom is): at 150% under half the pixels, at 225% a fifth.
#   - About 22 frames a second for a small window, 16 for the rest. The white highlight on the ring, which is what
#     the eye follows, moves on every frame; for all but a small window the glow behind it and the glow ahead of it
#     take turns (one, the other, neither), so a frame changes about two strips and not all four.
#   - The corners follow the window's own radius (the card's is 16).
#   - On a light window (one line of pixels across its middle is read every ten seconds, and nothing is kept of it)
#     the beam is the library's light theme - the highlight and the inset shadow dark instead of white (S:1736 light,
#     S:99), saturate 1.5 - with the stroke and the glow at .6 and .7: the library's .12 and .26 are for a card that
#     is the only thing on its page, and an amber glow that faint is lost on a white document.
#   - The paused form is the library's pulse-outside held still: its blobs do not drift and it does not breathe.
#   - Where Windows is set to show no animations (SPI_GETCLIENTAREAANIMATION off): one still frame, the whole ring.
#
# Border Beam - MIT License - Copyright (c) 2026 Jakub Antalik
# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
# rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
# permit persons to whom the Software is furnished to do so, subject to the following conditions:
# The above copyright notice and this permission notice shall be included in all copies or substantial portions of
# the Software.
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
# WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
# COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
# OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
#
# stdin, from the parent:
#   TARGET <hwnd> <pid>   the window to outline (the pid is for the macOS drawer; ignored here)
#   TARGET                draw nothing
#   HIDE <ms>             step aside for a screen capture (only sent after OUTLINE_CAPTURABLE)
# The beam is shown while that window is the one in front and not minimized, and follows it as it moves or resizes
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
#                                  re-placed on every poll - measured 2026-11-10.) The pill raises itself again on
#                                  its own clock, so it stays above the beam where the two meet.
#
# The Windows drawer; macOS and Linux use scripts/mac/overlay.swift and scripts/linux/overlay.py (`outline`).

param(
    [string]$Color = '',   # accepted for the caller's sake (the Linux drawer takes the colour); the beam has its own
    [switch]$Paused        # the paused form: the whole ring, still, in blue tones
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

// One side of the beam: a layered window whose pixels are set with UpdateLayeredWindow.
public class BeamStrip : Form {
    [StructLayout(LayoutKind.Sequential)] struct PT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct BMI {
        public int Size, Width, Height; public short Planes, BitCount; public int Compression, SizeImage, XPpm, YPpm, ClrUsed, ClrImportant;
    }
    [StructLayout(LayoutKind.Sequential)] struct ULWINFO {
        public int Size; public IntPtr Dst, At, Extent, Src, From; public int Key; public IntPtr Blend; public int Flags; public IntPtr Dirty;
    }
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool UpdateLayeredWindowIndirect(IntPtr hWnd, ref ULWINFO info);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BMI info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);

    public static bool Capturable;   // Windows could not keep a strip out of captures

    public BeamStrip() {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Text = "clawdcursor beam";   // the pill (banner.ps1) looks for this name above itself and goes back over it
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
        // For the person at the screen only: WDA_EXCLUDEFROMCAPTURE (0x11) keeps the beam out of screenshots and OCR.
        // Before Windows 10 2004 the call fails: the parent is told, and sends HIDE before each capture instead.
        bool excluded = false;
        try { excluded = SetWindowDisplayAffinity(Handle, 0x11); } catch { }
        if (!excluded) Capturable = true;
    }

    // Where the strip is, relative to the outlined frame, and its size; a zero size: not used.
    public int X, Y, W, H;
    // Per pixel, made once per size (WindowOutline.Layout):
    public int[] Raw;        // the beam's colour before the colour filter (0xRRGGBB, not premultiplied)
    public byte[] Alpha;     // its opacity with the beam window fully open
    public byte[] Ring;      // how much of the white highlight it takes (the stroke ring, times its opacity)
    public ushort[] Bloom;   // how much of the bloom (of 65535)
    public ushort[] Turn;    // its place on the conic turn, 0..4095 (0: straight up from the centre, then clockwise)
    public int[] Base;       // Raw through the colour filter, premultiplied by Alpha
    public int[] Pixels;     // what is on screen: premultiplied ARGB
    // Per line across the edge (a column of the top and bottom strips, a row of the side ones):
    public int[] From, To;   // the part of the turn it lies on
    public int[] Near, Far;  // its first and last pixel that is part of the beam, counted across the edge
    public int[] RingNear, RingFar;   // ...that is on the stroke ring
    public int[] HaloNear, HaloFar;   // ...that the bloom reaches (the ring is within it)
    public byte[] State;     // what the last frame left there: 0 clear, 1 partly lit, 2 fully lit, 3 fully lit with bloom
    IntPtr dc, bitmap, bits, native;

    public void SetSize(int x, int y, int w, int h) {
        X = x; Y = y;
        if (w == W && h == H) return;
        W = Math.Max(0, w); H = Math.Max(0, h);
        if (dc == IntPtr.Zero) { dc = CreateCompatibleDC(IntPtr.Zero); native = Marshal.AllocHGlobal(64); }
        int n = W * H, lines = Math.Max(W, H);
        Raw = new int[n]; Alpha = new byte[n]; Ring = new byte[n]; Bloom = new ushort[n]; Turn = new ushort[n];
        Base = new int[n]; Pixels = new int[n];
        From = new int[lines]; To = new int[lines]; State = new byte[lines];
        Near = new int[lines]; Far = new int[lines]; RingNear = new int[lines]; RingFar = new int[lines];
        HaloNear = new int[lines]; HaloFar = new int[lines];
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

    // The strip to its place on screen, in physical pixels (the caller is per-monitor aware; Windows turns the point
    // into this window's own units). SWP_NOSIZE 0x01 | SWP_NOZORDER 0x04 | SWP_NOACTIVATE 0x10.
    public void MoveTo(int x, int y) { SetWindowPos(Handle, IntPtr.Zero, x, y, 0, 0, 0x0015); }

    // Put the pixels of the rectangle x0..x1, y0..y1 (inclusive) on screen, at this opacity, where the strip is. Only
    // that rectangle is composed again. The size is in the strip's own units (CSS px): set as a window that is not
    // DPI aware, which Windows then draws at the monitor's scale.
    public void Push(byte alpha, int x0, int y0, int x1, int y1) {
        if (bits == IntPtr.Zero || x1 < x0 || y1 < y0) return;
        // A side strip (narrow, with many rows): whole rows in one go - a copy per row costs more than the pixels it
        // saves. The top and bottom strips (a few long rows): only the part of each row that changed.
        if (H >= W || (x0 == 0 && x1 == W - 1)) Marshal.Copy(Pixels, y0 * W, new IntPtr(bits.ToInt64() + 4L * y0 * W), (y1 - y0 + 1) * W);
        else for (int y = y0; y <= y1; y++) Marshal.Copy(Pixels, y * W + x0, new IntPtr(bits.ToInt64() + 4L * (y * W + x0)), x1 - x0 + 1);
        Marshal.WriteInt32(native, 8, W); Marshal.WriteInt32(native, 12, H);                // size
        Marshal.WriteInt32(native, 16, 0); Marshal.WriteInt32(native, 20, 0);               // from (0, 0) of the bitmap
        Marshal.WriteInt32(native, 24, (alpha << 16) | (1 << 24));                          // AC_SRC_OVER, alpha, AC_SRC_ALPHA
        Marshal.WriteInt32(native, 28, x0); Marshal.WriteInt32(native, 32, y0);             // what changed
        Marshal.WriteInt32(native, 36, x1 + 1); Marshal.WriteInt32(native, 40, y1 + 1);
        ULWINFO info = new ULWINFO();
        info.Size = Marshal.SizeOf(typeof(ULWINFO));
        info.Extent = new IntPtr(native.ToInt64() + 8); info.Src = dc; info.From = new IntPtr(native.ToInt64() + 16);
        info.Blend = new IntPtr(native.ToInt64() + 24); info.Flags = 2;                     // ULW_ALPHA
        info.Dirty = new IntPtr(native.ToInt64() + 28);
        IntPtr aware = SetThreadDpiAwarenessContext(new IntPtr(-1));   // DPI_AWARENESS_CONTEXT_UNAWARE: as the strip is
        UpdateLayeredWindowIndirect(Handle, ref info);
        SetThreadDpiAwarenessContext(aware);
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

    // ── The recipe (Border Beam; see the table at the top of this file) ──
    const double TurnSeconds = 1.96, HueSeconds = 12, HueRange = 10, FadeInSeconds = 0.6;
    const double EdgeFade = 28, ShadowBlur = 9, ShadowAlpha = 0.27, BloomBlur = 8, BloomOpacity = 0.24;
    const double InnerScale = 0.9, InnerAlpha = 0.45, CardW = 350, CardH = 140;
    static readonly double[] BeamMask = { 0, 0, 30, 0, 36, .1, 44, .35, 52, 1, 80, 1, 86, .35, 92, .1, 95, 0, 100, 0 };
    static readonly double[] WhiteStops = { 0, 0, 54, 0, 57, .1, 60, .3, 63, .6, 66, .75, 69, .6, 72, .3, 75, .1, 78, 0, 100, 0 };
    static readonly double[] DarkStops = { 0, 0, 54, 0, 57, .08, 60, .2, 63, .4, 66, .55, 69, .4, 72, .2, 75, .08, 78, 0, 100, 0 };   // the light theme's highlight
    static readonly double[] BloomStops = { 0, 0, 58, 0, 62, .03, 65, .08, 67, .2, 69, .45, 70, .85, 70.5, .85, 71.5, .45, 73, .2, 75, .08, 78, .03, 82, 0 };
    // The nine blobs: where on the card (% of its width, % of its height) and how far they reach (px), then the
    // colours of the two palettes used here, in the same order.
    static readonly double[] BlobPlace = { 33, -7.4, 70, 40,  12, -5, 60, 35,  2.1, 68.3, 40, 70,  2.1, 68.3, 20, 35,  74.4, 100, 180, 32,
                                           55, 100, 85, 26,  93.9, 0, 74, 32,  100, 27.1, 26, 42,  100, 27.1, 52, 48 };
    static readonly int[] Amber = { 255, 170, 30,  255, 200, 60,  245, 130, 10,  255, 215, 90,  245, 158, 11,  255, 190, 50,  250, 120, 20,  255, 205, 70,  235, 140, 5 };
    static readonly int[] Ocean = { 100, 80, 220,  60, 120, 255,  80, 100, 200,  50, 140, 220,  120, 80, 255,  70, 130, 255,  140, 100, 240,  90, 110, 230,  130, 70, 255 };

    const int Q = 4096;   // steps in a turn
    // The three conic gradients, a value (0..256) for each step of the turn from where the beam is.
    static readonly int[] maskAt = Conic(BeamMask), whiteAt = Conic(WhiteStops), darkAt = Conic(DarkStops), bloomAt = Conic(BloomStops);
    static int[] Conic(double[] stops) {
        int[] at = new int[Q];
        for (int q = 0; q < Q; q++) {
            double t = 100.0 * q / Q, v = stops[1];
            for (int i = 2; i < stops.Length; i += 2) {
                if (t <= stops[i - 2]) break;
                double p0 = stops[i - 2], p1 = stops[i];
                double f = p1 > p0 ? Math.Min(1, (t - p0) / (p1 - p0)) : 1;
                v = stops[i - 1] + (stops[i + 1] - stops[i - 1]) * f;
            }
            at[q] = (int)Math.Round(256 * v);
        }
        return at;
    }

    volatile IntPtr target = IntPtr.Zero;   // written by the stdin thread, read by the timer
    long hideUntil;                         // DateTime ticks (UTC); written by the stdin thread
    RECT last;
    bool shown;
    bool paused;
    bool still;                 // Windows is set to show no animations: one still frame
    bool light;                 // what the beam lies on is light: the light theme
    int looks;                  // polls since that was last looked at
    IntPtr lookedAt;            // ...and on which window
    string layout = "";         // what the tables were made for
    double zoom = 1;            // physical pixels to a CSS px on the frame's monitor
    double shownAt;             // when the beam came up (for the fade in)
    BeamStrip[] strips = new BeamStrip[4];   // top, right, bottom, left
    Stopwatch clock = Stopwatch.StartNew();
    System.Windows.Forms.Timer poll, frame;

    IntPtr Handle { get { return strips[0].Handle; } }
    void BeginInvoke(Action a) { strips[0].BeginInvoke(a); }

    public void Start(bool pausedForm) {
        paused = pausedForm;
        // The strips are windows that are NOT DPI aware: their pixels are CSS px, and the desktop compositor draws
        // them at the monitor's scale. At 150% that is less than half the pixels to fill, at 225% a fifth; the beam is
        // soft, and loses nothing a card on a page at that zoom would have.
        IntPtr aware = SetThreadDpiAwarenessContext(new IntPtr(-1));   // DPI_AWARENESS_CONTEXT_UNAWARE
        for (int i = 0; i < 4; i++) {
            strips[i] = new BeamStrip();
            IntPtr created = strips[i].Handle;   // the windows exist (hidden) before the timers or stdin touch them
        }
        SetThreadDpiAwarenessContext(aware);
        if (BeamStrip.Capturable) { try { Console.Out.WriteLine("OUTLINE_CAPTURABLE"); Console.Out.Flush(); } catch { } }
        var t = new Thread(() => {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    string[] p = line.Trim().Split(' ');
                    long n = 0;
                    if (p.Length > 1) long.TryParse(p[1], out n);
                    // EndsWith: a parent that puts a byte-order mark in front of its first line must not lose it.
                    if (p[0].EndsWith("TARGET")) target = new IntPtr(n);
                    else if (p[0].EndsWith("HIDE")) Interlocked.Exchange(ref hideUntil, DateTime.UtcNow.AddMilliseconds(Math.Max(50, Math.Min(n, 10000))).Ticks);
                    else continue;
                    // At once, not on the next poll: the parent waits only 90 ms after HIDE before it captures.
                    try { BeginInvoke((Action)Follow); } catch { }
                }
                Environment.Exit(0);   // stdin closed: the parent is gone, and a beam must not outlive it
            } catch { }
        });
        t.IsBackground = true;
        t.Start();
        poll = new System.Windows.Forms.Timer();
        poll.Interval = 100;
        poll.Tick += (s, e) => Follow();
        poll.Start();
        // Only while the beam is on screen and moving (Layout sets how often).
        frame = new System.Windows.Forms.Timer();
        frame.Interval = 45;
        frame.Tick += (s, e) => { if (shown && !still && !paused) Paint(false); };   // the paused ring is still
        frame.Start();
    }

    // Physical pixels to a CSS px on this monitor.
    static double ZoomOf(IntPtr screen) {
        uint dpi, dpiY;
        if (GetDpiForMonitor(screen, 0, out dpi, out dpiY) != 0) dpi = 96; // MDT_EFFECTIVE_DPI
        return dpi / 96.0;
    }

    // Is this window somewhere above `t` in the z-order? (Walks up from `t`: few windows are above the one in front;
    // the cap is for a z-order that changes under the walk.)
    bool Above(IntPtr t) {
        IntPtr h = GetWindow(t, 3); // GW_HWNDPREV
        for (int i = 0; h != IntPtr.Zero && i < 1000; i++, h = GetWindow(h, 3)) if (h == Handle) return true;
        return false;
    }

    // Where the frame is, in physical pixels: per-monitor aware for as long as this runs.
    void Follow() {
        IntPtr aware = SetThreadDpiAwarenessContext(new IntPtr(-4));   // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
        try { Place(); } finally { SetThreadDpiAwarenessContext(aware); }
    }

    void Place() {
        IntPtr t = target;
        RECT r = new RECT();
        IntPtr screen = IntPtr.Zero;
        bool on = DateTime.UtcNow.Ticks >= Interlocked.Read(ref hideUntil);
        // The desktop in front: the monitor the pointer is on, where the agent's last click went.
        bool desk = on && t != IntPtr.Zero && GetForegroundWindow() == t && IsDesktop(t);
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
        // A window that became rounded or not (maximized, say) at the same size: the tables are made again.
        int radius = desk ? 0 : CornerRadiusAt96(t);
        if (!layout.EndsWith("r" + radius)) moved = true;
        if (moved) zoom = ZoomOf(screen);
        // Light or dark under it: looked at when the beam comes up or goes to another window, and every ten seconds.
        if (!shown || t != lookedAt || ++looks >= 100) {
            looks = 0;
            lookedAt = t;
            bool now = Light(r, light);
            if (now != light) { light = now; moved = true; }
        }
        if (placed && !moved) return;
        if (moved) {
            if (!shown) shownAt = clock.Elapsed.TotalSeconds;
            // In CSS px from here: the frame as a page at this zoom would measure it.
            Layout(Math.Max(1, (int)Math.Round((r.Right - r.Left) / zoom)), Math.Max(1, (int)Math.Round((r.Bottom - r.Top) / zoom)), radius);
            last = r;
            foreach (BeamStrip s in strips) s.MoveTo(r.Left + (int)Math.Round(s.X * zoom), r.Top + (int)Math.Round(s.Y * zoom));
            Paint(true);
        }
        // HWND_TOPMOST (-1), raised again only when the target (itself always-on-top, then) has come over it.
        // SWP_NOSIZE 0x01 | SWP_NOMOVE 0x02 | SWP_NOACTIVATE 0x10 | SWP_SHOWWINDOW 0x40, and SWP_NOZORDER 0x04 when it
        // is already above the target. (The strips are already where they belong.)
        foreach (BeamStrip s in strips) {
            if (s.W > 0 && s.H > 0) SetWindowPos(s.Handle, new IntPtr(-1), 0, 0, 0, 0, placed ? 0x0057u : 0x0053u);
            else ShowWindow(s.Handle, 0);
        }
        shown = true;
    }

    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);

    // Is what the beam lies on light? One line of the screen, a pixel high, across the middle of the frame, read in
    // one go (reading the screen is slow, and slower a pixel at a time): the brightness of sixteen points on it, and
    // nothing else, is used. A beam that was on a light window stays the light one until it is clearly dark, and the
    // other way round.
    bool Light(RECT r, bool was) {
        int inset = (int)(48 * zoom), w = r.Right - r.Left - 2 * inset, h = r.Bottom - r.Top;
        if (w < 2 * inset || h < 4 * inset) return was;
        IntPtr screen = GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) return was;
        IntPtr dc = CreateCompatibleDC(screen), line = CreateCompatibleBitmap(screen, w, 1), before = SelectObject(dc, line);
        double sum = 0;
        int n = 0;
        if (BitBlt(dc, 0, 0, w, 1, screen, r.Left + inset, r.Top + h / 2, 0x00CC0020)) {   // SRCCOPY
            for (int i = 0; i < 16; i++) {
                uint c = GetPixel(dc, w * (2 * i + 1) / 32, 0);   // 0x00BBGGRR
                if (c == 0xFFFFFFFF) continue;
                sum += (0.213 * (c & 255) + 0.715 * ((c >> 8) & 255) + 0.072 * ((c >> 16) & 255)) / 255;
                n++;
            }
        }
        SelectObject(dc, before); DeleteObject(line); DeleteDC(dc); ReleaseDC(IntPtr.Zero, screen);
        return n == 0 ? was : sum / n > (was ? 0.45 : 0.6);
    }

    static double Clamp01(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    // Distance to the edge of a rounded rectangle centred on the origin: negative inside it.
    static double Sdf(double x, double y, double halfW, double halfH, double radius) {
        double qx = Math.Abs(x) - halfW + radius, qy = Math.Abs(y) - halfH + radius;
        double ox = Math.Max(qx, 0), oy = Math.Max(qy, 0);
        return Math.Sqrt(ox * ox + oy * oy) + Math.Min(Math.Max(qx, qy), 0) - radius;
    }
    // How much of a pixel is inside an edge at this distance (one pixel of smoothing, as the shader has).
    static double Cover(double sdf) { double t = Clamp01(sdf + 1); return 1 - t * t * (3 - 2 * t); }

    // The four strips for a w x h frame, and for each of their pixels what the beam is there with its window fully
    // open: the inner glow under the stroke ring (colour and opacity), its share of the white highlight and of the
    // bloom, and its place on the turn. All in CSS px (the strips are drawn at the monitor's scale by Windows).
    void Layout(int w, int h, int radiusAt96) {
        string key = (light ? "light" : "dark") + w + "x" + h + "r" + radiusAt96;
        if (key == layout) return;
        layout = key;
        const double s = 1;
        int ring = Math.Max(1, (int)Math.Round(s));                       // the 1 px stroke
        int deep = Math.Min((int)Math.Ceiling(EdgeFade * s), Math.Min(w, h) / 2);   // how far in the glow reaches
        double rad = Math.Min(Math.Round(radiusAt96 * s), Math.Min(w, h) / 2.0);
        strips[0].SetSize(0, 0, w, deep);
        strips[1].SetSize(w - deep, deep, deep, h - 2 * deep);
        strips[2].SetSize(0, h - deep, w, deep);
        strips[3].SetSize(0, deep, deep, h - 2 * deep);

        // The blobs for this frame: centre and reach in device px, colour, for the stroke and (smaller, fainter) the
        // glow. A blob on the top or bottom edge keeps its place and reach along it in proportion to the width, and
        // its distance from the edge and reach across it in px; one on a side edge the other way round.
        int[] tones = paused ? Ocean : Amber;
        double[] bx = new double[9], by = new double[9], brx = new double[9], bry = new double[9], irx = new double[9], iry = new double[9];
        for (int i = 0; i < 9; i++) {
            double fx = BlobPlace[4 * i] / 100, fy = BlobPlace[4 * i + 1] / 100, rx = BlobPlace[4 * i + 2], ry = BlobPlace[4 * i + 3];
            double smallX = Math.Round(rx * InnerScale), smallY = Math.Round(ry * InnerScale);
            if (fx <= 0.05 || fx >= 0.95) {
                bx[i] = fx < 0.5 ? fx * CardW * s : w - (1 - fx) * CardW * s; by[i] = fy * h;
                brx[i] = rx * s; bry[i] = ry * h / CardH; irx[i] = smallX * s; iry[i] = smallY * h / CardH;
            } else {
                bx[i] = fx * w; by[i] = fy < 0.5 ? fy * CardH * s : h - (1 - fy) * CardH * s;
                brx[i] = rx * w / CardW; bry[i] = ry * s; irx[i] = smallX * w / CardW; iry[i] = smallY * s;
            }
        }
        double strokeOpacity = paused ? 0.94 : light ? 0.6 : 0.26, innerOpacity = light ? 0.7 : paused ? 0.34 : 0.42;
        // The inset shadow: white .27 on a dark window, black .14 on a light one.
        double shade = light ? 0 : 1, shadeAlpha = light ? 0.14 : ShadowAlpha;
        double sigma = BloomBlur * s, edge = EdgeFade * s, shadow = (ShadowBlur + 1) * s;
        double halfW = w / 2.0, halfH = h / 2.0;
        for (int k = 0; k < 4; k++) {
            BeamStrip strip = strips[k];
            for (int l = 0; l < strip.From.Length; l++) {
                strip.From[l] = int.MaxValue; strip.To[l] = -1; strip.State[l] = 0;
                strip.Near[l] = int.MaxValue; strip.Far[l] = -1; strip.RingNear[l] = int.MaxValue; strip.RingFar[l] = -1;
                strip.HaloNear[l] = int.MaxValue; strip.HaloFar[l] = -1;
            }
            Array.Clear(strip.Alpha, 0, strip.Alpha.Length); Array.Clear(strip.Ring, 0, strip.Ring.Length); Array.Clear(strip.Bloom, 0, strip.Bloom.Length);
            Array.Clear(strip.Pixels, 0, strip.Pixels.Length);
            for (int j = 0; j < strip.H; j++) {
                for (int i = 0; i < strip.W; i++) {
                    double x = strip.X + i + 0.5, y = strip.Y + j + 0.5;
                    double sdf = Sdf(x - halfW, y - halfH, halfW, halfH, rad);
                    double inside = Cover(sdf);
                    int at = j * strip.W + i;
                    if (inside <= 0) continue;
                    double band = inside - Cover(Sdf(x - halfW, y - halfH, halfW - ring, halfH - ring, Math.Max(rad - ring, 0)));
                    // The glow: its blobs (the first on top), the inset shadow over them, fading in from the edges.
                    double fade = Clamp01(Math.Max(Math.Max(1 - y / edge, 1 - (h - y) / edge), 0) + Math.Max(Math.Max(1 - x / edge, 1 - (w - x) / edge), 0));
                    double r = 0, g = 0, b = 0, a = 0;
                    if (fade > 0) {
                        for (int n = 8; n >= 0; n--) {
                            double dx = (x - bx[n]) / irx[n], dy = (y - by[n]) / iry[n];
                            double v = InnerAlpha * (1 - Math.Sqrt(dx * dx + dy * dy));
                            if (v <= 0) continue;
                            r = tones[3 * n] / 255.0 * v + r * (1 - v); g = tones[3 * n + 1] / 255.0 * v + g * (1 - v); b = tones[3 * n + 2] / 255.0 * v + b * (1 - v); a = v + a * (1 - v);
                        }
                        double fall = Clamp01(1 + sdf / shadow), cast = shadeAlpha * fall * fall;
                        r = shade * cast + r * (1 - cast); g = shade * cast + g * (1 - cast); b = shade * cast + b * (1 - cast); a = cast + a * (1 - cast);
                        double part = inside * fade * innerOpacity;
                        r *= part; g *= part; b *= part; a *= part;
                    }
                    // The stroke ring over it: its blobs at full strength.
                    if (band > 0) {
                        double sr = 0, sg = 0, sb = 0, sa = 0;
                        for (int n = 8; n >= 0; n--) {
                            double dx = (x - bx[n]) / brx[n], dy = (y - by[n]) / bry[n];
                            double v = 1 - Math.Sqrt(dx * dx + dy * dy);
                            if (v <= 0) continue;
                            sr = tones[3 * n] / 255.0 * v + sr * (1 - v); sg = tones[3 * n + 1] / 255.0 * v + sg * (1 - v); sb = tones[3 * n + 2] / 255.0 * v + sb * (1 - v); sa = v + sa * (1 - v);
                        }
                        double part = Math.Min(1, strokeOpacity) * band;
                        sr *= part; sg *= part; sb *= part; sa *= part;
                        r = sr + r * (1 - sa); g = sg + g * (1 - sa); b = sb + b * (1 - sa); a = sa + a * (1 - sa);
                        strip.Ring[at] = (byte)Math.Round(255 * part);
                    }
                    // The bloom: the ring blurred across the edge (a gaussian), clipped to the frame.
                    double off = -sdf - ring / 2.0;
                    double halo = inside * BloomOpacity * ring / (sigma * 2.5066) * Math.Exp(-off * off / (2 * sigma * sigma));
                    strip.Bloom[at] = paused ? (ushort)0 : (ushort)Math.Round(65535 * halo);
                    if (a > 0.002) {
                        strip.Alpha[at] = (byte)Math.Round(255 * Math.Min(1, a));
                        strip.Raw[at] = ((int)Math.Round(255 * Clamp01(r / a)) << 16) | ((int)Math.Round(255 * Clamp01(g / a)) << 8) | (int)Math.Round(255 * Clamp01(b / a));
                    }
                    if (strip.Alpha[at] == 0 && strip.Ring[at] == 0 && strip.Bloom[at] < 300) { strip.Bloom[at] = 0; continue; }
                    // Where on the turn: 0 straight up from the centre, then clockwise.
                    double turn = Math.Atan2(x - halfW, halfH - y) / (2 * Math.PI);
                    int step = (int)((turn - Math.Floor(turn)) * Q) & (Q - 1);
                    strip.Turn[at] = (ushort)step;
                    int line = k % 2 == 0 ? i : j, across = k % 2 == 0 ? j : i;
                    if (step < strip.From[line]) strip.From[line] = step;
                    if (step > strip.To[line]) strip.To[line] = step;
                    if (across < strip.Near[line]) strip.Near[line] = across;
                    if (across > strip.Far[line]) strip.Far[line] = across;
                    if (strip.Ring[at] != 0) {
                        if (across < strip.RingNear[line]) strip.RingNear[line] = across;
                        if (across > strip.RingFar[line]) strip.RingFar[line] = across;
                    }
                    if (strip.Ring[at] != 0 || strip.Bloom[at] != 0) {
                        if (across < strip.HaloNear[line]) strip.HaloNear[line] = across;
                        if (across > strip.HaloFar[line]) strip.HaloFar[line] = across;
                    }
                }
            }
        }
        // About 22 frames a second (43 to a turn) for a small window, 16 for the rest; and what a frame does besides the
        // highlight (Paint): everything, one side of the beam window, or on every third frame nothing.
        int total = 0;
        foreach (BeamStrip strip in strips) total += strip.W * strip.H;
        frame.Interval = total > 60000 ? 62 : 45;
        glowEvery = total > 60000 ? 3 : 1;
    }

    // hue-rotate(deg) brightness(b) saturate(s) as one matrix on RGB (the feColorMatrix arithmetic browsers use;
    // colorMatrix.ts composedFilterMatrix), in 1/1024ths.
    static int[] Filter(double degrees, double brightness, double saturation) {
        double c = Math.Cos(degrees * Math.PI / 180), s = Math.Sin(degrees * Math.PI / 180), b = brightness, t = saturation;
        double[] hue = {
            (0.213 + c * 0.787 - s * 0.213) * b, (0.715 - c * 0.715 - s * 0.715) * b, (0.072 - c * 0.072 + s * 0.928) * b,
            (0.213 - c * 0.213 + s * 0.143) * b, (0.715 + c * 0.285 + s * 0.140) * b, (0.072 - c * 0.072 - s * 0.283) * b,
            (0.213 - c * 0.213 - s * 0.787) * b, (0.715 - c * 0.715 + s * 0.715) * b, (0.072 + c * 0.928 + s * 0.072) * b };
        double[] sat = {
            0.213 + 0.787 * t, 0.715 - 0.715 * t, 0.072 - 0.072 * t,
            0.213 - 0.213 * t, 0.715 + 0.285 * t, 0.072 - 0.072 * t,
            0.213 - 0.213 * t, 0.715 - 0.715 * t, 0.072 + 0.928 * t };
        int[] m = new int[9];
        for (int row = 0; row < 3; row++)
            for (int col = 0; col < 3; col++) {
                double sum = 0;
                for (int n = 0; n < 3; n++) sum += sat[row * 3 + n] * hue[n * 3 + col];
                m[row * 3 + col] = (int)Math.Round(1024 * sum);
            }
        return m;
    }

    // One frame. `all`: every pixel (a new size, a new place, the first frame). Otherwise, for each line across the
    // edge: nothing where the beam window is closed and was; the whole line where its edges are passing; only the
    // ring's pixels (the white highlight) where it is fully open and was; the whole line again where the bloom is.
    // A line the window has just left is cleared, and its colours are filtered again for the next pass (the hue shift).
    void Paint(bool all) {
        double now = clock.Elapsed.TotalSeconds;
        turning = !still && !paused;
        // Where the beam is, and the colour filter now.
        beam = turning ? (int)(now / TurnSeconds % 1 * Q) : 0;
        double swing = (1 - Math.Cos(2 * Math.PI * now / HueSeconds)) / 2;
        filter = Filter(turning ? -HueRange + 2 * HueRange * swing : 0, paused ? 1.9 : 1.3, light ? 1.5 : 1.2);
        // The highlight and the bloom: white over a dark window, dark over a light one.
        glare = light ? darkAt : whiteAt;
        spark = light ? 0x01000000 : 0x01010101;
        // Coming up: from clear to full over .6 s.
        double risen = Clamp01((now - shownAt) / FadeInSeconds);
        byte opacity = (byte)(255 * (turning ? risen * risen * (3 - 2 * risen) : 1));   // a still ring is drawn once: no fade
        bool rising = risen < 1;
        // The white highlight on the ring (the bright part, which the eye follows) is lit on every frame. The rest - the
        // glow and the ring where the beam window opens and closes - only for a small window: otherwise the side
        // behind the highlight on one frame, the side ahead of it on the next and neither on the third, so a frame
        // changes about two strips, not all four.
        int turnOf = all || rising || glowEvery == 1 ? -1 : tick++ % glowEvery;
        bool behind = turnOf <= 0, ahead = turnOf < 0 || turnOf == 1, glow = behind || ahead;
        int middle = (int)(0.66 * Q);
        int[] mask = maskAt;
        // The beam window, in steps after the beam: closed from 95% round to 30%, fully open from 52% to 80%.
        int closedFrom = (int)(0.95 * Q) + 2, closedTo = Q + (int)(0.30 * Q) - 2, openFrom = (int)(0.52 * Q) + 2, openTo = (int)(0.80 * Q) - 2;
        int shineFrom = (int)(0.54 * Q) - 2, shineTo = (int)(0.78 * Q) + 2;
        for (int k = 0; k < 4; k++) {
            BeamStrip s = strips[k];
            int w = s.W, h = s.H;
            if (w == 0 || h == 0) continue;
            bool rows = k % 2 == 1;   // a side strip: its lines are rows
            int lines = rows ? h : w, first = lines, final = -1, topFirst = int.MaxValue, topLast = -1, runCount = 0, runAct = 0;
            int[] from = s.From, to = s.To, near = s.Near, far = s.Far, topNear = tops, topFar = tope;
            byte[] state = s.State;
            // What to do with each line:
            //   0 nothing
            //   1 the glow at the window's opacity there, and the ring exactly
            //   2 the ring only (the window is fully open and was: the glow is as it is)
            //   3 clear it and filter its colours again
            //   4 every pixel exactly
            //   5 the ring and the bloom's reach only
            if (does.Length < lines) { does = new byte[lines]; level = new int[lines]; glint = new int[lines]; runs = new int[5 * lines + 5]; tops = topNear = new int[lines]; tope = topFar = new int[lines]; }
            byte[] todo = does;
            int[] open = level, shine = glint;   // per line: the beam window's opacity there, and the highlight's through it
            for (int l = 0; l < lines; l++) {
                int f = from[l], t = to[l];
                byte act;
                if (t < f) act = 0;                                   // nothing of the beam on this line
                else if (all) { act = 4; state[l] = 1; }
                else if (t - f > Q / 2) act = glow ? (byte)4 : (byte)2;   // the line straight up from the centre: both ends of the turn
                else if (((f - beam) & (Q - 1)) >= middle && ((f - beam) & (Q - 1)) < closedFrom ? !ahead : !behind) {
                    // Not this side's frame: the ring only, and only where the white highlight is (54% to 78% after
                    // the beam).
                    int after = (f - beam) & (Q - 1);
                    act = after + (t - f) >= shineFrom && after <= shineTo ? (byte)2 : (byte)0;
                    open[l] = mask[((f + t) / 2 - beam) & (Q - 1)];
                }
                else {
                    int after = (f - beam) & (Q - 1), until = after + (t - f);
                    if (after < closedTo - Q) { after += Q; until += Q; }
                    if (after >= closedFrom && until <= closedTo) { act = state[l] == 0 ? (byte)0 : (byte)3; state[l] = 0; }
                    else if (after >= openFrom && until <= openTo) {
                        bool halo = until >= bloomFrom && after <= bloomTo;
                        act = state[l] < 2 ? (byte)1 : halo || state[l] == 3 ? (byte)5 : (byte)2;
                        state[l] = halo && act == 5 ? (byte)3 : (byte)2;
                    }
                    else { act = 1; state[l] = 1; }
                    open[l] = mask[((f + t) / 2 - beam) & (Q - 1)];
                }
                todo[l] = act;
                if (act == 1 || act == 2) shine[l] = (glare[((f + t) / 2 - beam) & (Q - 1)] * open[l]) >> 8;
                // The part of the line to go over exactly, after its run: the ring, or the bloom's reach.
                if (act == 1 || act == 2 || act == 5) {
                    topNear[l] = act == 5 ? s.HaloNear[l] : s.RingNear[l];
                    topFar[l] = act == 5 ? s.HaloFar[l] : s.RingFar[l];
                    if (topNear[l] < topFirst) topFirst = topNear[l];
                    if (topFar[l] > topLast) topLast = topFar[l];
                }
                if (act != 0) { if (l < first) first = l; final = l; }
                // Runs of lines with the same thing to do to their whole depth (1, 3 or 4), 128 lines at most:
                // first, last, what, and the nearest and farthest pixel of the beam on any of them.
                int deep = act == 1 || act == 3 || act == 4 ? act : 0;
                if (deep != runAct || (l & 127) == 0) {
                    if (runAct != 0) { runs[5 * runCount + 1] = l - 1; runCount++; }
                    if (deep != 0) { runs[5 * runCount] = l; runs[5 * runCount + 2] = deep; runs[5 * runCount + 3] = int.MaxValue; runs[5 * runCount + 4] = -1; }
                    runAct = deep;
                }
                if (deep != 0) {
                    if (near[l] < runs[5 * runCount + 3]) runs[5 * runCount + 3] = near[l];
                    if (far[l] > runs[5 * runCount + 4]) runs[5 * runCount + 4] = far[l];
                }
            }
            if (runAct != 0) { runs[5 * runCount + 1] = lines - 1; runCount++; }
            if (final < 0) continue;
            int[] bas = s.Base, px = s.Pixels;
            byte[] ringOf = s.Ring;
            bool plain = turning && !all;   // the glow is its filtered colour at the window's opacity there
            if (rows) {
                for (int y = first; y <= final; y++) {
                    int act = todo[y];
                    if (act == 0) continue;
                    int i0 = y * w;
                    if (act == 3 && plain) { Refilter(s, i0 + near[y], far[y] - near[y] + 1, 1); continue; }
                    if (act == 1 && plain) {
                        uint part = (uint)open[y];
                        for (int x = near[y], i = i0 + x; x <= far[y]; x++, i++) {
                            uint c = (uint)bas[i];
                            px[i] = (int)((((c & 0x00FF00FF) * part >> 8) & 0x00FF00FF) | (((c >> 8) & 0x00FF00FF) * part & 0xFF00FF00));
                        }
                    } else if (act == 3 || act == 4 || act == 1) {
                        for (int x = near[y]; x <= far[y]; x++) Exact(s, i0 + x, act, all);
                    }
                    if (!plain || act == 4) continue;
                    if (act == 5) { for (int x = topNear[y]; x <= topFar[y]; x++) Lit(s, i0 + x); continue; }
                    // The ring: the white highlight over the colour, both through the beam window.
                    int m = open[y], lineShine = shine[y];
                    for (int x = topNear[y], i = i0 + x; x <= topFar[y]; x++, i++) {
                        int over = (ringOf[i] * lineShine) >> 8;
                        uint part = (uint)((m * (256 - over)) >> 8), c = (uint)bas[i];
                        px[i] = (int)((((c & 0x00FF00FF) * part >> 8) & 0x00FF00FF) | (((c >> 8) & 0x00FF00FF) * part & 0xFF00FF00)) + over * spark;
                    }
                }
            } else {
                // The lines the beam has left, each down its own column.
                if (plain) for (int n = 0; n < runCount; n++) {
                    if (runs[5 * n + 2] != 3) continue;
                    for (int x = runs[5 * n]; x <= runs[5 * n + 1]; x++) if (far[x] >= near[x]) Refilter(s, near[x] * w + x, far[x] - near[x] + 1, w);
                }
                // Row by row (as the pixels lie in memory): the runs first, then the ring and the bloom.
                for (int y = 0; y < h; y++) {
                    int i0 = y * w;
                    for (int n = 0; n < runCount; n++) {
                        if (y < runs[5 * n + 3] || y > runs[5 * n + 4]) continue;
                        int x0 = runs[5 * n], x1 = runs[5 * n + 1], act = runs[5 * n + 2];
                        if (act == 1 && plain) {
                            // (A pixel that is not part of the beam is clear, and stays clear.)
                            for (int x = x0, i = i0 + x0; x <= x1; x++, i++) {
                                uint c = (uint)bas[i], part = (uint)open[x];
                                px[i] = (int)((((c & 0x00FF00FF) * part >> 8) & 0x00FF00FF) | (((c >> 8) & 0x00FF00FF) * part & 0xFF00FF00));
                            }
                        } else if (act != 3 || !plain) {
                            for (int x = x0; x <= x1; x++) if (y >= near[x] && y <= far[x]) Exact(s, i0 + x, act, all);
                        }
                    }
                    if (!plain || y < topFirst || y > topLast) continue;
                    for (int x = first, i = i0 + first; x <= final; x++, i++) {
                        int act = todo[x];
                        if (act == 0 || act >= 3 && act != 5 || y < topNear[x] || y > topFar[x]) continue;
                        if (act == 5) { Lit(s, i); continue; }
                        int m = open[x], over = (ringOf[i] * shine[x]) >> 8;
                        uint part = (uint)((m * (256 - over)) >> 8), c = (uint)bas[i];
                        px[i] = (int)((((c & 0x00FF00FF) * part >> 8) & 0x00FF00FF) | (((c >> 8) & 0x00FF00FF) * part & 0xFF00FF00)) + over * spark;
                    }
                }
            }
            if (all || rising) s.Push(opacity, 0, 0, w - 1, h - 1);
            else if (rows) s.Push(opacity, glow ? 0 : topFirst, first, glow ? w - 1 : topLast, final);
            else s.Push(opacity, first, glow ? 0 : topFirst, final, glow ? h - 1 : topLast);
        }
    }

    // A line the beam has left (`count` pixels from `i`, `stride` apart): cleared, and its colours through the colour
    // filter as it is now, premultiplied by their opacity, for the beam's next pass.
    void Refilter(BeamStrip s, int i, int count, int stride) {
        int[] cm = filter, raw = s.Raw, bas = s.Base, px = s.Pixels;
        byte[] alpha = s.Alpha;
        int c0 = cm[0], c1 = cm[1], c2 = cm[2], c3 = cm[3], c4 = cm[4], c5 = cm[5], c6 = cm[6], c7 = cm[7], c8 = cm[8];
        for (int n = 0; n < count; n++, i += stride) {
            px[i] = 0;
            int a = alpha[i];
            if (a == 0) continue;
            int c = raw[i], r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
            int r2 = (c0 * r + c1 * g + c2 * b) >> 10, g2 = (c3 * r + c4 * g + c5 * b) >> 10, b2 = (c6 * r + c7 * g + c8 * b) >> 10;
            r2 = r2 < 0 ? 0 : r2 > 255 ? 255 : r2; g2 = g2 < 0 ? 0 : g2 > 255 ? 255 : g2; b2 = b2 < 0 ? 0 : b2 > 255 ? 255 : b2;
            bas[i] = (a << 24) | (((r2 * a * 257 + 32768) >> 16) << 16) | (((g2 * a * 257 + 32768) >> 16) << 8) | ((b2 * a * 257 + 32768) >> 16);
        }
    }

    // One pixel in full: filtered again where asked, then lit.
    void Exact(BeamStrip s, int i, int act, bool all) {
        int a = s.Alpha[i];
        if ((a | s.Ring[i] | s.Bloom[i]) == 0) return;   // never part of the beam: stays clear
        if (act == 3 || all) {
            // The colour filter, then premultiplied by the pixel's opacity.
            int[] cm = filter;
            int c = s.Raw[i], r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
            int r2 = (cm[0] * r + cm[1] * g + cm[2] * b) >> 10, g2 = (cm[3] * r + cm[4] * g + cm[5] * b) >> 10, b2 = (cm[6] * r + cm[7] * g + cm[8] * b) >> 10;
            r2 = r2 < 0 ? 0 : r2 > 255 ? 255 : r2; g2 = g2 < 0 ? 0 : g2 > 255 ? 255 : g2; b2 = b2 < 0 ? 0 : b2 > 255 ? 255 : b2;
            s.Base[i] = (a << 24) | (((r2 * a * 257 + 32768) >> 16) << 16) | (((g2 * a * 257 + 32768) >> 16) << 8) | ((b2 * a * 257 + 32768) >> 16);
            if (act == 3) { s.Pixels[i] = 0; return; }
        }
        if (!turning) { s.Pixels[i] = s.Base[i]; return; }   // the still frame and the paused form: the whole ring, no highlight
        Lit(s, i);
    }

    // One pixel as the beam lights it now: its colour through the beam window, with the white of the highlight (on
    // the ring) and of the bloom over it.
    void Lit(BeamStrip s, int i) {
        int step = (s.Turn[i] - beam) & (Q - 1);
        int m = maskAt[step];
        int over = ((s.Ring[i] * glare[step] * m) >> 16) + ((s.Bloom[i] * bloomAt[step]) >> 16);
        uint part = (uint)((m * (256 - over)) >> 8), color = (uint)s.Base[i];
        s.Pixels[i] = (int)((((color & 0x00FF00FF) * part >> 8) & 0x00FF00FF) | (((color >> 8) & 0x00FF00FF) * part & 0xFF00FF00)) + over * spark;
    }

    // For the frame being painted.
    bool turning;
    int beam, tick, glowEvery = 1, spark = 0x01010101;
    int[] glare = whiteAt;
    int[] filter;
    byte[] does = new byte[1];
    int[] level = new int[1], glint = new int[1], runs = new int[10], tops = new int[1], tope = new int[1];
    // The part of the beam window where the bloom is strong enough to show at all (it is at most 2 of 255).
    static readonly int bloomFrom = Array.FindIndex(bloomAt, v => v * 1100 >= 65536), bloomTo = Array.FindLastIndex(bloomAt, v => v * 1100 >= 65536);
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

# This thread is not DPI aware, as the strips are; where the frame is on screen is read per-monitor-v2, in PHYSICAL
# pixels on every monitor (WindowOutline.Follow), like ps-bridge.ps1.
[void][WindowOutline]::SetThreadDpiAwarenessContext([IntPtr](-1))

$outline = New-Object WindowOutline
$outline.Start([bool]$Paused)
[System.Windows.Forms.Application]::Run()
