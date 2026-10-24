# edge-glow.ps1 — "task in progress" screen-edge glow.
#
# A full-screen, CLICK-THROUGH, never-activating overlay that draws a soft glow
# on all four screen edges and pulses it dim<->bright while clawdcursor is
# driving the desktop. Spawned/killed by src/core/banner.ts in lockstep with the
# control-banner pill (pin() on task start, unpin()/idle to hide) — it runs
# ALONGSIDE the pill, which keeps the double-click-to-stop affordance.
#
# Why a per-pixel-alpha layered window (UpdateLayeredWindow) and not a plain
# WinForms paint + TransparencyKey: a color key can only knock out ONE exact
# color, so a soft inward fade can't be made click-through cleanly. Per-pixel
# alpha gives a real soft glow AND a fully click-through interior in one shot.
#
# Extended window styles (mirrors banner.ps1's zero-focus contract, plus
# click-through — critical: it is up WHILE the agent types/clicks):
#   WS_EX_LAYERED      0x00080000  per-pixel alpha compositing
#   WS_EX_TRANSPARENT  0x00000020  click-through (input falls to the app below)
#   WS_EX_NOACTIVATE   0x08000000  never steals focus (agent keeps typing)
#   WS_EX_TOOLWINDOW   0x00000080  no taskbar / alt-tab entry
#   WS_EX_TOPMOST      0x00000008  stays above normal windows
#
# Defaults are production: amber, persistent (runs until the parent kills it).
# For a manual DEMO, pass -DurationSec so it self-closes, e.g.:
#   powershell -NoProfile -ExecutionPolicy Bypass -File edge-glow.ps1 -DurationSec 12
#
# The Windows drawer; macOS and Linux use scripts/mac/overlay.swift and
# scripts/linux/overlay.py with the same arguments.
# Covers every display (one layered window each), not just the primary.

param(
    [string]$Color       = '#f59e0b',  # glow color (amber — "in progress")
    [int]   $Thickness   = 80,         # px depth the glow fades in from each edge
    [int]   $PeriodMs    = 1600,       # full dim->bright->dim cycle
    [int]   $MinAlpha    = 60,         # dim floor (0-255); lower = dims more
    [int]   $PeakAlpha   = 200,        # per-pixel alpha at the very edge (0-255)
    [int]   $DurationSec = 0           # 0 = run until killed; >0 = self-close (demo)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class GlowOverlay : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
    // For the person at the screen only: WDA_EXCLUDEFROMCAPTURE (0x11) keeps the glow out of screenshots and OCR
    // (Windows 10 2004+; older Windows ignores it).
    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        try { SetWindowDisplayAffinity(Handle, 0x11); } catch { }
    }
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

    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")]  static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll")]  static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")]  static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
    [DllImport("gdi32.dll")]  static extern bool DeleteObject(IntPtr ho);
    [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(
        IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
        IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x,int y){X=x;Y=y;} }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE  { public int cx, cy; public SIZE(int x,int y){cx=x;cy=y;} }
    [StructLayout(LayoutKind.Sequential, Pack=1)] public struct BLENDFUNCTION {
        public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat;
    }

    IntPtr screenDc, memDc, hBitmap, oldBitmap;
    Bitmap bmp;

    public void SetBitmap(Bitmap b) {
        bmp = b;
        screenDc  = GetDC(IntPtr.Zero);
        memDc     = CreateCompatibleDC(screenDc);
        hBitmap   = b.GetHbitmap(Color.FromArgb(0)); // ARGB DIB for ULW
        oldBitmap = SelectObject(memDc, hBitmap);
    }

    // Re-push the same bitmap with a new global alpha → smooth pulse.
    public void Push(byte alpha) {
        if (bmp == null) return;
        SIZE size = new SIZE(bmp.Width, bmp.Height);
        POINT src = new POINT(0, 0);
        POINT dst = new POINT(this.Left, this.Top);
        BLENDFUNCTION blend = new BLENDFUNCTION();
        blend.BlendOp = 0;              // AC_SRC_OVER
        blend.BlendFlags = 0;
        blend.SourceConstantAlpha = alpha;
        blend.AlphaFormat = 1;          // AC_SRC_ALPHA
        UpdateLayeredWindow(this.Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref blend, 2); // ULW_ALPHA
    }

    public void Cleanup() {
        if (memDc    != IntPtr.Zero) SelectObject(memDc, oldBitmap);
        if (hBitmap  != IntPtr.Zero) { DeleteObject(hBitmap); hBitmap = IntPtr.Zero; }
        if (memDc    != IntPtr.Zero) { DeleteDC(memDc); memDc = IntPtr.Zero; }
        if (screenDc != IntPtr.Zero) { ReleaseDC(IntPtr.Zero, screenDc); screenDc = IntPtr.Zero; }
    }
}
'@

