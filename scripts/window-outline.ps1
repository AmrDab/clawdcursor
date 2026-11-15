# window-outline.ps1 - the "border beam" around the window the agent is working in.
#
# Spawned/killed by src/core/banner.ts in lockstep with the control-banner pill. It draws ONLY along the frame: eight
# strip windows (four sides, four corners) just INSIDE the window's edge, 28 px deep, over the window's own content
# there. Nothing lies over the middle of the window and nothing on the rest of the screen.
#
# THE LOOK IS Border Beam by Jakub Antalik (libraries.dev, github.com/Jakubantalik/Libraries.dev, packages/border-beam,
# MIT - notice below) as <BorderBeam size="pulse-inner" colorVariant="gold" borderRadius={23} duration={3.9}
# hueRange={46}>: everything else the library's default for that size, theme "dark". The numbers are the library's own
# (dist/index.es.js: po() the pulse-inner CSS, ao()/to()/Re() its layers' blobs, fe() a blob, ge() its timings, so()
# the oscillators, io() the hue turn, G.gold / G.ocean the palettes, pe["pulse-inner"].dark the opacities).
# hueRange does nothing for the pulse sizes: io() (web 1.4.1, still the latest on npm and on GitHub) and the React
# Native port (border-beam-native: PulseBeam is not given it, pulseHueDegrees() turns the full circle) both turn the
# hue a whole 360 degrees every 16 s, whatever hueRange is.
#
#   what              value
#   ----------------  ----------------------------------------------------------------------------------------------
#   ring              the inner 1 px of the frame, corners of radius 23, opacity 1.54 (a CSS opacity: 1): nine
#                     radial-gradient blobs, one per colour of the palette at its place and size (ao(); colour at the
#                     centre to clear at the radius, the first on top), each breathing in size and place, with an
#                     opacity that pulses between .52 and 1 with its quarter
#   inner glow        the same nine blobs with the inner sizes (to(): 65x35 55x30 35x65 15x30 173x28 80x22 69x28 22x38
#                     47x44) over four white ones at the corners (radius 60, alpha .18 times the quarter's pulse, clear
#                     at 70%), opacity .44, shown only near the edge: a mask from 1 at each edge to 0 28 px in (the
#                     four added), clipped to the radius 23
#   bloom             seven blobs (eo: 84x48 72x42 48x84 216x38 102x31 89x38 62x58 at their colours' places) at alpha
#                     .76 (1 - .48 / 2) that do not breathe, blurred 8 px, then clipped and masked to the same 1 px
#                     ring (a browser blurs before it clips or masks), opacity .66, on top
#   colour filter     hue-rotate (a full turn every 16 s, continuous, as io() sets for the pulse sizes) brightness(.75)
#                     saturate(1.2)
#   breathing         sizes x(1 -/+ .28), places +/-33 px, the glow's height x(1 -/+ .34), opacities 1 -> .52, each a
#                     cosine between two values; periods (duration / 2.3 = 3.9 / 2.3) x 1.9, 2.6 and 2.4 s (3.22, 4.41 and
#                     4.07 s) times the library's
#                     factors (so(): .9, 1.26, 1.6, 1.1, .81, 1.88, .98, 1.4, 1.45, 1.32, .84, 1.58)
#   blob sizes        in px as given, whatever the frame's size (pulse-inner does not scale them); places in % of it
#   gold              (240,190,60) (255,210,90) (225,165,40) (250,200,70) (255,225,120) (230,175,50) (245,205,85)
#                     (215,155,35) (255,215,100), at (33%,-7.4%) (12%,-5%) (2.1%,68.3%) (2.1%,68.3%) (74.4%,100%)
#                     (55%,100%) (93.9%,0%) (100%,27.1%) (100%,27.1%), ring sizes 70x40 60x35 40x70 20x35 180x32 85x26
#                     74x32 26x42 52x48
#   ocean (paused)    (100,80,220) (60,120,255) (80,100,200) (50,140,220) (120,80,255) (70,130,255) (140,100,240)
#                     (90,110,230) (130,70,255)
#   fade              in over .6 s when it appears
#
# What is ours, because this is a desktop overlay and not a card on a page:
#   - The window is the library's element and its content the card: the beam is drawn over the window's content along
#     its edge, as the library draws its layers over the card's. The same for a normal, a maximized and a full-screen
#     window and for the desktop (the monitor): there is never anything outside the edge.
#   - The ring's corners have the owner's radius 23 while a Windows 11 window's are 8: at each corner the ring curves
#     in across the window's own corner.
#   - The bloom's blur is worked out once per size, not per frame (its blobs do not move; only its colour turns): at
#     each point along the edge, the inside half of a gaussian of 8 px across it (sampled every 2 px in), then a
#     gaussian of 8 px along the edge.
#   - px are CSS px. The strips are windows that are not DPI aware, so they are filled in CSS px and Windows draws them
#     at the monitor's scale (as a page at that zoom is).
#   - 12.5 frames a second (the motion is slow). A frame works out the ring's and the bloom's colours along the edge
#     (a value every 4 px) and the inner glow's at eight depths (every 4 px in), then fills each pixel of a side by
#     blending the two values either side of it, from fixed weights; the corners pixel by pixel. Only the points of a
#     side a blob reaches (or reached the frame before) are worked out and drawn, as deep as they are lit, and only the
#     span from the first to the last is handed to Windows (the blobs keep their size in px, so on a large window most
#     of the edge is dark).
#   - Paused: the same shape in the library's "ocean" blues, still (drawn once). Where Windows is set to show no
#     animations (SPI_GETCLIENTAREAANIMATION off): one still frame in gold.
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
    [string]$Color = '',   # accepted for the caller's sake; the beam has its own colours (gold, or ocean paused)
    [switch]$Paused        # the paused form: the same glow, still, in blue tones
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// One piece of the beam: a layered window whose pixels are set with UpdateLayeredWindow.
public class BeamStrip : Form {
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

