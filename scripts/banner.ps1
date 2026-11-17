# banner.ps1 — "ClawdCursor — desktop control in progress" indicator.
#
# A small, always-on-top, borderless pill at the top-center of the monitor the
# agent is working on: the clawdcursor mascot, what the agent is doing ("Typing in Edge"), the
# time since it appeared, and a Stop button. Shown by the daemon while an
# agent is actively driving the desktop, so a human at the machine ALWAYS
# knows automation is live (transparency requirement — same spirit as the
# labeled agent browser window).
#
# Interaction contract with the parent (src/core/banner.ts):
#   - Parent spawns:  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File banner.ps1
#   - Stop, or a DOUBLE-CLICK anywhere on the banner → prints "BANNER_STOP" on
#     stdout and exits; the parent stops control (src/core/control.ts stopControl)
#     until the user gives it back.
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
#
# The macOS pill's orb (scripts/mac/overlay.swift) is a port of Thinking Orbs by Jakub Antalik (libraries.dev,
# github.com/Jakubantalik/Libraries.dev, packages/thinking-orbs), under this notice:
# Thinking Orbs - MIT License - Copyright (c) 2026 Jakub Antalik
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

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Windows.Forms;

public class NoActivateBannerForm : Form {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    // Another topmost window (or one shown later) can cover the pill: when any visible window is above it, put it back on
    // top - never activating it (SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE), so focus and the reply box are untouched.
    public void KeepOnTop() {
        if (!IsHandleCreated || !Visible) return;
        for (IntPtr w = GetWindow(Handle, 3); w != IntPtr.Zero; w = GetWindow(w, 3)) {   // GW_HWNDPREV
            if (IsWindowVisible(w)) { SetWindowPos(Handle, (IntPtr)(-1), 0, 0, 0, 0, 0x13); return; }   // HWND_TOPMOST
        }
    }
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

// The running pill's mascot (scripts/mascot.json): the arrow cursor with two glowing capsule eyes, drawn as filled
// squares (pixel art: no smoothing). The rows come from the script (Open / Blink); it blinks for 150 ms every 4-6 s.
public class Mascot : Control {
    public string[] Open, Blink;
    public int Cell = 2;
    bool blinking;
    readonly Random rng = new Random();
    readonly System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer();
    static readonly Color K = Color.FromArgb(0xC9, 0xDD, 0xF2), B = Color.FromArgb(0x1B, 0x22, 0x32), E = Color.FromArgb(0xE9, 0xFC, 0xFF);
    static readonly Color Glow = Color.FromArgb(70, 0x5F, 0xD8, 0xF0);
    public Mascot() {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        tick.Interval = rng.Next(4000, 6001);
        tick.Tick += (s, e) => {
            blinking = !blinking;
            tick.Interval = blinking ? 150 : rng.Next(4000, 6001);
            Invalidate();
        };
        tick.Start();
    }
    protected override void OnPaint(PaintEventArgs e) {
        string[] rows = blinking ? Blink : Open;
        if (rows == null) return;
        Graphics g = e.Graphics;
        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.None;
        // Body and rim first, then the eyes' halo over the body, then the eyes.
        for (int pass = 0; pass < 3; pass++) {
            for (int y = 0; y < rows.Length; y++) {
                for (int x = 0; x < rows[y].Length; x++) {
                    char c = rows[y][x];
                    if (c == '.') continue;
                    if (pass == 0 && c != 'E') using (var br = new SolidBrush(c == 'K' ? K : B)) g.FillRectangle(br, x * Cell, y * Cell, Cell, Cell);
                    if (pass == 1 && c == 'E') using (var br = new SolidBrush(Glow)) g.FillRectangle(br, (x - 1) * Cell, (y - 1) * Cell, 3 * Cell, 3 * Cell);
                    if (pass == 2 && c == 'E') using (var br = new SolidBrush(E)) g.FillRectangle(br, x * Cell, y * Cell, Cell, Cell);
                }
            }
        }
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
$script:userPos = $null   # where the user dragged the pill to; it stays there for the life of this process
function Get-OnScreen($p, $f) {
    $wa = [System.Windows.Forms.Screen]::FromRectangle((New-Object System.Drawing.Rectangle($p, $f.Size))).WorkingArea
    New-Object System.Drawing.Point([Math]::Max($wa.X, [Math]::Min($p.X, $wa.Right - $f.Width)), [Math]::Max($wa.Y, [Math]::Min($p.Y, $wa.Bottom - $f.Height)))
}
function Set-PillShape($f, [int]$r) {
    $script:radius = $r
    $fg = [NoActivateBannerForm]::GetForegroundWindow()
    $screen = if ($fg -ne [IntPtr]::Zero) { [System.Windows.Forms.Screen]::FromHandle($fg).WorkingArea }
              else { [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea }
    $at = New-Object System.Drawing.Point(
        [int]($screen.X + ($screen.Width - $f.Width) / 2), [int]($screen.Y + 8))
    if ($script:userPos) { $at = Get-OnScreen $script:userPos $f }
    if ($f.Location -ne $at) { $f.Location = $at }
    # A new outline only for a new size: this runs on every tick of the clock, and cutting the window's shape again
    # and painting the whole pill each second cost more than everything else the pill does.
    $shape = '{0}x{1}r{2}' -f $f.Width, $f.Height, $r
    if ($script:shape -ne $shape) {
        $script:shape = $shape
        Set-Round $f $r
        $f.Invalidate()
    }
}
# Dragging: the pill's body (the form and its plain labels, never a button or the reply box) moves it. Done by hand with
# the mouse (a control keeps the mouse until release), so the window is never activated.
$script:drag = $null
function Enable-Drag($c) {
    $c.Add_MouseDown({ param($s, $e) if ($e.Button -eq 'Left') { $script:drag = [System.Windows.Forms.Cursor]::Position; $script:dragFrom = $form.Location } })
    $c.Add_MouseMove({
        if ($script:drag) {
            $p = [System.Windows.Forms.Cursor]::Position
            $script:userPos = Get-OnScreen (New-Object System.Drawing.Point(($script:dragFrom.X + $p.X - $script:drag.X), ($script:dragFrom.Y + $p.Y - $script:drag.Y))) $form
            $form.Location = $script:userPos
        }
    })
    $c.Add_MouseUp({ $script:drag = $null })
}

# A cue when the pill appears: the outline is solid amber for 3 s, then fades back over 1 s. Never a loop. Timed by the
# clock, not by ticks: this timer ticks unevenly, and a 1.5 s fade and then three short flashes both went unnoticed by
# the owner (2026-11-17).
$script:edgeW = 1
function Start-Pulse {
    $script:base = $script:edge; $script:amber = [System.Drawing.Color]::FromArgb(245, 158, 11)
    $script:pulseAt = [Diagnostics.Stopwatch]::StartNew()
    $script:pulse = New-Object System.Windows.Forms.Timer
    $script:pulse.Interval = 60
    $script:pulse.Add_Tick({
        $ms = $script:pulseAt.ElapsedMilliseconds
        $k = if ($ms -lt 3000) { 1.0 } else { [Math]::Max(0.0, 1 - ($ms - 3000) / 1000.0) }
        $script:edgeW = if ($k -gt 0) { 4 } else { 1 }
        $script:edge = [System.Drawing.Color]::FromArgb([int]($script:base.R + ($script:amber.R - $script:base.R) * $k), [int]($script:base.G + ($script:amber.G - $script:base.G) * $k), [int]($script:base.B + ($script:amber.B - $script:base.B) * $k))
        $form.Invalidate()
        if ($k -le 0) { $script:pulse.Stop() }
    })
    $script:pulse.Start()
}
$form.Add_Paint({
    param($s, $e)
    $e.Graphics.SmoothingMode = 'AntiAlias'
    $pen = New-Object System.Drawing.Pen($script:edge, $script:edgeW)
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

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 900
    $bright = $true
    $timer.Add_Tick({
        $script:bright = -not $script:bright
        if ($script:bright) { $dot.ForeColor = $blue }
        else                { $dot.ForeColor = [System.Drawing.Color]::FromArgb(25, 55, 110) }
        $form.KeepOnTop()
    })
    $timer.Start()

    # A short system sound when the prompt appears, so a user who isn't looking
    # hears it's their turn (#237). CLAWD_PAUSE_SOUND=0 turns it off.
    if ($env:CLAWD_PAUSE_SOUND -ne '0') {
        $form.Add_Shown({ try { [System.Media.SystemSounds]::Asterisk.Play() } catch { } })
    }

    foreach ($c in @($form, $dot, $title, $msg)) { Enable-Drag $c }
    $form.Add_Shown({ $form.StartStdinCommands(); Start-Pulse })
    [System.Windows.Forms.Application]::Run($form)
    exit 0
}

# ── RUNNING: desktop control in progress ─────────────────────────────────────
# [mascot] ClawdCursor  Typing in Edge  0:42  [Stop]
$form.Height = 38

function New-PillLabel([string]$text, [string]$font, [float]$size, $color) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text; $l.UseMnemonic = $false
    $l.Font = New-Object System.Drawing.Font($font, $size)
    $l.ForeColor = $color
    # The pill's own colour, not Transparent: a transparent label repaints the whole pill under it (the outline, in the
    # script's Paint handler) each time its text changes - the clock, every second (#414).
    $l.BackColor = $form.BackColor
    $l.AutoSize = $true
    return $l
}
# The art is scripts/mascot.json, embedded here (a test checks it matches).
# MASCOT-BEGIN open
$mascotOpen = @(
'K..........',
'KK.........',
'KBK........',
'KBBK.......',
'KBBBK......',
'KBBBBK.....',
'KBEBEBK....',
'KBEBEBBK...',
'KBEBEBBBK..',
'KBBBBBBBBK.',
'KBBBBBKKKKK',
'KBBKBBK....',
'KBK.KBBK...',
'KK..KBBK...',
'K....KBBK..',
'.....KBBK..',
'......KK...'
)
# MASCOT-END
# MASCOT-BEGIN blink
$mascotBlink = @(
'K..........',
'KK.........',
'KBK........',
'KBBK.......',
'KBBBK......',
'KBBBBK.....',
'KBBBBBK....',
'KBBBBBBK...',
'KBEBEBBBK..',
'KBBBBBBBBK.',
'KBBBBBKKKKK',
'KBBKBBK....',
'KBK.KBBK...',
'KK..KBBK...',
'K....KBBK..',
'.....KBBK..',
'......KK...'
)
# MASCOT-END
$dot      = New-Object Mascot
$dot.Open = [string[]]$mascotOpen
$dot.Blink = [string[]]$mascotBlink
$dot.Size = New-Object System.Drawing.Size((11 * $dot.Cell), (17 * $dot.Cell))
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

function Update-Layout {
    $x = 12
    $dot.Location = New-Object System.Drawing.Point(($x + 2), 2);     $x += $dot.Width + 8
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

# The clock counts from when the pill appeared (the mascot blinks by itself).
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 700
$timer.Add_Tick({
    $s = [int]$clock.Elapsed.TotalSeconds
    $t = '{0}:{1:00}' -f [int][Math]::Floor($s / 60), ($s % 60)
    if ($elapsed.Text -ne $t) { $elapsed.Text = $t; Update-Layout }
    $form.KeepOnTop()
})
$timer.Start()

$stopHandler = { Send-Line 'BANNER_STOP' }
$stop.Add_Click($stopHandler)
$form.Add_MouseDoubleClick($stopHandler)
foreach ($c in @($dot, $brand, $activity, $elapsed)) { $c.Add_MouseDoubleClick($stopHandler) }

foreach ($c in @($form, $dot, $brand, $activity, $elapsed)) { Enable-Drag $c }
$form.Add_Shown({ $form.StartStdinCommands(); Start-Pulse })
[System.Windows.Forms.Application]::Run($form)
