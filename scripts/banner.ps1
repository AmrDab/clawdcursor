# banner.ps1 — "ClawdCursor — desktop control in progress" indicator.
#
# A small, always-on-top, borderless pill at the top-center of the monitor the
# agent is working on: a small dotted orb, what the agent is doing ("Typing in Edge"), the
# time since it appeared, and a Stop button. Shown by the daemon while an
# agent is actively driving the desktop, so a human at the machine ALWAYS
# knows automation is live (transparency requirement — same spirit as the
# labeled agent browser window).
#
# Interaction contract with the parent (src/core/banner.ts):
#   - Parent spawns:  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File banner.ps1
#   - Stop, or a DOUBLE-CLICK anywhere on the banner → prints "BANNER_STOP" on
#     stdout and exits; the parent reacts by running the `clawdcursor stop` flow
#     (abort in-flight task + graceful daemon shutdown).
#   - Parent kills this process to hide the banner.
#   - stdin: "HIDE <ms>" steps aside for an agent's click; "ACTIVITY <text>" replaces
#     the activity text (the first one comes in CLAWD_BANNER_ACTIVITY).
#   - PAUSED mode (env CLAWD_BANNER_MODE=paused, set by src/core/pause-gate.ts
#     via banner.ts): the agent handed the desktop to the user. A card with a blue
#     outline, "Waiting for you" (· the app from CLAWD_BANNER_APP), the
#     instruction from CLAWD_BANNER_MESSAGE, and three buttons: Resume
#     (BANNER_RESUME) / Something else / End task (BANNER_END). The click prints
#     that line on stdout and exits. "Something else" opens a text box (the pill
#     takes the keyboard only then, on the user's click); Enter / Send prints
#     BANNER_REPLY <base64 of the UTF-8 text> and exits. No double-click stop here. A short system sound plays
#     when it appears (off with CLAWD_PAUSE_SOUND=0).
#     The card: CLAWD_BANNER_CHOICES (JSON array of 2-6 strings) adds one button per option, printing
#     BANNER_CHOICE <index> (only the index; the parent maps it to the text). CLAWD_BANNER_INPUT (JSON
#     {placeholder, multiline}) puts a text box on the card (Send / Enter sends as BANNER_REPLY, "Something else"
#     is then not needed). Both unset = the plain prompt above.
#
# CRITICAL: the window must NEVER steal focus — it appears WHILE the agent is
# typing/clicking, and an activating window would redirect those keystrokes
# (the exact focus-theft bug class fixed in v1.5.1). WS_EX_NOACTIVATE +
# ShowWithoutActivation make it a zero-focus overlay; clicks still reach it.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class NoActivateBannerForm : Form {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    // Back to the top of the always-on-top windows, without taking focus: the beam around a maximized window or a
    // monitor reaches under the pill, and is raised over it whenever it is placed (window-outline.ps1).
    // HWND_TOPMOST (-1); SWP_NOSIZE 0x01 | SWP_NOMOVE 0x02 | SWP_NOACTIVATE 0x10.
    public void Raise() { if (Visible) SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0013); }
    // The pill is for the person at the screen, never part of what the agent sees: WDA_EXCLUDEFROMCAPTURE (0x11) leaves
    // it out of every screenshot and OCR capture (Windows 10 2004+; older Windows ignores it). It sat over the app's own
    // toolbar in captures and hid it.
    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        try { SetWindowDisplayAffinity(Handle, 0x11); } catch { }
    }
    // Set while the user types an answer ("Something else"): the pill may then take the keyboard.
    public bool AllowActivate = false;
    // A click must not activate the pill either: answer WM_MOUSEACTIVATE with
    // MA_NOACTIVATE (the click is still delivered).
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0021 && !AllowActivate) { m.Result = (IntPtr)3; return; } // WM_MOUSEACTIVATE -> MA_NOACTIVATE
        base.WndProc(ref m);
    }
    // stdin carries "HIDE <ms>" from the parent just before an agent's click: the pill steps aside so the click reaches
    // the app under it (it sits where browsers keep their tab strip and address bar), then comes back on its own.
    // ...and "ACTIVITY <text>": what the agent is doing now ("Typing in Edge"), raised on the UI thread.
    public event Action<string> ActivityChanged;
    System.Windows.Forms.Timer reshow;
    public void StartStdinCommands() {
        var t = new System.Threading.Thread(() => {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    line = line.Trim();
                    int ms;
                    if (line.StartsWith("HIDE ") && int.TryParse(line.Substring(5), out ms)) {
                        try { BeginInvoke((Action)(() => HideFor(ms))); } catch { }
                    } else if (line.StartsWith("ACTIVITY ") && ActivityChanged != null) {
                        string text = line.Substring(9);
                        try { BeginInvoke((Action)(() => ActivityChanged(text))); } catch { }
                    }
                }
                Environment.Exit(0);   // stdin closed: the parent is gone, and a pill must not outlive it
            } catch { }
        });
        t.IsBackground = true;
        t.Start();
    }
    public void HideFor(int ms) {
        if (reshow == null) {
            reshow = new System.Windows.Forms.Timer();
            reshow.Tick += (s, e) => { reshow.Stop(); if (!IsDisposed) Show(); };
        }
        reshow.Stop();
        Hide();
        reshow.Interval = Math.Max(50, Math.Min(ms, 10000));
        reshow.Start();
    }
    // The user chose to type: drop WS_EX_NOACTIVATE and take the keyboard. Only ever on the user's own click.
    public void TakeKeyboard() {
        AllowActivate = true;
        int ex = GetWindowLong(Handle, -20);           // GWL_EXSTYLE
        SetWindowLong(Handle, -20, ex & ~0x08000000);  // clear WS_EX_NOACTIVATE
        SetForegroundWindow(Handle);
        Activate();
    }
    // Never take focus when shown…
    protected override bool ShowWithoutActivation { get { return true; } }
    // …or when clicked. WS_EX_NOACTIVATE (0x08000000) + WS_EX_TOPMOST (0x8).
    protected override CreateParams CreateParams {
        get {
            CreateParams p = base.CreateParams;
            p.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            p.ExStyle |= 0x00000008; // WS_EX_TOPMOST
            return p;
        }
    }
}

