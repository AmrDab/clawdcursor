# window-outline.ps1 - the "border beam" around the window the agent is working in.
#
# Spawned/killed by src/core/banner.ts in lockstep with the control-banner pill. It draws ONLY along the frame: eight
# strip windows (four sides, four corners) that lie OUTSIDE the window, as deep as the glow reaches, plus the 1 px ring
# just inside the window's edge. Nothing lies over the middle of the window and nothing on the rest of the screen.
#
# THE LOOK IS Border Beam by Jakub Antalik (libraries.dev, github.com/Jakubantalik/Libraries.dev, packages/border-beam,
# MIT - notice below) with size="pulse-outside", colorVariant="sunset", borderRadius=30, duration 1.96 s, dark theme.
# The numbers are the library's own (dist/index.es.js: lo() the pulse-outside CSS, ge() its timings, so() the
# oscillators, Re()/fe() the blobs, G.sunset / G.ocean the palettes, pe["pulse-outside"].dark the opacities):
#
#   what              value
#   ----------------  ----------------------------------------------------------------------------------------------
#   ring              the inner 1 px of the frame, corners of radius 30, opacity .94: eight radial-gradient blobs
#                     (colour at the centre to clear at the radius, the first on top), each with its own breathing
#                     size and place and an opacity that pulses between .54 and 1
#   inner glow        the same eight blobs on a box 10 px out (radius 40), blurred 3 px, opacity .34
#   bloom             seven larger blobs at alpha .77 on a box 30 px out (radius 60), blurred 22.5 px, opacity .30
#   colour filter     hue-rotate (a full turn every 14 s, as the library's pulse sizes do) brightness(1.9) saturate(1.2)
#   breathing         sizes x(1 -/+ .28), places +/-14 px, the glow's height x(1 -/+ .16), opacities 1 -> .54, each a
#                     cosine between two values; periods (duration / 2.3) x 2.3, 6.4 and 2.4 s times the library's
#                     factors (so(): .9, 1.26, 1.6, 1.1, .81, 1.88, .98, 1.4, 1.45, 1.32, .84, 1.58)
#   blob sizes        times the frame's size over the library's 350 x 140 reference, clamped to .35..4
#   sunset blobs      (255,80,50) (255,160,40) (255,120,60) (255,200,50) (255,100,80) (255,180,60) (255,60,60)
#                     (255,140,50) (255,90,70)
#   ocean (paused)    (100,80,220) (60,120,255) (80,100,200) (50,140,220) (120,80,255) (70,130,255) (140,100,240)
#                     (90,110,230) (130,70,255)
#   fade              in over .6 s when it appears
#
# What is ours, because this is a desktop overlay and not a card on a page:
#   - The window is opaque, as the library's card is: its glow layers lie behind the card, so only what reaches past
#     the edge shows. Here the strips are outside the frame and the glow is drawn only there.
#   - The library shrinks its glow boxes (scale .95 x .9) about the card's centre; on a whole window that would put the
#     bloom 50 px inside it, out of sight. The boxes keep the reach they have on the 350 x 140 reference card instead:
#     the bloom's edge 20 px out, the inner glow's 2 px out.
#   - The blur is drawn, not computed: across the edge it is the gaussian of the box's edge, along it the blobs' colours
#     at that edge are blurred with it (three box blurs). The glow is faded out by 48 px from the frame.
#   - A maximized or full-screen window, and the desktop itself, have no outside to glow into: there the same glow is
#     drawn inward from the edge (the mirror image), on the monitor.
#   - The ring's corners have the library's radius 30 while a Windows 11 window's are 8: at each corner the ring curves
#     in across the window's own corner.
#   - px are CSS px. The strips are windows that are not DPI aware, so they are filled in CSS px and Windows draws them
#     at the monitor's scale (as a page at that zoom is).
#   - 12.5 frames a second (the motion is slow). A frame works out the colours along the edge once (one value every
#     4 px), then fills each pixel from the value nearest it and its two fixed weights.
#   - Paused: the same shape in the library's "ocean" blues, still (drawn once). Where Windows is set to show no
#     animations (SPI_GETCLIENTAREAANIMATION off): one still frame in sunset.
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
    [string]$Color = '',   # accepted for the caller's sake; the beam has its own colours (sunset, or ocean paused)
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
    // -- Border Beam, pulse-outside, sunset, dark theme (see the table at the top of this file) --
    public const double Duration = 1.96, Radius = 30, HueSeconds = 14, HueRange = 30, FadeInSeconds = 0.6;
    const double SP = 0.28, DR = 14, OP = 0.46, GH = 0.16;
    static readonly double BS = Duration, SS = 6.4 * Duration / 2.3, GHS = 2.4 * Duration / 2.3;   // (bs is 2.3 x duration / 2.3)
    const double StrokeOpacity = 0.94, InnerOpacity = 0.34, BloomOpacity = 0.30, Brightness = 1.9, Saturation = 1.2;
    const double InnerReach = 2, InnerBlur = 3, InnerRadius = 40, BloomReach = 20, BloomBlur = 22.5, BloomRadius = 60;
    const double BloomAlpha = 1 - OP * 0.5;
    public const int Margin = 48;   // how far out the glow goes (it is faded out over the last 16 px)

    // The oscillators (so()): from, to, period, delay. Per blob region 1..3: width, height, x, y; then the glow's height
    // and the opacity of each quarter (top-left, top-right, bottom-left, bottom-right).
    static readonly double[] Osc = {
        1 - SP, 1 + SP * 1.1, SS * 0.9, 0,   1 + SP * 0.9, 1 - SP * 0.85, SS * 1.26, 0,   -DR, DR * 0.9, BS * 1.6, 0,   DR * 0.55, -DR * 0.7, BS * 1.6, 0,
        1 + SP, 1 - SP * 0.85, SS * 1.1, 0,   1 - SP * 0.8, 1 + SP * 1.05, SS * 0.81, 0,   DR * 0.8, -DR * 0.9, BS * 1.88, 0,   -DR, DR * 0.65, BS * 1.88, 0,
        1 - SP * 0.6, 1 + SP * 1.15, SS * 0.98, 0,   1 + SP * 0.75, 1 - SP, SS * 1.4, 0,   -DR * 0.6, DR, BS * 1.45, 0,   -DR * 0.85, DR * 0.45, BS * 1.45, 0,
        1 - GH, 1 + GH, GHS, 0,
        1 - OP, 1, BS, 0,   1 - OP, 1, BS * 1.32, BS * 0.28,   1 - OP, 1, BS * 0.84, BS * 0.55,   1 - OP, 1, BS * 1.58, BS * 0.83 };
    // The ring's and the inner glow's blobs (Ye): colour, region, quarter (0 tl, 1 tr, 2 bl, 3 br), reach x, y (px),
    // place x, y (% of the box).
    static readonly double[] Edge = {
        0, 1, 0, 80, 19, 27, 0,     6, 2, 1, 74, 11, 73, -1,    7, 3, 1, 15, 44, 100, 33,   8, 1, 3, 19, 38, 101, 72,
        4, 2, 3, 84, 13, 67, 100,   1, 3, 2, 60, 21, 24, 101,   2, 1, 2, 17, 40, 0, 60,     3, 2, 0, 13, 32, -1, 28 };
    // The bloom's blobs (oo): colour, reach x, y, place x, y. They do not breathe.
    static readonly double[] Bloom = {
        0, 110, 30, 27, 3,   6, 100, 20, 73, 1,   7, 26, 62, 100, 33,   8, 30, 56, 101, 72,   4, 120, 22, 67, 99,
        1, 88, 32, 24, 99,   2, 28, 58, 0, 60 };
    public static readonly int[] Sunset = { 255, 80, 50,  255, 160, 40,  255, 120, 60,  255, 200, 50,  255, 100, 80,  255, 180, 60,  255, 60, 60,  255, 140, 50,  255, 90, 70 };
    public static readonly int[] Ocean = { 100, 80, 220,  60, 120, 255,  80, 100, 200,  50, 140, 220,  120, 80, 255,  70, 130, 255,  140, 100, 240,  90, 110, 230,  130, 70, 255 };

    public bool Paused;
    // The strips (the four corners, then the top, right, bottom and left sides), relative to the frame; what each shows
    // (premultiplied ARGB); and what the last Paint changed in it (x0, y0, x1, y1, inclusive).
    public int[] X = new int[8], Y = new int[8], W = new int[8], H = new int[8];
    public int[][] Pixels = new int[8][];
    public int[] Dirty = new int[32];
    // A corner, per lit pixel: where in the strip, its place on the edge, and how much of the bloom, the inner glow and
    // the ring it takes (of 256); those the inner glow or the ring reach first (nearTo of them).
    int[][] at = new int[8][], index = new int[8][];
    ushort[][] bloomW = new ushort[8][], innerW = new ushort[8][], ringW = new ushort[8][];
    // A side: its place on the edge per pixel along it; the weights per pixel across it, which are the same all along
    // it; and the part across it that the inner glow or the ring reach (redrawn every frame; the rest, only the bloom's
    // slow colour, every fourth).
    int[][] along = new int[8][], below = new int[8][];   // ...nearest, and the one before it (the ring blends the two)
    ushort[][] blend = new ushort[8][];                    // ...how much of the one after `below` (of 256)
    int[] nearFrom = new int[8], nearTo = new int[8];

    int fw, fh, n, blurRadius;
    double rc, gx, gy, step;   // step: px between the values worked out along the edge
    int nx, ny;
    const int na = 8;   // values on each corner
    double[] px, py, nxs, nys;          // the edge, every `step` px: a point on it and the outward normal there
    float[] bloomV;                     // the bloom's blobs at each point (they do not move)
    int[] ringP, innerP, bloomP;        // the colour along the edge for the frame being painted: premultiplied ARGB
    double[] br, bg, bb, ba, tmp;

    static double Clamp01(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    static double Smooth(double a, double b, double x) { double t = Clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
    // Distance to the edge of a rounded rectangle centred on the origin: negative inside it.
    static double Sdf(double x, double y, double halfW, double halfH, double radius) {
        radius = Math.Max(0, Math.Min(radius, Math.Min(halfW, halfH)));
        double qx = Math.Abs(x) - halfW + radius, qy = Math.Abs(y) - halfH + radius;
        double ox = Math.Max(qx, 0), oy = Math.Max(qy, 0);
        return Math.Sqrt(ox * ox + oy * oy) + Math.Min(Math.Max(qx, qy), 0) - radius;
    }
    // How much of a pixel is inside an edge at this distance (one pixel of smoothing).
    static double Cover(double sdf) { double t = Clamp01(sdf + 1); return 1 - t * t * (3 - 2 * t); }
    // The normal distribution's cumulative function: how much of a gaussian blur of a straight edge reaches this far.
    static double Phi(double x) {
        double z = Math.Abs(x) / Math.Sqrt(2), t = 1 / (1 + 0.3275911 * z);
        double e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.Exp(-z * z);
        return x >= 0 ? 0.5 * (1 + e) : 0.5 * (1 - e);
    }

    // The eight strips for a w x h frame and, for each of their pixels, its place on the edge and how much of the bloom,
    // the inner glow and the ring it takes. Outward: the glow outside the frame (the frame itself hides the rest).
    // Inward (a maximized window, the desktop): the same, mirrored into the frame.
    public void Layout(int w, int h, bool inward) {
        fw = w; fh = h;
        rc = Math.Min(Radius, Math.Min(w, h) / 2.0);
        gx = Math.Max(0.35, Math.Min(4, w / 350.0)); gy = Math.Max(0.35, Math.Min(4, h / 140.0));
        int m = inward ? Math.Max(1, Math.Min(Margin, Math.Min(w, h) / 2)) : Margin;
        int c = inward ? m : Math.Min((int)Math.Ceiling(rc) + 1, Math.Min(w, h) / 2);
        int[] r = inward
            ? new int[] { 0, 0, m, m,   w - m, 0, m, m,   w - m, h - m, m, m,   0, h - m, m, m,
                          m, 0, w - 2 * m, m,   w - m, m, m, h - 2 * m,   m, h - m, w - 2 * m, m,   0, m, m, h - 2 * m }
            : new int[] { -m, -m, m + c, m + c,   w - c, -m, m + c, m + c,   w - c, h - c, m + c, m + c,   -m, h - c, m + c, m + c,
                          c, -m, w - 2 * c, m + 1,   w - 1, c, m + 1, h - 2 * c,   c, h - 1, w - 2 * c, m + 1,   -m, c, m + 1, h - 2 * c };

        // The edge: top, top-right corner, right, bottom-right, bottom, bottom-left, left, top-left; a value every 4 px,
        // or as far apart as the blobs (which grow with the frame) allow, up to 12: the cost follows the frame's size.
        step = Math.Max(4, Math.Min(12, 4 * Math.Min(gx, gy)));
        double sigma = BloomBlur / step;   // three box blurs of 2r + 1 values: a gaussian of variance r (r + 1)
        blurRadius = Math.Max(1, (int)Math.Round((Math.Sqrt(1 + 4 * sigma * sigma) - 1) / 2));
        double lx = Math.Max(0, w - 2 * rc), ly = Math.Max(0, h - 2 * rc);
        nx = (int)Math.Ceiling(lx / step) + 1; ny = (int)Math.Ceiling(ly / step) + 1;
        n = 2 * nx + 2 * ny + 4 * na;
        px = new double[n]; py = new double[n]; nxs = new double[n]; nys = new double[n];
        int s = 0;
        for (int side = 0; side < 4; side++) {
            int count = side % 2 == 0 ? nx : ny;
            for (int k = 0; k < count; k++, s++) {
                double f = count > 1 ? (double)k / (count - 1) : 0.5;
                if (side == 0) { px[s] = rc + lx * f; py[s] = 0; nxs[s] = 0; nys[s] = -1; }
                else if (side == 1) { px[s] = w; py[s] = rc + ly * f; nxs[s] = 1; nys[s] = 0; }
                else if (side == 2) { px[s] = w - rc - lx * f; py[s] = h; nxs[s] = 0; nys[s] = 1; }
                else { px[s] = 0; py[s] = h - rc - ly * f; nxs[s] = -1; nys[s] = 0; }
            }
            // The corner after this side: its centre, and the angle it starts at (y grows downward).
            double cx = side == 0 || side == 1 ? w - rc : rc, cy = side == 0 || side == 3 ? rc : h - rc, a0 = -90 + 90 * side;
            for (int k = 0; k < na; k++, s++) {
                double a = (a0 + 90.0 * k / (na - 1)) * Math.PI / 180;
                nxs[s] = Math.Cos(a); nys[s] = Math.Sin(a); px[s] = cx + rc * nxs[s]; py[s] = cy + rc * nys[s];
            }
        }
        ringP = new int[n]; innerP = new int[n]; bloomP = new int[n];
        br = new double[n]; bg = new double[n]; bb = new double[n]; ba = new double[n]; tmp = new double[n];
        // The bloom's blobs at each point of its box's edge (20 px out), once: they do not move.
        int nb = Bloom.Length / 5;
        bloomV = new float[nb * n];
        for (int j = 0; j < nb; j++) {
            double bcx = -BloomReach + Bloom[5 * j + 3] / 100 * (w + 2 * BloomReach), bcy = -BloomReach + Bloom[5 * j + 4] / 100 * (h + 2 * BloomReach);
            double brx = Bloom[5 * j + 1] * gx, bry = Bloom[5 * j + 2] * gy;
            for (int k = 0; k < n; k++) {
                double dx = (px[k] + BloomReach * nxs[k] - bcx) / brx, dy = (py[k] + BloomReach * nys[k] - bcy) / bry;
                bloomV[j * n + k] = (float)Math.Max(0, 1 - Math.Sqrt(dx * dx + dy * dy));
            }
        }

        for (int k = 0; k < 8; k++) {
            X[k] = r[4 * k]; Y[k] = r[4 * k + 1]; W[k] = Math.Max(0, r[4 * k + 2]); H[k] = Math.Max(0, r[4 * k + 3]);
            Pixels[k] = new int[W[k] * H[k]];
            if (k >= 4) {
                // A side: across it by the middle of its length, along it by its line nearest the frame.
                bool rows = k % 2 == 0;   // the top and the bottom: a row of pixels runs along the edge
                int length = rows ? W[k] : H[k], depth = rows ? H[k] : W[k];
                along[k] = new int[length];
                bloomW[k] = new ushort[depth]; innerW[k] = new ushort[depth]; ringW[k] = new ushort[depth];
                nearFrom[k] = depth; nearTo[k] = -1;
                for (int i = 0; i < depth; i++) {
                    double x = rows ? X[k] + W[k] / 2.0 : X[k] + i + 0.5, y = rows ? Y[k] + i + 0.5 : Y[k] + H[k] / 2.0;
                    Weigh(x, y, w, h, m, inward, out bloomW[k][i], out innerW[k][i], out ringW[k][i]);
                    if ((innerW[k][i] | ringW[k][i]) != 0) { nearFrom[k] = Math.Min(nearFrom[k], i); nearTo[k] = i; }
                }
                below[k] = new int[length]; blend[k] = new ushort[length];
                int first = k == 4 ? 0 : k == 5 ? nx + na : k == 6 ? nx + ny + 2 * na : 2 * nx + ny + 3 * na;
                double spanX = Math.Max(1e-9, w - 2 * rc), spanY = Math.Max(1e-9, h - 2 * rc);
                for (int i = 0; i < length; i++) {
                    double a = rows ? Math.Max(rc, Math.Min(w - rc, X[k] + i + 0.5)) : Math.Max(rc, Math.Min(h - rc, Y[k] + i + 0.5));
                    double pos = k == 4 ? (a - rc) / spanX * (nx - 1) : k == 5 ? (a - rc) / spanY * (ny - 1)
                               : k == 6 ? (w - rc - a) / spanX * (nx - 1) : (h - rc - a) / spanY * (ny - 1);
                    int lo = Math.Min((int)Math.Floor(pos), (k % 2 == 0 ? nx : ny) - 1);
                    double f = pos - lo;
                    below[k][i] = first + lo; blend[k][i] = (ushort)Math.Round(256 * f);
                    along[k][i] = first + lo + (f >= 0.5 ? 1 : 0);
                }
                continue;
            }
            List<int> lit = new List<int>(), where = new List<int>();
            List<ushort> wb = new List<ushort>(), wi = new List<ushort>(), wr = new List<ushort>();
            for (int j = 0; j < H[k]; j++) {
                for (int i = 0; i < W[k]; i++) {
                    double x = X[k] + i + 0.5, y = Y[k] + j + 0.5;
                    ushort vb, vi, vr;
                    Weigh(x, y, w, h, m, inward, out vb, out vi, out vr);
                    if ((vb | vi | vr) == 0) continue;
                    lit.Add(j * W[k] + i); where.Add(Place(x, y)); wb.Add(vb); wi.Add(vi); wr.Add(vr);
                }
            }
            // The pixels the inner glow or the ring reach first: a frame that is not full does only those.
            int[] order = new int[lit.Count];
            int near = 0;
            for (int i = 0; i < lit.Count; i++) if ((wi[i] | wr[i]) != 0) order[near++] = i;
            nearTo[k] = near;
            for (int i = 0; i < lit.Count; i++) if ((wi[i] | wr[i]) == 0) order[near++] = i;
            at[k] = new int[lit.Count]; index[k] = new int[lit.Count];
            bloomW[k] = new ushort[lit.Count]; innerW[k] = new ushort[lit.Count]; ringW[k] = new ushort[lit.Count];
            for (int i = 0; i < lit.Count; i++) {
                int o = order[i];
                at[k][i] = lit[o]; index[k][i] = where[o]; bloomW[k][i] = wb[o]; innerW[k][i] = wi[o]; ringW[k][i] = wr[o];
            }
        }
    }

    // How much of the bloom, the inner glow and the ring (of 256) the pixel at (x, y) takes. Outward: the glow only
    // outside the frame (the frame hides the rest), from boxes 20 and 2 px out, blurred. Inward: the mirror image.
    // Both faded out over the last 16 px of the margin.
    void Weigh(double x, double y, int w, int h, int m, bool inward, out ushort vb, out ushort vi, out ushort vr) {
        double qx = x - w / 2.0, qy = y - h / 2.0;
        double sdf = Sdf(qx, qy, w / 2.0, h / 2.0, rc);
        double ring = Cover(sdf) - Cover(Sdf(qx, qy, w / 2.0 - 1, h / 2.0 - 1, rc - 1));
        double bloom = 0, inner = 0;
        if (inward) {
            double d = -sdf, fade = 1 - Smooth(m - 16, m, d);
            bloom = Phi((BloomReach - d) / BloomBlur) * fade; inner = Phi((InnerReach - d) / InnerBlur) * fade;
        } else if (x < 0 || y < 0 || x > w || y > h) {
            double fade = 1 - Smooth(m - 16, m, Sdf(qx, qy, w / 2.0, h / 2.0, 0));
            bloom = Phi(-Sdf(qx, qy, w / 2.0 + BloomReach, h / 2.0 + BloomReach, BloomRadius) / BloomBlur) * fade;
            inner = Phi(-Sdf(qx, qy, w / 2.0 + InnerReach, h / 2.0 + InnerReach, InnerRadius) / InnerBlur) * fade;
        }
        vb = (ushort)Math.Round(256 * Clamp01(bloom)); vi = (ushort)Math.Round(256 * Clamp01(inner)); vr = (ushort)Math.Round(256 * Clamp01(ring));
    }

    // The value along the edge nearest this point (frame coordinates).
    int Place(double x, double y) {
        double cx = Math.Max(rc, Math.Min(fw - rc, x)), cy = Math.Max(rc, Math.Min(fh - rc, y));
        int top = 0, right = nx + na, bottom = right + ny + na, left = bottom + nx + na;
        if (x != cx && y != cy) {   // off a corner: by its angle
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
        if (x == cx && y == cy) {   // inside the frame (the inward form), off the corners: the nearest side
            double least = Math.Min(Math.Min(y, fh - y), Math.Min(x, fw - x));
            sideOf = least == y ? 0 : least == fw - x ? 1 : least == fh - y ? 2 : 3;
        } else sideOf = y < cy ? 0 : x > cx ? 1 : y > cy ? 2 : 3;
        if (sideOf == 0) return top + (int)Math.Round((cx - rc) / lx * (nx - 1));
        if (sideOf == 1) return right + (int)Math.Round((cy - rc) / ly * (ny - 1));
        if (sideOf == 2) return bottom + (int)Math.Round((fw - rc - cx) / lx * (nx - 1));
        return left + (int)Math.Round((fh - rc - cy) / ly * (ny - 1));
    }

    // hue-rotate(deg) brightness(b) saturate(s), each step clamped as a browser does, on a colour of 0..1.
    static void Filter(double[] rgb, int o, double degrees) {
        double c = Math.Cos(degrees * Math.PI / 180), s = Math.Sin(degrees * Math.PI / 180), t = Saturation;
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

    // The ring's or the inner glow's blobs (on a box `reach` px out) at each point `reach` px out along the edge.
    void EdgeBlobs(int[] into, double reach, double opacity, double[] o, double[] col) {
        int count = Edge.Length / 7;
        double[] cx = new double[count], cy = new double[count], rx = new double[count], ry = new double[count], al = new double[count];
        for (int j = 0; j < count; j++) {
            int reg = (int)Edge[7 * j + 1] - 1;
            cx[j] = -reach + Edge[7 * j + 5] / 100 * (fw + 2 * reach) + o[reg * 4 + 2];
            cy[j] = -reach + Edge[7 * j + 6] / 100 * (fh + 2 * reach) + o[reg * 4 + 3];
            rx[j] = Edge[7 * j + 3] * o[reg * 4] * gx; ry[j] = Edge[7 * j + 4] * o[reg * 4 + 1] * o[12] * gy;
            al[j] = o[13 + (int)Edge[7 * j + 2]];
        }
        for (int j = 0; j < count; j++) { rx[j] = 1 / rx[j]; ry[j] = 1 / ry[j]; }   // from here: 1 / reach
        for (int k = 0; k < n; k++) {
            double x = px[k] + reach * nxs[k], y = py[k] + reach * nys[k], r = 0, g = 0, b = 0, a = 0;
            for (int j = count - 1; j >= 0; j--) {   // the first blob is on top
                double dx = (x - cx[j]) * rx[j], dy = (y - cy[j]) * ry[j];
                if (dx >= 1 || dx <= -1 || dy >= 1 || dy <= -1) continue;
                double d2 = dx * dx + dy * dy;
                if (d2 >= 1) continue;
                double v = (1 - Math.Sqrt(d2)) * al[j], keep = 1 - v;
                int ci = 3 * (int)Edge[7 * j];
                r = col[ci] * v + r * keep; g = col[ci + 1] * v + g * keep; b = col[ci + 2] * v + b * keep; a = v + a * keep;
            }
            into[k] = Pack(r * opacity, g * opacity, b * opacity, a * opacity);
        }
    }

    // A blur along the closed edge: three box blurs (a gaussian of about 22 px).
    void BlurAlong(double[] v) {
        int rad = blurRadius;
        if (n <= 2 * rad + 1) return;
        for (int pass = 0; pass < 3; pass++) {
            double sum = 0;
            for (int k = -rad; k <= rad; k++) sum += v[k < 0 ? k + n : k];
            for (int k = 0, ahead = rad + 1, behind = n - rad; k < n; k++, ahead++, behind++) {
                if (ahead == n) ahead = 0;
                if (behind == n) behind = 0;
                tmp[k] = sum / (2 * rad + 1);
                sum += v[ahead] - v[behind];
            }
            Array.Copy(tmp, v, n);
        }
    }

    static uint Scale(uint c, uint w) {
        return (((c & 0x00FF00FF) * w >> 8) & 0x00FF00FF) | ((((c >> 8) & 0x00FF00FF) * w) & 0xFF00FF00);
    }

    // The colour along the edge for one value: the bloom over the inner glow (both behind the window), the ring over them.
    uint Compose(int e, uint wb, uint wi, uint wr) {
        uint glow = Scale((uint)bloomP[e], wb);
        if (wi != 0) glow += Scale(Scale((uint)innerP[e], wi), 256 - (glow >> 24));
        if (wr != 0) {
            uint ring = Scale((uint)ringP[e], wr);
            glow = ring + Scale(glow, 256 - (ring >> 24));
        }
        return glow;
    }

    // The strips at `seconds`: everything breathing as it is then. `moving` false: the still frame (the start).
    // `full` false: the sides only where the inner glow and the ring are (Dirty says what changed).
    public void Paint(double seconds, bool moving, bool full) {
        // The colours drift in hue by up to 30 degrees either way over 14 s, starting from the palette itself (the
        // library's hueRange; its pulse sizes turn the whole wheel, which would take sunset through blue, the paused
        // colour).
        double t = moving ? seconds : 0, hue = moving ? HueRange * Math.Sin(2 * Math.PI * seconds / HueSeconds) : 0;
        double[] o = new double[17];
        for (int k = 0; k < 17; k++) {
            double a = Osc[4 * k], b = Osc[4 * k + 1], p = (t - Osc[4 * k + 3]) / Osc[4 * k + 2];
            o[k] = a + (b - a) * (1 - Math.Cos(2 * Math.PI * p)) / 2;
        }
        int[] pal = Paused ? Ocean : Sunset;
        double[] col = new double[27];
        for (int k = 0; k < 27; k++) col[k] = pal[k] / 255.0;
        for (int k = 0; k < 9; k++) Filter(col, 3 * k, hue);

        EdgeBlobs(ringP, 0, StrokeOpacity, o, col);
        EdgeBlobs(innerP, InnerReach, InnerOpacity, o, col);
        // The bloom does not breathe: only its colour drifts, so it is worked out again with the full frames.
        int nb = Bloom.Length / 5;
        for (int k = 0; k < n && full; k++) {
            double r = 0, g = 0, b = 0, a = 0;
            for (int j = nb - 1; j >= 0; j--) {
                double v = bloomV[j * n + k];
                if (v <= 0) continue;
                v *= BloomAlpha;
                double keep = 1 - v;
                int ci = 3 * (int)Bloom[5 * j];
                r = col[ci] * v + r * keep; g = col[ci + 1] * v + g * keep; b = col[ci + 2] * v + b * keep; a = v + a * keep;
            }
            br[k] = r * BloomOpacity; bg[k] = g * BloomOpacity; bb[k] = b * BloomOpacity; ba[k] = a * BloomOpacity;
        }
        if (full) {
            BlurAlong(br); BlurAlong(bg); BlurAlong(bb); BlurAlong(ba);
            for (int k = 0; k < n; k++) bloomP[k] = Pack(br[k], bg[k], bb[k], ba[k]);
        }

        for (int k = 0; k < 4; k++) {   // the corners: pixel by pixel
            int[] pix = Pixels[k], where = at[k], idx = index[k];
            ushort[] wb = bloomW[k], wi = innerW[k], wr = ringW[k];
            for (int i = 0, end = full ? where.Length : nearTo[k]; i < end; i++) pix[where[i]] = (int)Compose(idx[i], wb[i], wi[i], wr[i]);
            Dirty[4 * k] = 0; Dirty[4 * k + 1] = 0; Dirty[4 * k + 2] = W[k] - 1; Dirty[4 * k + 3] = H[k] - 1;
        }
        for (int k = 4; k < 8; k++) {   // the sides: a colour per value along the edge, per line across it
            int[] pix = Pixels[k], idx = along[k];
            ushort[] wb = bloomW[k], wi = innerW[k], wr = ringW[k];
            bool rows = k % 2 == 0;
            int length = idx.Length, depth = wb.Length;
            int from = full ? 0 : nearFrom[k], to = full ? depth - 1 : nearTo[k];
            int[] lo = below[k];
            ushort[] mix = blend[k];
            if (rows) {
                for (int j = from; j <= to; j++) {
                    uint b = wb[j], ii = wi[j], rr = wr[j];
                    if ((b | ii | rr) == 0) continue;
                    int row = j * length;
                    if (rr != 0) {   // the ring: blended between the two values either side, so it has no steps
                        int last = -1;
                        uint v0 = 0, v1 = 0;
                        for (int i = 0; i < length; i++) {
                            if (lo[i] != last) { last = lo[i]; v0 = Compose(last, b, ii, rr); v1 = Compose(last + 1 < n ? last + 1 : 0, b, ii, rr); }
                            pix[row + i] = (int)(Scale(v0, 256u - mix[i]) + Scale(v1, mix[i]));
                        }
                        continue;
                    }
                    for (int i = 0; i < length; ) {
                        int e = idx[i], v = (int)Compose(e, b, ii, rr);
                        do pix[row + i++] = v; while (i < length && idx[i] == e);
                    }
                }
                Dirty[4 * k] = 0; Dirty[4 * k + 1] = from; Dirty[4 * k + 2] = length - 1; Dirty[4 * k + 3] = to;
            } else {
                for (int j = 0; j < length && to >= from; ) {
                    int e = idx[j], first = j * depth;
                    for (int i = from; i <= to; i++) pix[first + i] = (int)Compose(e, wb[i], wi[i], wr[i]);
                    for (j++; j < length && idx[j] == e; j++) {   // the rows after it with the same value: copies
                        int row = j * depth;
                        for (int i = from; i <= to; i++) pix[row + i] = pix[first + i];
                    }
                }
                for (int i = from; i <= to; i++) {   // the ring: blended between the two values either side
                    if (wr[i] == 0) continue;
                    int last = -1;
                    uint v0 = 0, v1 = 0;
                    for (int j = 0; j < length; j++) {
                        if (lo[j] != last) { last = lo[j]; v0 = Compose(last, wb[i], wi[i], wr[i]); v1 = Compose(last + 1 < n ? last + 1 : 0, wb[i], wi[i], wr[i]); }
                        pix[j * depth + i] = (int)(Scale(v0, 256u - mix[j]) + Scale(v1, mix[j]));
                    }
                }
                Dirty[4 * k] = from; Dirty[4 * k + 1] = 0; Dirty[4 * k + 2] = to; Dirty[4 * k + 3] = length - 1;
            }
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
        bool inward = desk;
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
            // A maximized or full-screen window has no room outside it: the glow goes inward, on its monitor.
            if (on && GetMonitorInfo(screen, ref info) && (IsZoomed(t)
                || (r.Left <= info.Work.Left && r.Top <= info.Work.Top && r.Right >= info.Work.Right && r.Bottom >= info.Work.Bottom))) {
                inward = true;
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
            string key = (inward ? "in" : "out") + w + "x" + h;
            if (key != layout) {
                layout = key;
                beam.Layout(w, h, inward);
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
    // `all`: every pixel (a new size or place, the first frame); otherwise the bloom's far part, which only changes
    // with the slow hue drift, every fourth frame.
    void Paint(bool all) {
        double now = clock.Elapsed.TotalSeconds;
        double risen = turning ? Math.Max(0, Math.Min(1, (now - shownAt) / Beam.FadeInSeconds)) : 1;
        bool full = all || risen < 1 || ++tick % 4 == 0;
        beam.Paint(now, turning, full);
        byte opacity = (byte)(255 * risen * risen * (3 - 2 * risen));
        int[] d = beam.Dirty;
        for (int k = 0; k < strips.Length; k++)
            if (strips[k].W > 0 && strips[k].H > 0) strips[k].Push(beam.Pixels[k], opacity, d[4 * k], d[4 * k + 1], d[4 * k + 2], d[4 * k + 3]);
    }
    int tick;
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