# ── Parse color ──
$hex = $Color.TrimStart('#')
$cr  = [Convert]::ToInt32($hex.Substring(0,2),16)
$cg  = [Convert]::ToInt32($hex.Substring(2,2),16)
$cb  = [Convert]::ToInt32($hex.Substring(4,2),16)

# ── One glow window per display (every monitor shows the same state) ──
$edgeTpl = [System.Drawing.Color]::FromArgb($PeakAlpha, $cr, $cg, $cb)
$fadeTpl = [System.Drawing.Color]::FromArgb(0,           $cr, $cg, $cb)
$P       = [System.Drawing.Point]
function New-Band($g, $p1, $p2, $colorAt1, $colorAt2, $rect) {
    $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush($p1, $p2, $colorAt1, $colorAt2)
    $br.WrapMode = [System.Drawing.Drawing2D.WrapMode]::TileFlipXY
    $g.FillRectangle($br, $rect)
    $br.Dispose()
}

$forms = @()
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $scr = $screen.Bounds
    $W   = $scr.Width
    $H   = $scr.Height
    $T   = [Math]::Min($Thickness, [Math]::Min([int]($W/2), [int]($H/2)))

    # Render the edge glow into an ARGB bitmap once.
    $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::FromArgb(0,0,0,0))
    # Corners deliberately overlap (additive glow pooling).
    New-Band $g (New-Object $P 0,0)        (New-Object $P 0,$T)        $edgeTpl $fadeTpl (New-Object Drawing.Rectangle 0,0,$W,$T)          # top
    New-Band $g (New-Object $P 0,($H-$T))  (New-Object $P 0,$H)        $fadeTpl $edgeTpl (New-Object Drawing.Rectangle 0,($H-$T),$W,$T)    # bottom
    New-Band $g (New-Object $P 0,0)        (New-Object $P $T,0)        $edgeTpl $fadeTpl (New-Object Drawing.Rectangle 0,0,$T,$H)          # left
    New-Band $g (New-Object $P ($W-$T),0)  (New-Object $P $W,0)        $fadeTpl $edgeTpl (New-Object Drawing.Rectangle ($W-$T),0,$T,$H)    # right
    $g.Dispose()

    $f = New-Object GlowOverlay
    $f.FormBorderStyle = 'None'
    $f.ShowInTaskbar   = $false
    $f.TopMost         = $true
    $f.StartPosition   = 'Manual'
    $f.Bounds          = $scr
    $f.Tag             = $bmp
    $f.Add_Shown({ param($sender, $e) $sender.SetBitmap([System.Drawing.Bitmap]$sender.Tag); $sender.Push([byte]$MinAlpha) })
    $forms += $f
}
$form = $forms[0]
foreach ($f in $forms) { if ($f -ne $form) { $f.Show() } }

$startTicks = [Environment]::TickCount

# Pulse: cosine ease between MinAlpha and 255 (smooth dim<->bright).
$pulse = New-Object System.Windows.Forms.Timer
$pulse.Interval = 30
$pulse.Add_Tick({
    $elapsed = [Environment]::TickCount - $startTicks
    if ($DurationSec -gt 0 -and $elapsed -ge ($DurationSec * 1000)) {
        $pulse.Stop()
        foreach ($f in $forms) { $f.Cleanup() }
        $form.Close()
        return
    }
    $phase = ($elapsed % $PeriodMs) / [double]$PeriodMs
    $wave  = (1 - [Math]::Cos($phase * 2 * [Math]::PI)) / 2     # 0->1->0
    $alpha = [int]($MinAlpha + ($wave * (255 - $MinAlpha)))
    if ($alpha -lt 0) { $alpha = 0 } elseif ($alpha -gt 255) { $alpha = 255 }
    foreach ($f in $forms) { $f.Push([byte]$alpha) }
})
$pulse.Start()

[System.Windows.Forms.Application]::Run($form)
foreach ($f in $forms) { ([System.Drawing.Bitmap]$f.Tag).Dispose() }