// The running pill's orb (#392), in place of the blinking dot. A PORT of Thinking Orbs by Jakub Antalik
// (libraries.dev, github.com/Jakubantalik/Libraries.dev, packages/thinking-orbs, MIT License, Copyright (c) 2026 Jakub
// Antalik; the notice is in full at the top of scripts/window-outline.ps1): its default state, "working", at its
// 20 px size - particles running on tilted orbits around a slowly turning dotted sphere, in light ink on the dark pill.
// The numbers are the library's (spec/orbs-spec.json, src/engine/orbits.ts and core.ts):
//   orbits   3 (12 x the 20 px preset's count .238), each a tilted circle of radius R(.45 + .52 h1), R = .82 x 10 px,
//            its plane and speed (.25 + .55 h3, either way) from hashD(orbit, 1.7 / 5.2 / 8.9)
//   ghosts   10 dots along each orbit (40 x .238), radius .9 x 2.4, ink .72, alpha .5 (.4 + .6 depth)
//   workers  3 particles on each, radius (1.2 + 1.6 depth) x 2.4, ink .3 - .22 depth
//   radii    x (20 / 300)^.6, never under .3 px; drawn far to near; ink is grey 255 (1 - ink) on a dark ground
//   clock    t = seconds x 3.9 (the preset's speed); the sphere turns .12 t, tilted .3
//   still    with animations off (SPI_GETCLIENTAREAANIMATION): the one frame at t = .6
// This control only is drawn again, about 30 times a second.
public class Orb : Control {
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, out bool value, uint flags);
    const int Box = 20, Orbits = 3, Ghosts = 10, Workers = 3;
    const double Speed = 3.9, Sized = 2.4;
    readonly System.Diagnostics.Stopwatch clock = new System.Diagnostics.Stopwatch();
    readonly int[] canvas = new int[Box * Box];
    readonly System.Drawing.Bitmap picture = new System.Drawing.Bitmap(Box, Box, System.Drawing.Imaging.PixelFormat.Format32bppRgb);
    readonly double[] dots = new double[Orbits * (Ghosts + Workers) * 6];   // x, y, z, radius, ink, alpha
    readonly int[] order = new int[Orbits * (Ghosts + Workers)];
    System.Windows.Forms.Timer tick;
    public Orb() {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Size = new System.Drawing.Size(Box, Box);
        bool animate;
        if (SystemParametersInfo(0x1042, 0, out animate, 0) && !animate) return;
        clock.Start();
        tick = new System.Windows.Forms.Timer();
        tick.Interval = 33;
        tick.Tick += (s, e) => Invalidate();
        tick.Start();
    }
    // Deterministic hash in [0, 1) (core.ts hashD).
    static double Hash(double a, double b) { double h = Math.Sin(a * 12.9898 + b * 78.233) * 43758.5453; return h - Math.Floor(h); }
    protected override void OnPaint(PaintEventArgs e) {
        double t = tick == null ? 0.6 : clock.Elapsed.TotalSeconds * Speed;
        double centre = Box / 2.0, R = centre * 0.82, scale = Math.Pow(Box / 300.0, 0.6);
        // The shared spin and tilt (core.ts makeProj).
        double yaw = t * 0.12, st = Math.Sin(0.3), ct = Math.Cos(0.3), sy = Math.Sin(yaw), cy = Math.Cos(yaw);
        int n = 0;
        for (int orbit = 0; orbit < Orbits; orbit++) {
            double h1 = Hash(orbit, 1.7), h2 = Hash(orbit, 5.2), h3 = Hash(orbit, 8.9);
            double ro = R * (0.45 + 0.52 * h1), th = h1 * 2 * Math.PI, phi = Math.Acos(2 * h2 - 1);
            // The orbit's plane: u and v at right angles to its normal.
            double nx = Math.Sin(phi) * Math.Cos(th), ny = Math.Cos(phi), nz = Math.Sin(phi) * Math.Sin(th);
            double ux = -ny, uy = nx, ul = Math.Max(1e-6, Math.Sqrt(ux * ux + uy * uy));
            ux /= ul; uy /= ul;
            double vx = -nz * uy, vy = nz * ux, vz = nx * uy - ny * ux;
            double speed = (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1);
            for (int k = 0; k < Ghosts + Workers; k++, n++) {
                bool ghost = k < Ghosts;
                double a = ghost ? k * 2 * Math.PI / Ghosts : t * speed + (k - Ghosts) * 2 * Math.PI / Workers + h2 * 6;
                double x = (ux * Math.Cos(a) + vx * Math.Sin(a)) * ro, y = (uy * Math.Cos(a) + vy * Math.Sin(a)) * ro, z = vz * Math.Sin(a) * ro;
                double x1 = x * cy + z * sy, z1 = -x * sy + z * cy, y1 = y * ct - z1 * st, z2 = y * st + z1 * ct;
                double depth = (z2 / ro + 1) / 2;
                dots[6 * n] = centre + x1; dots[6 * n + 1] = centre - y1; dots[6 * n + 2] = z2;
                dots[6 * n + 3] = Math.Max(0.3, (ghost ? 0.9 * Sized : (1.2 + 1.6 * depth) * Sized) * scale);
                dots[6 * n + 4] = ghost ? 0.72 : 0.3 - 0.22 * depth;
                dots[6 * n + 5] = ghost ? 0.5 * (0.4 + 0.6 * depth) : 1;
                // Far to near: into its place among the dots so far.
                int at = n;
                for (; at > 0 && dots[6 * order[at - 1] + 2] > z2; at--) order[at] = order[at - 1];
                order[at] = n;
            }
        }
        // The dots, far to near, over the pill's colour: each pixel by how much of it the dot covers (drawn here, on
        // 400 pixels, and put on screen in one piece - forty anti-aliased GDI+ ellipses a frame cost far more).
        int back = BackColor.ToArgb();
        for (int i = 0; i < canvas.Length; i++) canvas[i] = back;
        foreach (int d in order) {
            double dx = dots[6 * d], dy = dots[6 * d + 1], r = dots[6 * d + 3];
            double alpha = dots[6 * d + 5] * Math.Min(1, Math.PI * r * r);   // a dot smaller than a pixel covers that much of it
            int grey = (int)Math.Round((1 - Math.Min(1, Math.Max(0, dots[6 * d + 4]))) * 255);
            for (int py = Math.Max(0, (int)(dy - r - 1)); py <= Math.Min(Box - 1, (int)(dy + r + 1)); py++) {
                for (int px = Math.Max(0, (int)(dx - r - 1)); px <= Math.Min(Box - 1, (int)(dx + r + 1)); px++) {
                    double ex = px + 0.5 - dx, ey = py + 0.5 - dy, cover = r + 0.5 - Math.Sqrt(ex * ex + ey * ey);
                    if (cover <= 0) continue;
                    int a = (int)(256 * alpha * Math.Min(1, cover)), c = canvas[py * Box + px];
                    int cr = (c >> 16) & 255, cg = (c >> 8) & 255, cb = c & 255;
                    canvas[py * Box + px] = ((cr + ((grey - cr) * a >> 8)) << 16) | ((cg + ((grey - cg) * a >> 8)) << 8) | (cb + ((grey - cb) * a >> 8));
                }
            }
        }
        System.Drawing.Imaging.BitmapData bits = picture.LockBits(new System.Drawing.Rectangle(0, 0, Box, Box),
            System.Drawing.Imaging.ImageLockMode.WriteOnly, System.Drawing.Imaging.PixelFormat.Format32bppRgb);
        Marshal.Copy(canvas, 0, bits.Scan0, canvas.Length);
        picture.UnlockBits(bits);
        e.Graphics.DrawImageUnscaled(picture, 0, 0);
    }
}
'@

