# banner.ps1 — "ClawdCursor — desktop control in progress" indicator.
#
# A small, always-on-top, borderless pill at the top-center of the primary
# screen with a blinking red "recording" dot. Shown by the daemon while an
# agent is actively driving the desktop, so a human at the machine ALWAYS
# knows automation is live (transparency requirement — same spirit as the
# labeled agent browser window).
#
# Interaction contract with the parent (src/core/banner.ts):
#   - Parent spawns:  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File banner.ps1
#   - DOUBLE-CLICK anywhere on the banner → prints "BANNER_STOP" on stdout and
#     exits; the parent reacts by running the `clawdcursor stop` flow
#     (abort in-flight task + graceful daemon shutdown).
#   - Parent kills this process to hide the banner.
#   - PAUSED mode (env CLAWD_BANNER_MODE=paused, set by src/core/pause-gate.ts
#     via banner.ts): the agent handed the desktop to the user. Blue dot, the
#     instruction from CLAWD_BANNER_MESSAGE, and two buttons: Resume
#     (BANNER_RESUME) / End task (BANNER_END). The click prints that line on
#     stdout and exits. No double-click stop here. A short system sound plays
#     when it appears (off with CLAWD_PAUSE_SOUND=0).
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
    // A click must not activate the pill either: answer WM_MOUSEACTIVATE with
    // MA_NOACTIVATE (the click is still delivered).
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0021) { m.Result = (IntPtr)3; return; } // WM_MOUSEACTIVATE -> MA_NOACTIVATE
        base.WndProc(ref m);
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
'@

$form = New-Object NoActivateBannerForm
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar   = $false
$form.TopMost         = $true
$form.StartPosition   = 'Manual'
$form.BackColor       = [System.Drawing.Color]::FromArgb(18, 18, 26)
$form.Size            = New-Object System.Drawing.Size(430, 40)

# Top-center of the primary screen, 8px below the edge; rounded corners.
function Set-PillShape($f, [int]$r) {
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $f.Location = New-Object System.Drawing.Point(
        [int]($screen.X + ($screen.Width - $f.Width) / 2), [int]($screen.Y + 8))
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $w = $f.Width; $h = $f.Height
    $gp.AddArc(0, 0, $r*2, $r*2, 180, 90)
    $gp.AddArc($w - $r*2, 0, $r*2, $r*2, 270, 90)
    $gp.AddArc($w - $r*2, $h - $r*2, $r*2, $r*2, 0, 90)
    $gp.AddArc(0, $h - $r*2, $r*2, $r*2, 90, 90)
    $gp.CloseFigure()
    $f.Region = New-Object System.Drawing.Region($gp)
}

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
    $blue    = [System.Drawing.Color]::FromArgb(59, 130, 246)
    $form.Width = 560

    $dot = New-Object System.Windows.Forms.Label
    $dot.Text      = [char]0x25CF
    $dot.Font      = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
    $dot.ForeColor = $blue
    $dot.BackColor = [System.Drawing.Color]::Transparent
    $dot.AutoSize  = $true
    $dot.Location  = New-Object System.Drawing.Point(14, 7)

    $title = New-Object System.Windows.Forms.Label
    $title.Text      = 'ClawdCursor paused - your turn'
    $title.Font      = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
    $title.ForeColor = [System.Drawing.Color]::White
    $title.BackColor = [System.Drawing.Color]::Transparent
    $title.AutoSize  = $true
    $title.Location  = New-Object System.Drawing.Point(40, 12)

    $msg = New-Object System.Windows.Forms.Label
    $msg.Text        = [string]$env:CLAWD_BANNER_MESSAGE
    $msg.Font        = New-Object System.Drawing.Font('Segoe UI', 10)
    $msg.ForeColor   = [System.Drawing.Color]::FromArgb(215, 215, 225)
    $msg.BackColor   = [System.Drawing.Color]::Transparent
    $msg.AutoSize    = $true
    $msg.MaximumSize = New-Object System.Drawing.Size(500, 0)
    $msg.Location    = New-Object System.Drawing.Point(40, 38)
    $msgH = $msg.GetPreferredSize((New-Object System.Drawing.Size(500, 0))).Height

    # Labels styled as buttons: a real Button takes focus on click, and this
    # window must never pull focus from the field the user is typing in.
    function New-PillButton([string]$text, [string]$line, [int]$x, [int]$y, $bg) {
        $b = New-Object System.Windows.Forms.Label
        $b.Text      = $text
        $b.Font      = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
        $b.ForeColor = [System.Drawing.Color]::White
        $b.BackColor = $bg
        $b.TextAlign = 'MiddleCenter'
        $b.Size      = New-Object System.Drawing.Size(110, 30)
        $b.Location  = New-Object System.Drawing.Point($x, $y)
        $b.Cursor    = [System.Windows.Forms.Cursors]::Hand
        $b.Tag       = $line
        $b.Add_MouseDown({ $script:userWindow = [NoActivateBannerForm]::GetForegroundWindow() })
        $b.Add_Click({ param($sender, $e) Send-Line ([string]$sender.Tag) })
        return $b
    }
    $btnY  = 38 + $msgH + 12
    $gray  = [System.Drawing.Color]::FromArgb(60, 60, 72)
    $yes   = New-PillButton 'Resume'   'BANNER_RESUME' ($form.Width - 250) $btnY $blue
    $no    = New-PillButton 'End task' 'BANNER_END'    ($form.Width - 130) $btnY $gray

    $form.Height = $btnY + 30 + 14
    $form.Controls.AddRange(@($dot, $title, $msg, $yes, $no))
    Set-PillShape $form 14

    # Slow blue pulse on the dot — calmer than the red "recording" blink.
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 900
    $bright = $true
    $timer.Add_Tick({
        $script:bright = -not $script:bright
        if ($script:bright) { $dot.ForeColor = $blue }
        else                { $dot.ForeColor = [System.Drawing.Color]::FromArgb(25, 55, 110) }
    })
    $timer.Start()

    # A short system sound when the prompt appears, so a user who isn't looking
    # hears it's their turn (#237). CLAWD_PAUSE_SOUND=0 turns it off.
    if ($env:CLAWD_PAUSE_SOUND -ne '0') {
        $form.Add_Shown({ try { [System.Media.SystemSounds]::Asterisk.Play() } catch { } })
    }

    [System.Windows.Forms.Application]::Run($form)
    exit 0
}