    // Where the strip is, relative to the outlined frame, and its size (CSS px); a zero size: not used.
    public int X, Y, W, H;
    IntPtr dc, bitmap, bits, native;

    public void SetSize(int x, int y, int w, int h) {
        X = x; Y = y;
        w = Math.Max(0, w); h = Math.Max(0, h);
        if (w == W && h == H) return;
        W = w; H = h;
        if (dc == IntPtr.Zero) { dc = CreateCompatibleDC(IntPtr.Zero); native = Marshal.AllocHGlobal(64); }
        IntPtr old = bitmap;
        bitmap = IntPtr.Zero; bits = IntPtr.Zero;
        if (W * H > 0) {
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

    // Put these pixels (premultiplied ARGB, W x H) on screen at this opacity; only the rectangle x0..x1, y0..y1
    // (inclusive) changed, and only it is composed again. The size is in the strip's own units (CSS px): set as a
    // window that is not DPI aware, which Windows then draws at the monitor's scale.
    public void Push(int[] pixels, byte alpha, int x0, int y0, int x1, int y1) {
        if (bits == IntPtr.Zero || pixels == null || pixels.Length != W * H || x1 < x0 || y1 < y0) return;
        // Whole rows in one go (a side strip: all of it - a copy per row costs more than the pixels it saves).
        if (x0 == 0 && x1 == W - 1) Marshal.Copy(pixels, y0 * W, new IntPtr(bits.ToInt64() + 4L * y0 * W), (y1 - y0 + 1) * W);
        else Marshal.Copy(pixels, 0, bits, pixels.Length);
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

// The beam's pixels, apart from any window: Layout lays out the eight strips for a frame of a size, Paint fills them
// for a moment. All in CSS px, the frame's top-left corner at (0, 0).
public class Beam {
    // -- Border Beam, pulse-inner, gold, radius 23, 3.9 s, dark theme (see the table at the top of this file) --
    public const double Duration = 3.9, Radius = 23, HueSeconds = 16, FadeInSeconds = 0.6;
    const double SP = 0.28, DR = 33, OP = 0.48, GH = 0.34;
    const double BS = 1.9 * Duration / 2.3, SS = 2.6 * Duration / 2.3, GHS = 2.4 * Duration / 2.3;
    const double StrokeOpacity = 1.54, InnerOpacity = 0.44, BloomOpacity = 0.66, Brightness = 0.75, Saturation = 1.2;
    const double BloomAlpha = 1 - OP * 0.5, BloomBlur = 8, CornerAlpha = 0.18, CornerReach = 60 * 0.7;
    public const int Band = 28;   // the inner glow's mask: 1 at the edge, 0 this far in

    // The oscillators (so()): from, to, period, delay. Per blob region 1..3: width, height, x, y; then the glow's height
    // and the opacity of each quarter (top-left, top-right, bottom-left, bottom-right).
    static readonly double[] Osc = {
        1 - SP, 1 + SP * 1.1, SS * 0.9, 0,   1 + SP * 0.9, 1 - SP * 0.85, SS * 1.26, 0,   -DR, DR * 0.9, BS * 1.6, 0,   DR * 0.55, -DR * 0.7, BS * 1.6, 0,
        1 + SP, 1 - SP * 0.85, SS * 1.1, 0,   1 - SP * 0.8, 1 + SP * 1.05, SS * 0.81, 0,   DR * 0.8, -DR * 0.9, BS * 1.88, 0,   -DR, DR * 0.65, BS * 1.88, 0,
        1 - SP * 0.6, 1 + SP * 1.15, SS * 0.98, 0,   1 + SP * 0.75, 1 - SP, SS * 1.4, 0,   -DR * 0.6, DR, BS * 1.45, 0,   -DR * 0.85, DR * 0.45, BS * 1.45, 0,
        1 - GH, 1 + GH, GHS, 0,
        1 - OP, 1, BS, 0,   1 - OP, 1, BS * 1.32, BS * 0.28,   1 - OP, 1, BS * 0.84, BS * 0.55,   1 - OP, 1, BS * 1.58, BS * 0.83 };
    // The palette's blobs, one per colour in its order (G.*.border with Fe and Je): place x, y (% of the box), the ring's
    // reach x, y (px), the inner glow's, region (1..3), quarter (0 tl, 1 tr, 2 bl, 3 br).
    static readonly double[] Blob = {
        33, -7.4, 70, 40, 65, 35, 1, 0,     12, -5, 60, 35, 55, 30, 2, 0,       2.1, 68.3, 40, 70, 35, 65, 3, 2,
        2.1, 68.3, 20, 35, 15, 30, 1, 2,    74.4, 100, 180, 32, 173, 28, 2, 3,  55, 100, 85, 26, 80, 22, 3, 3,
        93.9, 0, 74, 32, 69, 28, 1, 1,      100, 27.1, 26, 42, 22, 38, 2, 1,    100, 27.1, 52, 48, 47, 44, 3, 1 };
    // The bloom's blobs (eo): colour, reach x, y (px), at that colour's place. They do not breathe.
    static readonly double[] Bloom = { 0, 84, 48,   1, 72, 42,   2, 48, 84,   4, 216, 38,   5, 102, 31,   6, 89, 38,   8, 62, 58 };
    public static readonly int[] Gold = { 240, 190, 60,  255, 210, 90,  225, 165, 40,  250, 200, 70,  255, 225, 120,  230, 175, 50,  245, 205, 85,  215, 155, 35,  255, 215, 100 };
    public static readonly int[] Ocean = { 100, 80, 220,  60, 120, 255,  80, 100, 200,  50, 140, 220,  120, 80, 255,  70, 130, 255,  140, 100, 240,  90, 110, 230,  130, 70, 255 };

    public bool Paused;
    // The strips (the four corners - top-left, top-right, bottom-right, bottom-left - then the top, right, bottom and
    // left sides), relative to the frame, and what each shows (premultiplied ARGB).
    public int[] X = new int[8], Y = new int[8], W = new int[8], H = new int[8];
    public int[][] Pixels = new int[8][];
    public int[] Dirty = new int[32];   // what the last Paint changed in each strip: x0, y0, x1, y1 (inclusive)
    // A corner, per lit pixel: where in the strip, where in the frame, its place on the edge, and how much of the inner
    // glow and of the ring (and the bloom on it) it takes (of 256).
    int[][] at = new int[8][], index = new int[8][];
    float[][] atX = new float[8][], atY = new float[8][];
    ushort[][] innerW = new ushort[8][], ringW = new ushort[8][];
    // A side: per pixel along it, the value along the edge before it and how much of the one after (of 256); per line
    // across it (its depth, 0 at the edge), the weights, which are the same all along it.
    int[][] below = new int[8][];
    ushort[][] blend = new ushort[8][];

    const double Step = 4;   // px between the values worked out along the edge
    const int na = 8;        // values on each corner
    const int Layers = 8;    // the inner glow along the sides at depths .5, 4.5, ... 28.5 px
    int fw, fh, n, depth, nx, ny;
    double rc;
    double[] px, py, nxs, nys;          // the edge, every `Step` px: a point on it and the outward normal there
    int[] part;                         // which part of the band each point is in (0..3 the sides, 4..7 the corners)
    double[,] parts = new double[8, 4]; // those parts: x0, y0, x1, y1
    double[] bloomR, bloomG, bloomB, bloomA;   // the bloom along the edge, blurred, before its colour filter
    int[] ringP, bloomP, grid, table;   // this frame: along the edge; the inner glow by layer; per point and depth
    byte[] lit, was;                    // per point on the sides, how many lines from the edge in are lit (now, before)
    int ringDepth;                      // the lines the ring takes
    // This frame's blobs: the ring's nine, then the inner glow's nine and its four white corners. Centre, reach,
    // 1 / reach, alpha, colour; and per part of the band, which of them reach it.
    const int Blobs = 22;
    double[] bx = new double[Blobs], by = new double[Blobs], brx = new double[Blobs], bry = new double[Blobs];
    double[] bix = new double[Blobs], biy = new double[Blobs], bal = new double[Blobs];
    double[] bcr = new double[Blobs], bcg = new double[Blobs], bcb = new double[Blobs];
    int[][] ringIn = new int[8][], innerIn = new int[8][];
    int[] ringCount = new int[8], innerCount = new int[8];

    static double Clamp01(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    // Distance to the edge of a rounded rectangle centred on the origin: negative inside it.
    static double Sdf(double x, double y, double halfW, double halfH, double radius) {
        radius = Math.Max(0, Math.Min(radius, Math.Min(halfW, halfH)));
        double qx = Math.Abs(x) - halfW + radius, qy = Math.Abs(y) - halfH + radius;
        double ox = Math.Max(qx, 0), oy = Math.Max(qy, 0);
        return Math.Sqrt(ox * ox + oy * oy) + Math.Min(Math.Max(qx, qy), 0) - radius;
    }
    // How much of a pixel whose centre is this far from an edge is inside it.
    static double Cover(double sdf) { return Clamp01(0.5 - sdf); }

    // The eight strips for a w x h frame, the edge, the bloom along it, and for each pixel its place on the edge and
    // how much of the inner glow and the ring it takes.
    public void Layout(int w, int h) {
        fw = w; fh = h;
        rc = Math.Min(Radius, Math.Min(w, h) / 2.0);
        int c = depth = Math.Max(1, Math.Min(Band, Math.Min(w, h) / 2));
        int[] r = { 0, 0, c, c,   w - c, 0, c, c,   w - c, h - c, c, c,   0, h - c, c, c,
                    c, 0, w - 2 * c, c,   w - c, c, c, h - 2 * c,   c, h - c, w - 2 * c, c,   0, c, c, h - 2 * c };
        double[] box = { 0, 0, w, c,   w - c, 0, w, h,   0, h - c, w, h,   0, 0, c, h,
                         w - c, 0, w, c,   w - c, h - c, w, h,   0, h - c, c, h,   0, 0, c, c };   // sides; corners tr, br, bl, tl
        for (int k = 0; k < 8; k++) for (int i = 0; i < 4; i++) parts[k, i] = box[4 * k + i];

        // The edge: top, top-right corner, right, bottom-right, bottom, bottom-left, left, top-left; a value every 4 px.
        double lx = Math.Max(0, w - 2 * rc), ly = Math.Max(0, h - 2 * rc);
        nx = (int)Math.Ceiling(lx / Step) + 1; ny = (int)Math.Ceiling(ly / Step) + 1;
        n = 2 * nx + 2 * ny + 4 * na;
        px = new double[n]; py = new double[n]; nxs = new double[n]; nys = new double[n]; part = new int[n];
        int s = 0;
        for (int side = 0; side < 4; side++) {
            int count = side % 2 == 0 ? nx : ny;
            for (int k = 0; k < count; k++, s++) {
                double f = count > 1 ? (double)k / (count - 1) : 0.5;
                part[s] = side;
                if (side == 0) { px[s] = rc + lx * f; py[s] = 0; nxs[s] = 0; nys[s] = -1; }
                else if (side == 1) { px[s] = w; py[s] = rc + ly * f; nxs[s] = 1; nys[s] = 0; }
                else if (side == 2) { px[s] = w - rc - lx * f; py[s] = h; nxs[s] = 0; nys[s] = 1; }
                else { px[s] = 0; py[s] = h - rc - ly * f; nxs[s] = -1; nys[s] = 0; }
            }
            // The corner after this side: its centre, and the angle it starts at (y grows downward).
            double cx = side == 0 || side == 1 ? w - rc : rc, cy = side == 0 || side == 3 ? rc : h - rc, a0 = -90 + 90 * side;
            for (int k = 0; k < na; k++, s++) {
                double a = (a0 + 90.0 * k / (na - 1)) * Math.PI / 180;
                part[s] = 4 + side;
                nxs[s] = Math.Cos(a); nys[s] = Math.Sin(a); px[s] = cx + rc * nxs[s]; py[s] = cy + rc * nys[s];
            }
        }
        ringP = new int[n]; bloomP = new int[n]; grid = new int[n * Layers]; table = new int[n * c];
        lit = new byte[n]; was = new byte[n];

        // The bloom, once: its blobs do not move (only its colour turns, after the blur). At each point, the inside half
        // of a gaussian across the edge (there is nothing outside the window to blur in), every 2 px in ...
        int[] pal = Paused ? Ocean : Gold;
        int nb = Bloom.Length / 3;
        bloomR = new double[n]; bloomG = new double[n]; bloomB = new double[n]; bloomA = new double[n];
        double[] sr = new double[n], sg = new double[n], sb = new double[n], sa = new double[n];
        for (int k = 0; k < n; k++) {
            for (double d = 1; d < 3 * BloomBlur; d += 2) {
                double x = px[k] - d * nxs[k], y = py[k] - d * nys[k];
                if (Sdf(x - w / 2.0, y - h / 2.0, w / 2.0, h / 2.0, rc) > 0) continue;
                double z = (d - 0.5) / BloomBlur, weight = 2 * Math.Exp(-z * z / 2) / (Math.Sqrt(2 * Math.PI) * BloomBlur);
                double cr = 0, cg = 0, cb = 0, ca = 0;
                for (int j = nb - 1; j >= 0; j--) {   // the first blob on top
                    int ci = (int)Bloom[3 * j];
                    double dx = (x - Blob[8 * ci] / 100 * w) / Bloom[3 * j + 1], dy = (y - Blob[8 * ci + 1] / 100 * h) / Bloom[3 * j + 2];
                    double d2 = dx * dx + dy * dy;
                    if (d2 >= 1) continue;
                    double v = (1 - Math.Sqrt(d2)) * BloomAlpha, keep = 1 - v;
                    cr = pal[3 * ci] / 255.0 * v + cr * keep; cg = pal[3 * ci + 1] / 255.0 * v + cg * keep;
                    cb = pal[3 * ci + 2] / 255.0 * v + cb * keep; ca = v + ca * keep;
                }
                sr[k] += cr * weight; sg[k] += cg * weight; sb[k] += cb * weight; sa[k] += ca * weight;
            }
        }
        // ... then a gaussian along it (the values are about 4 px apart, round the closed edge).
        int reach = (int)Math.Ceiling(3 * BloomBlur / Step);
        double[] kernel = new double[reach + 1];
        double total = 0;
        for (int i = 0; i <= reach; i++) { double z = i * Step / BloomBlur; kernel[i] = Math.Exp(-z * z / 2); total += i == 0 ? kernel[i] : 2 * kernel[i]; }
        for (int k = 0; k < n; k++) {
            for (int i = -reach; i <= reach; i++) {
                int j = ((k + i) % n + n) % n;
                double f = kernel[Math.Abs(i)] / total;
                bloomR[k] += sr[j] * f; bloomG[k] += sg[j] * f; bloomB[k] += sb[j] * f; bloomA[k] += sa[j] * f;
            }
        }

        for (int k = 0; k < 8; k++) {
            X[k] = r[4 * k]; Y[k] = r[4 * k + 1]; W[k] = Math.Max(0, r[4 * k + 2]); H[k] = Math.Max(0, r[4 * k + 3]);
            Pixels[k] = new int[W[k] * H[k]];
            if (k >= 4) {
                // A side: across it by the middle of its length (depth 0 at the edge), along it by its place.
                int side = k - 4;
                bool rows = side % 2 == 0;   // the top and the bottom: a row of pixels runs along the edge
                int length = rows ? W[k] : H[k];
                innerW[k] = new ushort[c]; ringW[k] = new ushort[c];
                for (int d = 0; d < c; d++) {
                    double x = side == 1 ? w - d - 0.5 : side == 3 ? d + 0.5 : w / 2.0, y = side == 0 ? d + 0.5 : side == 2 ? h - d - 0.5 : h / 2.0;
                    Weigh(x, y, out innerW[k][d], out ringW[k][d]);
                }
                if (side == 0) { ringDepth = 0; for (int d = 0; d < c; d++) if (ringW[k][d] != 0) ringDepth = d + 1; }
                below[k] = new int[length]; blend[k] = new ushort[length];
                int first = side == 0 ? 0 : side == 1 ? nx + na : side == 2 ? nx + ny + 2 * na : 2 * nx + ny + 3 * na, count = rows ? nx : ny;
                double span = Math.Max(1e-9, (rows ? w : h) - 2 * rc);
                for (int i = 0; i < length; i++) {
                    double a = rows ? Math.Max(rc, Math.Min(w - rc, X[k] + i + 0.5)) : Math.Max(rc, Math.Min(h - rc, Y[k] + i + 0.5));
                    double pos = (side == 0 || side == 1 ? a - rc : (rows ? w : h) - rc - a) / span * (count - 1);
                    int lo = Math.Max(0, Math.Min((int)Math.Floor(pos), count - 2));
                    below[k][i] = first + lo; blend[k][i] = (ushort)Math.Round(256 * Clamp01(pos - lo));
                }
                continue;
            }
            List<int> spots = new List<int>(), where = new List<int>();
            List<float> lx0 = new List<float>(), ly0 = new List<float>();
            List<ushort> wi = new List<ushort>(), wr = new List<ushort>();
            for (int j = 0; j < H[k]; j++) {
                for (int i = 0; i < W[k]; i++) {
                    double x = X[k] + i + 0.5, y = Y[k] + j + 0.5;
                    ushort vi, vr;
                    Weigh(x, y, out vi, out vr);
                    if ((vi | vr) == 0) continue;
                    spots.Add(j * W[k] + i); where.Add(Place(x, y)); lx0.Add((float)x); ly0.Add((float)y); wi.Add(vi); wr.Add(vr);
                }
            }
            at[k] = spots.ToArray(); index[k] = where.ToArray(); atX[k] = lx0.ToArray(); atY[k] = ly0.ToArray();
            innerW[k] = wi.ToArray(); ringW[k] = wr.ToArray();
        }
    }

    // How much of the inner glow and of the ring (of 256) the pixel at (x, y) takes: the glow's mask (1 at each edge
    // to 0 28 px in, the four added) and the ring (the inner 1 px), both inside the frame's rounded edge.
    void Weigh(double x, double y, out ushort vi, out ushort vr) {
        double qx = x - fw / 2.0, qy = y - fh / 2.0;
        double cover = Cover(Sdf(qx, qy, fw / 2.0, fh / 2.0, rc));
        double ring = cover - Cover(Sdf(qx, qy, fw / 2.0 - 1, fh / 2.0 - 1, rc - 1));
        double mv = Clamp01(Math.Max(1 - y / Band, 1 - (fh - y) / Band)), mh = Clamp01(Math.Max(1 - x / Band, 1 - (fw - x) / Band));
        vi = (ushort)Math.Round(256 * cover * (1 - (1 - mv) * (1 - mh))); vr = (ushort)Math.Round(256 * Clamp01(ring));
    }

    // The value along the edge nearest this point (frame coordinates, inside it).
    int Place(double x, double y) {
        double cx = Math.Max(rc, Math.Min(fw - rc, x)), cy = Math.Max(rc, Math.Min(fh - rc, y));
        int top = 0, right = nx + na, bottom = right + ny + na, left = bottom + nx + na;
        if (x != cx && y != cy) {   // in a corner's curve: by its angle
            int corner = y < cy ? (x > cx ? 0 : 3) : (x > cx ? 1 : 2);
            double a = Math.Atan2(y - cy, x - cx) * 180 / Math.PI - (-90 + 90 * corner);
            while (a < -1e-9) a += 360;
            while (a > 360) a -= 360;
            int k = (int)Math.Round(Math.Min(90, a) / 90 * (na - 1));
            int start = corner == 0 ? right - na : corner == 1 ? bottom - na : corner == 2 ? left - na : n - na;
            return start + k;
        }
        double lx = Math.Max(1e-9, fw - 2 * rc), ly = Math.Max(1e-9, fh - 2 * rc);
        int sideOf;
        if (x == cx && y == cy) {   // off the corners' curves: the nearest side
            double least = Math.Min(Math.Min(y, fh - y), Math.Min(x, fw - x));
            sideOf = least == y ? 0 : least == fw - x ? 1 : least == fh - y ? 2 : 3;
        } else sideOf = y < cy ? 0 : x > cx ? 1 : y > cy ? 2 : 3;
        if (sideOf == 0) return top + (int)Math.Round((cx - rc) / lx * (nx - 1));
        if (sideOf == 1) return right + (int)Math.Round((cy - rc) / ly * (ny - 1));
        if (sideOf == 2) return bottom + (int)Math.Round((fw - rc - cx) / lx * (nx - 1));
        return left + (int)Math.Round((fh - rc - cy) / ly * (ny - 1));
    }

    // hue-rotate(deg) brightness(b) saturate(s), each step clamped as a browser does, on a colour of 0..1; c and s are
    // the cosine and the sine of the hue's angle.
    static void Filter(double[] rgb, int o, double c, double s) {
        double t = Saturation;
        double r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
        double r1 = Clamp01((0.213 + c * 0.787 - s * 0.213) * r + (0.715 - c * 0.715 - s * 0.715) * g + (0.072 - c * 0.072 + s * 0.928) * b);
        double g1 = Clamp01((0.213 - c * 0.213 + s * 0.143) * r + (0.715 + c * 0.285 + s * 0.140) * g + (0.072 - c * 0.072 - s * 0.283) * b);
        double b1 = Clamp01((0.213 - c * 0.213 - s * 0.787) * r + (0.715 - c * 0.715 + s * 0.715) * g + (0.072 + c * 0.928 + s * 0.072) * b);
        r1 = Clamp01(r1 * Brightness); g1 = Clamp01(g1 * Brightness); b1 = Clamp01(b1 * Brightness);
        rgb[o] = Clamp01((0.213 + 0.787 * t) * r1 + (0.715 - 0.715 * t) * g1 + (0.072 - 0.072 * t) * b1);
        rgb[o + 1] = Clamp01((0.213 - 0.213 * t) * r1 + (0.715 + 0.285 * t) * g1 + (0.072 - 0.072 * t) * b1);
        rgb[o + 2] = Clamp01((0.213 - 0.213 * t) * r1 + (0.715 - 0.715 * t) * g1 + (0.072 + 0.928 * t) * b1);
    }

    static int Pack(double r, double g, double b, double a) {
        int ia = (int)(255 * Clamp01(a) + 0.5);
        int ir = Math.Min(ia, (int)(255 * Clamp01(r) + 0.5)), ig = Math.Min(ia, (int)(255 * Clamp01(g) + 0.5)), ib = Math.Min(ia, (int)(255 * Clamp01(b) + 0.5));
        return (ia << 24) | (ir << 16) | (ig << 8) | ib;
    }

    static uint Scale(uint c, uint w) {
        return (((c & 0x00FF00FF) * w >> 8) & 0x00FF00FF) | ((((c >> 8) & 0x00FF00FF) * w) & 0xFF00FF00);
    }

    // This frame's blob j: centre, reach, alpha and colour (an index into the filtered colours).
    void SetBlob(int j, double x, double y, double rx, double ry, double alpha, double[] col, int ci) {
        bx[j] = x; by[j] = y; brx[j] = rx; bry[j] = ry; bix[j] = 1 / rx; biy[j] = 1 / ry; bal[j] = alpha;
        bcr[j] = col[3 * ci]; bcg[j] = col[3 * ci + 1]; bcb[j] = col[3 * ci + 2];
    }

    // Which of the blobs from..to-1 reach each part of the band, in their order.
    void Reaching(int from, int to, int[][] lists, int[] counts) {
        for (int p = 0; p < 8; p++) {
            if (lists[p] == null) lists[p] = new int[Blobs];
            counts[p] = 0;
            for (int j = from; j < to; j++)
                if (bx[j] + brx[j] > parts[p, 0] && bx[j] - brx[j] < parts[p, 2] && by[j] + bry[j] > parts[p, 1] && by[j] - bry[j] < parts[p, 3])
                    lists[p][counts[p]++] = j;
        }
    }

    // The blobs in `list` at (x, y), the first on top: premultiplied ARGB, times `opacity`.
    int At(double x, double y, int[] list, int count, double opacity) {
        double r = 0, g = 0, b = 0, a = 0;
        for (int i = count - 1; i >= 0; i--) {
            int j = list[i];
            double dx = (x - bx[j]) * bix[j];
            if (dx >= 1 || dx <= -1) continue;
            double dy = (y - by[j]) * biy[j];
            if (dy >= 1 || dy <= -1) continue;
            double d2 = dx * dx + dy * dy;
            if (d2 >= 1) continue;
            double v = (1 - Math.Sqrt(d2)) * bal[j], keep = 1 - v;
            r = bcr[j] * v + r * keep; g = bcg[j] * v + g * keep; b = bcb[j] * v + b * keep; a = v + a * keep;
        }
        return Pack(r * opacity, g * opacity, b * opacity, a * opacity);
    }

    // A pixel's colour: the inner glow (already weighed), the ring over it and the bloom over both, `wr` of each.
    uint Compose(uint inner, int e, uint wr) {
        if (wr == 0) return inner;
        uint ring = Scale((uint)ringP[e], wr);
        uint glow = ring + Scale(inner, 256 - (ring >> 24));
        uint bloom = Scale((uint)bloomP[e], wr);
        return bloom + Scale(glow, 256 - (bloom >> 24));
    }

    // The first point of each side along the edge.
    int First(int side) { return side == 0 ? 0 : side == 1 ? nx + na : side == 2 ? nx + ny + 2 * na : 2 * nx + ny + 3 * na; }

    // The points of a side whose place along it (x on the top and bottom, y on the sides) is within lo..hi: lit `lines`
    // in from the edge.
    void Mark(int side, double lo, double hi, int lines) {
        bool rows = side % 2 == 0;
        int count = rows ? nx : ny, first = First(side);
        double length = rows ? fw : fh, span = Math.Max(1e-9, length - 2 * rc);
        double f0 = side < 2 ? lo - rc : length - rc - hi, f1 = side < 2 ? hi - rc : length - rc - lo;
        int i0 = Math.Max(0, (int)Math.Floor(f0 / span * (count - 1))), i1 = Math.Min(count - 1, (int)Math.Ceiling(f1 / span * (count - 1)));
        for (int i = i0; i <= i1; i++) if (lit[first + i] < lines) lit[first + i] = (byte)lines;
    }

    // The strips at `seconds`: everything breathing as it is then. `moving` false: the still frame (the start).
    // `full` false: Dirty says only where the sides changed (the corners always do: their white blobs pulse).
    public void Paint(double seconds, bool moving, bool full) {
        // The colours turn the whole wheel every 16 s (hueRange does nothing for the pulse sizes).
        double t = moving ? seconds : 0, hue = moving ? 2 * Math.PI * (seconds / HueSeconds % 1) : 0;
        double hc = Math.Cos(hue), hs = Math.Sin(hue);
        double[] o = new double[17];
        for (int k = 0; k < 17; k++) {
            double a = Osc[4 * k], b = Osc[4 * k + 1], p = (t - Osc[4 * k + 3]) / Osc[4 * k + 2];
            o[k] = a + (b - a) * (1 - Math.Cos(2 * Math.PI * p)) / 2;
        }
        int[] pal = Paused ? Ocean : Gold;
        double[] col = new double[30];
        for (int k = 0; k < 27; k++) col[k] = pal[k] / 255.0;
        col[27] = col[28] = col[29] = 1;   // the corners' white
        for (int k = 0; k < 10; k++) Filter(col, 3 * k, hc, hs);

        for (int ci = 0; ci < 9; ci++) {
            int reg = (int)Blob[8 * ci + 6] - 1, q = (int)Blob[8 * ci + 7];
            double x = Blob[8 * ci] / 100 * fw + o[reg * 4 + 2], y = Blob[8 * ci + 1] / 100 * fh + o[reg * 4 + 3];
            SetBlob(ci, x, y, Blob[8 * ci + 2] * o[reg * 4], Blob[8 * ci + 3] * o[reg * 4 + 1] * o[12], o[13 + q], col, ci);
            SetBlob(9 + ci, x, y, Blob[8 * ci + 4] * o[reg * 4], Blob[8 * ci + 5] * o[reg * 4 + 1] * o[12], o[13 + q], col, ci);
        }
        for (int q = 0; q < 4; q++) SetBlob(18 + q, q % 2 == 1 ? fw : 0, q >= 2 ? fh : 0, CornerReach, CornerReach, CornerAlpha * o[13 + q], col, 9);
        Reaching(0, 9, ringIn, ringCount);
        Reaching(9, Blobs, innerIn, innerCount);

        // How far in the sides are lit, point by point: the whole band where an inner glow's blob reaches, the ring's
        // line where only the ring's blobs or the bloom (which stays) do. Only that is worked out and drawn.
        byte[] swap = was; was = lit; lit = swap;
        Array.Clear(lit, 0, n);
        for (int p = 0; p < 4; p++) {
            for (int i = 0; i < ringCount[p] + innerCount[p]; i++) {
                int j = i < ringCount[p] ? ringIn[p][i] : innerIn[p][i - ringCount[p]], lines = i < ringCount[p] ? ringDepth : depth;
                if (p % 2 == 0) Mark(p, bx[j] - brx[j], bx[j] + brx[j], lines); else Mark(p, by[j] - bry[j], by[j] + bry[j], lines);
            }
        }

        // Along the edge: the ring, and the bloom (its blur done once, its colour filtered now).
        double stroke = Math.Min(1, StrokeOpacity);   // (a CSS opacity is at most 1)
        double[] rgb = new double[3];
        for (int k = 0; k < n; k++) {
            int p = part[k];
            ringP[k] = At(px[k], py[k], ringIn[p], ringCount[p], stroke);
            double a = bloomA[k];
            if (a > 1e-4) {
                rgb[0] = bloomR[k] / a; rgb[1] = bloomG[k] / a; rgb[2] = bloomB[k] / a;
                Filter(rgb, 0, hc, hs);
                a *= BloomOpacity;
                bloomP[k] = Pack(rgb[0] * a, rgb[1] * a, rgb[2] * a, a);
                if (p < 4 && lit[k] < ringDepth) lit[k] = (byte)ringDepth;
            } else bloomP[k] = 0;
        }
        // Where the sides are lit, the inner glow at each layer; then per point and depth, the three composed.
        // (A line lit before and not now is worked out once more, clear.)
        for (int k = 0; k < n; k++) {
            int p = part[k], lines = Math.Max(lit[k], was[k]);
            if (p >= 4 || lines == 0) continue;
            bool glow = lit[k] == depth;
            if (glow) {
                for (int l = 0; l < Layers; l++) {
                    double d = 0.5 + 4 * l;
                    grid[k * Layers + l] = At(px[k] - d * nxs[k], py[k] - d * nys[k], innerIn[p], innerCount[p], InnerOpacity);
                }
            }
            ushort[] wi = innerW[4 + p], wr = ringW[4 + p];
            for (int d = 0; d < lines; d++) {
                uint inner = 0;
                if (glow) {
                    int l = k * Layers + (d >> 2);
                    uint f = (uint)(d & 3) * 64;
                    inner = Scale(Scale((uint)grid[l], 256 - f) + Scale((uint)grid[l + 1], f), wi[d]);
                }
                table[k * depth + d] = (int)Compose(inner, k, wr[d]);
            }
        }

        for (int k = 0; k < 4; k++) {   // the corners: pixel by pixel
            int[] pix = Pixels[k], where = at[k], idx = index[k];
            float[] xs = atX[k], ys = atY[k];
            ushort[] wi = innerW[k], wr = ringW[k];
            int p = k == 0 ? 7 : 3 + k;   // top-left, top-right, bottom-right, bottom-left
            for (int i = 0; i < where.Length; i++) {
                uint inner = Scale((uint)At(xs[i], ys[i], innerIn[p], innerCount[p], InnerOpacity), wi[i]);
                pix[where[i]] = (int)Compose(inner, idx[i], wr[i]);
            }
            Dirty[4 * k] = 0; Dirty[4 * k + 1] = 0; Dirty[4 * k + 2] = W[k] - 1; Dirty[4 * k + 3] = H[k] - 1;
        }
        for (int k = 4; k < 8; k++) {   // the sides: per pixel, the two values either side of it along the edge
            int[] pix = Pixels[k], lo = below[k];
            ushort[] mix = blend[k];
            int side = k - 4, length = lo.Length, c = side % 2 == 0 ? H[k] : W[k], from = length, to = -1;
            // A pixel's line in from the edge d: at `first` + d * `next` from where its place along the side starts.
            int first = side == 0 || side == 3 ? 0 : c - 1, next = side == 0 || side == 3 ? 1 : -1;
            int along = side % 2 == 0 ? 1 : c, across = side % 2 == 0 ? length : 1;
            for (int i = 0; i < length; i++) {
                int e = lo[i], lines = Math.Max(Math.Max(lit[e], lit[e + 1]), Math.Max(was[e], was[e + 1]));
                if (lines == 0) continue;
                if (from == length) from = i;
                to = i;
                int e0 = e * depth, e1 = e0 + depth, at0 = i * along + first * across, step = next * across;
                uint m = mix[i], keep = 256 - m;
                for (int d = 0; d < lines; d++)
                    pix[at0 + d * step] = (int)(Scale((uint)table[e0 + d], keep) + Scale((uint)table[e1 + d], m));
            }
            if (full) { from = 0; to = length - 1; }
            if (side % 2 == 0) { Dirty[4 * k] = from; Dirty[4 * k + 1] = 0; Dirty[4 * k + 2] = to; Dirty[4 * k + 3] = c - 1; }
            else { Dirty[4 * k] = 0; Dirty[4 * k + 1] = from; Dirty[4 * k + 2] = c - 1; Dirty[4 * k + 3] = to; }
        }
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

    // The desktop itself: clicking it puts Progman (or the WorkerW that holds the icons) in front. There is no window
    // to go around, so the monitor is outlined.
    static bool IsDesktop(IntPtr t) {
        if (t == GetShellWindow()) return true;
        StringBuilder name = new StringBuilder(32);
        GetClassName(t, name, 32);
        string c = name.ToString();
        return c == "Progman" || c == "WorkerW";
    }

    volatile IntPtr target = IntPtr.Zero;   // written by the stdin thread, read by the timer
    long hideUntil;                         // DateTime ticks (UTC); written by the stdin thread
    RECT last;
    bool shown;
    bool paused;
    bool still;                 // Windows is set to show no animations: one still frame
    bool turning;               // the beam breathes: not paused, not still
    string layout = "";         // what the strips were laid out for
    double zoom = 1;            // physical pixels to a CSS px on the frame's monitor
    double shownAt;             // when the beam came up (for the fade in)
    Beam beam = new Beam();
    BeamStrip[] strips = new BeamStrip[8];
    Stopwatch clock = Stopwatch.StartNew();
    System.Windows.Forms.Timer poll, frame;

    IntPtr Handle { get { return strips[0].Handle; } }
    void BeginInvoke(Action a) { strips[0].BeginInvoke(a); }

    public void Start(bool pausedForm) {
        paused = pausedForm;
        beam.Paused = pausedForm;
        // The strips are windows that are NOT DPI aware: their pixels are CSS px, and the desktop compositor draws
        // them at the monitor's scale. At 150% that is less than half the pixels to fill, at 225% a fifth; the beam is
        // soft, and loses nothing a card on a page at that zoom would have.
        IntPtr aware = SetThreadDpiAwarenessContext(new IntPtr(-1));   // DPI_AWARENESS_CONTEXT_UNAWARE
        for (int i = 0; i < strips.Length; i++) {
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
        // 12.5 frames a second, only while the beam is on screen and breathing (the paused and the still forms are
        // drawn once, when they are laid out).
        frame = new System.Windows.Forms.Timer();
        frame.Interval = 80;
        frame.Tick += (s, e) => { if (shown && turning) Paint(false); };
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
        MONITORINFO info = new MONITORINFO();
        info.Size = 40;
        if (desk) {
            POINT at;
            on = GetCursorPos(out at) && GetMonitorInfo(screen = MonitorFromPoint(at, 2), ref info); // MONITOR_DEFAULTTONEAREST
            r = info.Monitor;
        } else {
            // The visible frame (DWMWA_EXTENDED_FRAME_BOUNDS = 9), not GetWindowRect, which includes invisible resize borders.
            on = on && t != IntPtr.Zero && GetForegroundWindow() == t && !IsIconic(t)
                && DwmGetWindowAttribute(t, 9, out r, 16) == 0;
            if (on) screen = MonitorFromWindow(t, 2);
            // A maximized or full-screen window: its frame can reach past the monitor's edge, where the beam would not show.
            if (on && GetMonitorInfo(screen, ref info) && (IsZoomed(t)
                || (r.Left <= info.Work.Left && r.Top <= info.Work.Top && r.Right >= info.Work.Right && r.Bottom >= info.Work.Bottom))) {
                r.Left = Math.Max(r.Left, info.Monitor.Left); r.Top = Math.Max(r.Top, info.Monitor.Top);
                r.Right = Math.Min(r.Right, info.Monitor.Right); r.Bottom = Math.Min(r.Bottom, info.Monitor.Bottom);
            }
        }
        on = on && r.Right > r.Left && r.Bottom > r.Top;
        if (!on) {
            if (shown) { foreach (BeamStrip s in strips) ShowWindow(s.Handle, 0); shown = false; } // SW_HIDE
            return;
        }
        bool animate;
        bool wasStill = still;
        still = SystemParametersInfo(0x1042, 0, out animate, 0) && !animate;   // SPI_GETCLIENTAREAANIMATION
        turning = !still && !paused;
        bool placed = desk ? shown : Above(t);
        bool moved = !shown || still != wasStill || r.Left != last.Left || r.Top != last.Top || r.Right != last.Right || r.Bottom != last.Bottom;
        if (moved) zoom = ZoomOf(screen);
        if (placed && !moved) return;
        if (moved) {
            if (!shown) shownAt = clock.Elapsed.TotalSeconds;
            // In CSS px from here: the frame as a page at this zoom would measure it.
            int w = Math.Max(1, (int)Math.Round((r.Right - r.Left) / zoom)), h = Math.Max(1, (int)Math.Round((r.Bottom - r.Top) / zoom));
            string key = w + "x" + h;
            if (key != layout) {
                layout = key;
                beam.Layout(w, h);
                for (int k = 0; k < strips.Length; k++) strips[k].SetSize(beam.X[k], beam.Y[k], beam.W[k], beam.H[k]);
            }
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

    // One frame: the beam as it is now, faded in over .6 s when it has just come up (a still beam just appears).
    // `all`: every pixel goes to the screen (a new size or place, the first frame, the fade); otherwise only where the
    // beam is or was.
    void Paint(bool all) {
        double now = clock.Elapsed.TotalSeconds;
        double risen = turning ? Math.Max(0, Math.Min(1, (now - shownAt) / Beam.FadeInSeconds)) : 1;
        beam.Paint(now, turning, all || risen < 1);
        byte opacity = (byte)(255 * risen * risen * (3 - 2 * risen));
        int[] d = beam.Dirty;
        for (int k = 0; k < strips.Length; k++)
            if (strips[k].W > 0 && strips[k].H > 0) strips[k].Push(beam.Pixels[k], opacity, d[4 * k], d[4 * k + 1], d[4 * k + 2], d[4 * k + 3]);
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

# This thread is not DPI aware, as the strips are; where the frame is on screen is read per-monitor-v2, in PHYSICAL
# pixels on every monitor (WindowOutline.Follow), like ps-bridge.ps1.
[void][WindowOutline]::SetThreadDpiAwarenessContext([IntPtr](-1))

$outline = New-Object WindowOutline
$outline.Start([bool]$Paused)
[System.Windows.Forms.Application]::Run()