$form = New-Object NoActivateBannerForm
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar   = $false
$form.TopMost         = $true
$form.StartPosition   = 'Manual'
$form.BackColor       = [System.Drawing.Color]::FromArgb(22, 24, 29)
$form.Size            = New-Object System.Drawing.Size(430, 40)

$blue   = [System.Drawing.Color]::FromArgb(59, 130, 246)
$muted  = [System.Drawing.Color]::FromArgb(140, 146, 158)
$script:edge = [System.Drawing.Color]::FromArgb(58, 62, 72)   # the 1px outline; blue on the paused card

function New-RoundPath([int]$w, [int]$h, [int]$r) {
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddArc(0, 0, $r*2, $r*2, 180, 90)
    $gp.AddArc($w - $r*2, 0, $r*2, $r*2, 270, 90)
    $gp.AddArc($w - $r*2, $h - $r*2, $r*2, $r*2, 0, 90)
    $gp.AddArc(0, $h - $r*2, $r*2, $r*2, 90, 90)
    $gp.CloseFigure()
    return $gp
}
function Set-Round($c, [int]$r) { $c.Region = New-Object System.Drawing.Region((New-RoundPath $c.Width $c.Height $r)) }

# Top-center of the monitor the foreground window is on (where the agent is working; the primary when there is
# none), 8px below the edge; rounded corners and a thin outline.
$script:radius = 18
function Set-PillShape($f, [int]$r) {
    $script:radius = $r
    $fg = [NoActivateBannerForm]::GetForegroundWindow()
    $screen = if ($fg -ne [IntPtr]::Zero) { [System.Windows.Forms.Screen]::FromHandle($fg).WorkingArea }
              else { [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea }
    $f.Location = New-Object System.Drawing.Point(
        [int]($screen.X + ($screen.Width - $f.Width) / 2), [int]($screen.Y + 8))
    Set-Round $f $r
    $f.Invalidate()
}
$form.Add_Paint({
    param($s, $e)
    $e.Graphics.SmoothingMode = 'AntiAlias'
    $pen = New-Object System.Drawing.Pen($script:edge, 1)
    $e.Graphics.DrawPath($pen, (New-RoundPath ($form.Width - 1) ($form.Height - 1) $script:radius))
    $pen.Dispose()
})

# The window the user was in when they pressed a button — focus goes back
# there after the click (Resume must not leave the desktop with no active window).
$script:userWindow = [IntPtr]::Zero
function Send-Line([string]$line) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
    $form.Hide()
    if ($script:userWindow -ne [IntPtr]::Zero -and $script:userWindow -ne $form.Handle -and
        [NoActivateBannerForm]::GetForegroundWindow() -ne $script:userWindow) {
        [void][NoActivateBannerForm]::SetForegroundWindow($script:userWindow)
    }
    $form.Close()
}