# ── RUNNING: desktop control in progress ─────────────────────────────────────
Set-PillShape $form 18

$dot = New-Object System.Windows.Forms.Label
$dot.Text      = [char]0x25CF  # ●
$dot.Font      = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$dot.ForeColor = [System.Drawing.Color]::FromArgb(255, 59, 48)
$dot.BackColor = [System.Drawing.Color]::Transparent
$dot.AutoSize  = $true
$dot.Location  = New-Object System.Drawing.Point(14, 5)

$text = New-Object System.Windows.Forms.Label
$text.Text      = 'ClawdCursor '  # brand
$text.Font      = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
$text.ForeColor = [System.Drawing.Color]::White
$text.BackColor = [System.Drawing.Color]::Transparent
$text.AutoSize  = $true
$text.Location  = New-Object System.Drawing.Point(40, 10)

$sub = New-Object System.Windows.Forms.Label
$sub.Text      = 'desktop control in progress  -  double-click to stop'
$sub.Font      = New-Object System.Drawing.Font('Segoe UI', 9)
$sub.ForeColor = [System.Drawing.Color]::FromArgb(170, 170, 185)
$sub.BackColor = [System.Drawing.Color]::Transparent
$sub.AutoSize  = $true
$sub.Location  = New-Object System.Drawing.Point(133, 11)

$form.Controls.AddRange(@($dot, $text, $sub))

# Recording blink — bright/dim every 600ms.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 600
$bright = $true
$timer.Add_Tick({
    $script:bright = -not $script:bright
    if ($script:bright) { $dot.ForeColor = [System.Drawing.Color]::FromArgb(255, 59, 48) }
    else                { $dot.ForeColor = [System.Drawing.Color]::FromArgb(110, 25, 20) }
})
$timer.Start()

$stopHandler = { Send-Line 'BANNER_STOP' }
$form.Add_MouseDoubleClick($stopHandler)
foreach ($c in @($dot, $text, $sub)) { $c.Add_MouseDoubleClick($stopHandler) }

[System.Windows.Forms.Application]::Run($form)