# ── PAUSED: the user's turn ──────────────────────────────────────────────────
if ($env:CLAWD_BANNER_MODE -eq 'paused') {
    $script:hoverBase = @{}
    $form.Width = 460
    $script:edge = $blue
    $pad = 18

    $dot = New-Object System.Windows.Forms.Label
    $dot.Text      = [char]0x25CF
    $dot.Font      = New-Object System.Drawing.Font('Segoe UI', 9)
    $dot.ForeColor = $blue
    $dot.BackColor = [System.Drawing.Color]::Transparent
    $dot.AutoSize  = $true
    $dot.Location  = New-Object System.Drawing.Point(($pad - 3), 12)

    $title = New-Object System.Windows.Forms.Label
    $sep = ' ' + [char]0x00B7 + ' '   # a middle dot; non-ASCII stays out of the file (PowerShell 5.1 reads it as ANSI)
    $title.Text      = 'ClawdCursor' + $sep + 'waiting for you'
    if ($env:CLAWD_BANNER_APP) { $title.Text += $sep + $env:CLAWD_BANNER_APP }
    $title.UseMnemonic = $false
    $title.Font      = New-Object System.Drawing.Font('Segoe UI Semibold', 9)
    $title.ForeColor = [System.Drawing.Color]::FromArgb(147, 180, 245)
    $title.BackColor = [System.Drawing.Color]::Transparent
    $title.AutoSize  = $true
    $title.Location  = New-Object System.Drawing.Point(($pad + 12), 13)

    $msg = New-Object System.Windows.Forms.Label
    $msg.Text        = [string]$env:CLAWD_BANNER_MESSAGE
    $msg.UseMnemonic = $false
    $msg.Font        = New-Object System.Drawing.Font('Segoe UI', 10.5)
    $msg.ForeColor   = [System.Drawing.Color]::FromArgb(232, 234, 237)
    $msg.BackColor   = [System.Drawing.Color]::Transparent
    $msg.AutoSize    = $true
    $msg.MaximumSize = New-Object System.Drawing.Size(($form.Width - 2 * $pad), 0)
    $msg.Location    = New-Object System.Drawing.Point($pad, 38)
    $msgH = $msg.GetPreferredSize((New-Object System.Drawing.Size(($form.Width - 2 * $pad), 0))).Height

    # Labels styled as buttons: a real Button takes focus on click, and this
    # window must never pull focus from the field the user is typing in.
    function New-PillButton([string]$text, [string]$line, [int]$x, [int]$y, $bg) {
        $b = New-Object System.Windows.Forms.Label
        $b.Text      = $text
        $b.UseMnemonic = $false
        $b.Font      = New-Object System.Drawing.Font('Segoe UI Semibold', 9.5)
        $b.ForeColor = [System.Drawing.Color]::White
        $b.BackColor = $bg
        $b.TextAlign = 'MiddleCenter'
        $b.Size      = New-Object System.Drawing.Size(110, 30)
        $b.Location  = New-Object System.Drawing.Point($x, $y)
        $b.Cursor    = [System.Windows.Forms.Cursors]::Hand
        $b.Tag       = $line
        # Rounded once sized (a later Size change re-rounds); a lighter shade under the pointer.
        $b.Add_SizeChanged({ param($s, $e) Set-Round $s 8 })
        $b.Add_MouseEnter({ param($s, $e) $script:hoverBase[$s] = $s.BackColor; $s.BackColor = [System.Windows.Forms.ControlPaint]::Light($s.BackColor, 0.15) })
        $b.Add_MouseLeave({ param($s, $e) if ($script:hoverBase.ContainsKey($s)) { $s.BackColor = $script:hoverBase[$s]; $script:hoverBase.Remove($s) } })
        Set-Round $b 8
        $b.Add_MouseDown({
            # The user's own window — never the pill itself (it is foreground once the user typed an answer).
            $fg = [NoActivateBannerForm]::GetForegroundWindow()
            if ($fg -ne $form.Handle) { $script:userWindow = $fg }
        })
        if ($line) { $b.Add_Click({ param($sender, $e) Send-Line ([string]$sender.Tag) }) }
        return $b
    }
    $gray = [System.Drawing.Color]::FromArgb(44, 48, 57)
    $dim  = $muted

    # The card (set by pause_for_user): CLAWD_BANNER_CHOICES = JSON array of strings -> one button each, printing
    # BANNER_CHOICE <index>; CLAWD_BANNER_INPUT = JSON {placeholder, multiline} -> a text box (sent as BANNER_REPLY).
    # Neither set = the plain prompt. They sit above the usual Resume / End task row.
    $choices = New-Object System.Collections.ArrayList
    if ($env:CLAWD_BANNER_CHOICES) {
        try { foreach ($c in ($env:CLAWD_BANNER_CHOICES | ConvertFrom-Json)) { if (($c -is [string]) -and $c.Length -gt 0 -and $choices.Count -lt 6) { [void]$choices.Add($c) } } } catch { }
    }
    $inputCfg = $null
    if ($env:CLAWD_BANNER_INPUT) {
        try { $inputCfg = $env:CLAWD_BANNER_INPUT | ConvertFrom-Json } catch { $inputCfg = $null }
    }
    $hasInput = $inputCfg -is [System.Management.Automation.PSCustomObject]
    $multi    = $hasInput -and ($inputCfg.multiline -eq $true)
    $extra    = New-Object System.Collections.ArrayList   # card controls, added to the form below

    $y = 38 + $msgH + 14
    for ($i = 0; $i -lt $choices.Count; $i++) {
        # One row per option, the full width of the card, read like a list.
        $cb = New-PillButton ([string]$choices[$i]) ('BANNER_CHOICE ' + $i) $pad $y ([System.Drawing.Color]::FromArgb(34, 38, 46))
        $cb.Font      = New-Object System.Drawing.Font('Segoe UI', 10)
        $cb.TextAlign = 'MiddleLeft'
        $cb.Padding   = New-Object System.Windows.Forms.Padding(10, 0, 10, 0)
        $cb.AutoEllipsis = $true
        $cb.Size      = New-Object System.Drawing.Size(($form.Width - 2 * $pad), 34)
        [void]$extra.Add($cb)
        $y += 40
    }
    if ($choices.Count -gt 0) { $y += 6 }

    # The text box. With `input` it is on the card from the start (a click into it takes the keyboard); without, it is
    # "Something else": the buttons give way to the box + Send. Sent as BANNER_REPLY <base64 UTF-8> (one line, whatever
    # was typed).
    $reply = New-Object System.Windows.Forms.TextBox
    $reply.Font        = New-Object System.Drawing.Font('Segoe UI', 10)
    $reply.BackColor   = [System.Drawing.Color]::FromArgb(34, 38, 46)
    $reply.ForeColor   = [System.Drawing.Color]::White
    $reply.BorderStyle = 'FixedSingle'
    $reply.Visible     = $false
    $send = New-PillButton 'Send' '' ($form.Width - $pad - 76) 0 $blue
    $send.Size    = New-Object System.Drawing.Size(76, 30)
    $send.Visible = $false
    if ($hasInput) {
        $ph = [string]$inputCfg.placeholder
        if ($ph) {
            $hint = New-Object System.Windows.Forms.Label
            $hint.Text = $ph; $hint.UseMnemonic = $false
            $hint.Font = New-Object System.Drawing.Font('Segoe UI', 9); $hint.ForeColor = $dim
            $hint.BackColor = [System.Drawing.Color]::Transparent
            $hint.AutoSize = $false; $hint.AutoEllipsis = $true
            $hint.Size = New-Object System.Drawing.Size(($form.Width - 2 * $pad), 16)
            $hint.Location = New-Object System.Drawing.Point($pad, $y)
            [void]$extra.Add($hint)
            $y += 20
        }
        $boxH = 26
        if ($multi) { $boxH = 66; $reply.Multiline = $true; $reply.AcceptsReturn = $true; $reply.ScrollBars = 'Vertical' }
        $reply.Location = New-Object System.Drawing.Point($pad, $y)
        $reply.Size     = New-Object System.Drawing.Size(($form.Width - 2 * $pad - 84), $boxH)
        $reply.Visible  = $true
        $send.Location  = New-Object System.Drawing.Point(($form.Width - $pad - 76), $y)
        $send.Visible   = $true
        $y += [Math]::Max($boxH, 30) + 2
        $warn = New-Object System.Windows.Forms.Label
        $warn.Text = 'Don''t type passwords here'
        $warn.Font = New-Object System.Drawing.Font('Segoe UI', 9); $warn.ForeColor = $dim
        $warn.BackColor = [System.Drawing.Color]::Transparent
        $warn.AutoSize = $false
        $warn.Size = New-Object System.Drawing.Size(($form.Width - 2 * $pad), 16)
        $warn.Location = New-Object System.Drawing.Point($pad, $y)
        [void]$extra.Add($warn)
        $y += 26
    }

    # The row: "Something else..." on the left; End task and Resume on the right (Resume is the main button unless
    # the choices are the answer).
    $btnY = $y
    $resumeColor = $blue
    if ($choices.Count -gt 0) { $resumeColor = $gray }
    $yes = New-PillButton 'Resume' 'BANNER_RESUME' ($form.Width - $pad - 96) $btnY $resumeColor
    $yes.Size = New-Object System.Drawing.Size(96, 30)
    $no  = New-PillButton 'End task' 'BANNER_END' ($form.Width - $pad - 96 - 8 - 96) $btnY $gray
    $no.Size = New-Object System.Drawing.Size(96, 30)
    $no.ForeColor = [System.Drawing.Color]::FromArgb(248, 113, 113)
    if ($hasInput) {
        $other = $null   # the box is already there
    } else {
        $other = New-PillButton ('Something else' + [char]0x2026) '' $pad $btnY $gray
        $other.Size = New-Object System.Drawing.Size(132, 30)
        $other.ForeColor = [System.Drawing.Color]::FromArgb(147, 180, 245)
        $reply.Location = New-Object System.Drawing.Point($pad, ($btnY + 3))
        $reply.Size     = New-Object System.Drawing.Size(($form.Width - 2 * $pad - 84), 26)
        $send.Location  = New-Object System.Drawing.Point(($form.Width - $pad - 76), $btnY)
    }

    function Send-Reply {
        $t = $reply.Text.Trim()
        if ($t.Length -eq 0) { return }
        Send-Line ('BANNER_REPLY ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($t)))
    }
    function Show-ReplyBox([bool]$on) {
        foreach ($b in @($yes, $other, $no)) { if ($b) { $b.Visible = -not $on } }
        $reply.Visible = $on; $send.Visible = $on
        if ($on) { $form.TakeKeyboard(); [void]$reply.Focus() }
        elseif ($script:userWindow -ne [IntPtr]::Zero) { [void][NoActivateBannerForm]::SetForegroundWindow($script:userWindow) }
    }
    if ($other) { $other.Add_Click({ Show-ReplyBox $true }) }
    $send.Add_Click({ Send-Reply })
    if ($hasInput) {
        # The pill never takes the keyboard on its own: only the user's click into the box does.
        $reply.Add_MouseDown({
            $fg = [NoActivateBannerForm]::GetForegroundWindow()
            if ($fg -ne $form.Handle) { $script:userWindow = $fg }
            if (-not $form.AllowActivate) { $form.TakeKeyboard() }
            [void]$reply.Focus()
        })
    }
    $reply.Add_KeyDown({
        param($s, $e)
        if ($e.KeyCode -eq 'Return') {
            # A longer answer: Enter adds a line, Ctrl+Enter (or Send) sends.
            if (-not $multi -or $e.Control) { $e.SuppressKeyPress = $true; Send-Reply }
        }
        elseif ($e.KeyCode -eq 'Escape') {
            $e.SuppressKeyPress = $true
            if ($hasInput) {
                # The box stays (with what was typed); the keyboard goes back to the user's window.
                if ($script:userWindow -ne [IntPtr]::Zero) { [void][NoActivateBannerForm]::SetForegroundWindow($script:userWindow) }
            } else { $reply.Text = ''; Show-ReplyBox $false }
        }
    })

    $form.Height = $btnY + 30 + 16
    foreach ($ctl in @($dot, $title, $msg) + @($extra) + @($yes, $other, $no, $reply, $send)) { if ($ctl) { $form.Controls.Add($ctl) } }
    Set-PillShape $form 14

    # Slow blue pulse on the dot — calmer than the red "recording" blink.
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 900
    $bright = $true
    $timer.Add_Tick({
        $script:bright = -not $script:bright
        if ($script:bright) { $dot.ForeColor = $blue }
        else                { $dot.ForeColor = [System.Drawing.Color]::FromArgb(25, 55, 110) }
        $form.Raise()
    })
    $timer.Start()

    # A short system sound when the prompt appears, so a user who isn't looking
    # hears it's their turn (#237). CLAWD_PAUSE_SOUND=0 turns it off.
    if ($env:CLAWD_PAUSE_SOUND -ne '0') {
        $form.Add_Shown({ try { [System.Media.SystemSounds]::Asterisk.Play() } catch { } })
    }

    $form.Add_Shown({ $form.StartStdinCommands() })
    [System.Windows.Forms.Application]::Run($form)
    exit 0
}

# ── RUNNING: desktop control in progress ─────────────────────────────────────
# [dot] ClawdCursor  Typing in Edge  0:42  [Stop]
$form.Height = 38

function New-PillLabel([string]$text, [string]$font, [float]$size, $color) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text; $l.UseMnemonic = $false
    $l.Font = New-Object System.Drawing.Font($font, $size)
    $l.ForeColor = $color
    $l.BackColor = [System.Drawing.Color]::Transparent
    $l.AutoSize = $true
    return $l
}
$dot      = New-Object Orb   # the "working" orb: particles on their orbits while the agent works
$dot.BackColor = $form.BackColor
$brand    = New-PillLabel 'ClawdCursor' 'Segoe UI Semibold' 9 $muted
$activity = New-PillLabel 'Working' 'Segoe UI Semibold' 9.5 ([System.Drawing.Color]::White)
if ($env:CLAWD_BANNER_ACTIVITY) { $activity.Text = [string]$env:CLAWD_BANNER_ACTIVITY }
$elapsed  = New-PillLabel '0:00' 'Segoe UI' 9 $muted

# Stop: a click stops (as a double-click anywhere does). A label, not a Button: a Button takes focus on click.
$stop = New-PillLabel 'Stop' 'Segoe UI Semibold' 9 ([System.Drawing.Color]::FromArgb(252, 165, 165))
$stop.AutoSize  = $false
$stop.TextAlign = 'MiddleCenter'
$stop.BackColor = [System.Drawing.Color]::FromArgb(64, 30, 33)
$stop.Size      = New-Object System.Drawing.Size(52, 24)
$stop.Cursor    = [System.Windows.Forms.Cursors]::Hand
Set-Round $stop 6
$stop.Add_MouseEnter({ $stop.BackColor = [System.Drawing.Color]::FromArgb(92, 38, 42) })
$stop.Add_MouseLeave({ $stop.BackColor = [System.Drawing.Color]::FromArgb(64, 30, 33) })

$form.Controls.AddRange(@($dot, $brand, $activity, $elapsed, $stop))

# Lay the row out left to right and size the pill to it (the activity text changes), centred again each time.
function Update-Layout {
    $x = 12
    $dot.Location = New-Object System.Drawing.Point(($x - 2), 9);     $x += $dot.Width + 2
    $brand.Location = New-Object System.Drawing.Point($x, 11);        $x += $brand.PreferredWidth + 4
    $activity.Location = New-Object System.Drawing.Point($x, 10);     $x += $activity.PreferredWidth + 6
    $elapsed.Location = New-Object System.Drawing.Point($x, 11);      $x += $elapsed.PreferredWidth + 10
    $stop.Location = New-Object System.Drawing.Point($x, 7);          $x += $stop.Width + 7
    $form.Width = $x
    # Every time, not only on a new width: the work may have moved to another monitor.
    Set-PillShape $form 19
}
Update-Layout

$form.add_ActivityChanged([Action[string]]{ param($t) $activity.Text = $t; Update-Layout })

# The clock counts from when the pill appeared (the orb moves by itself).
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 700
$timer.Add_Tick({
    $form.Raise()
    $s = [int]$clock.Elapsed.TotalSeconds
    $t = '{0}:{1:00}' -f [int][Math]::Floor($s / 60), ($s % 60)
    if ($elapsed.Text -ne $t) { $elapsed.Text = $t; Update-Layout }
})
$timer.Start()

$stopHandler = { Send-Line 'BANNER_STOP' }
$stop.Add_Click($stopHandler)
$form.Add_MouseDoubleClick($stopHandler)
foreach ($c in @($dot, $brand, $activity, $elapsed)) { $c.Add_MouseDoubleClick($stopHandler) }

$form.Add_Shown({ $form.StartStdinCommands() })
[System.Windows.Forms.Application]::Run($form)
