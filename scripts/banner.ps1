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
#     instruction from CLAWD_BANNER_MESSAGE, and three buttons: Resume
#     (BANNER_RESUME) / Something else / End task (BANNER_END). The click prints
#     that line on stdout and exits. "Something else" opens a text box (the pill
#     takes the keyboard only then, on the user's click); Enter / Send prints
#     BANNER_REPLY <base64 of the UTF-8 text> and exits. No double-click stop here. A short system sound plays
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
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
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
                    }
                }
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
        $b.Add_MouseDown({
            # The user's own window — never the pill itself (it is foreground once the user typed an answer).
            $fg = [NoActivateBannerForm]::GetForegroundWindow()
            if ($fg -ne $form.Handle) { $script:userWindow = $fg }
        })
        if ($line) { $b.Add_Click({ param($sender, $e) Send-Line ([string]$sender.Tag) }) }
        return $b
    }
    $btnY  = 38 + $msgH + 12
    $gray  = [System.Drawing.Color]::FromArgb(60, 60, 72)
    $yes   = New-PillButton 'Resume'   'BANNER_RESUME' ($form.Width - 380) $btnY $blue
    $other = New-PillButton 'Something else' '' ($form.Width - 260) $btnY $gray
    $other.Size = New-Object System.Drawing.Size(120, 30)
    $no    = New-PillButton 'End task' 'BANNER_END'    ($form.Width - 130) $btnY $gray

    # "Something else": the user types an answer for the agent instead of doing the step. The buttons give way to a
    # text box + Send; Enter sends, Esc goes back. Sent as BANNER_REPLY <base64 UTF-8> (one line, whatever was typed).
    $reply = New-Object System.Windows.Forms.TextBox
    $reply.Font        = New-Object System.Drawing.Font('Segoe UI', 10)
    $reply.BackColor   = [System.Drawing.Color]::FromArgb(36, 36, 48)
    $reply.ForeColor   = [System.Drawing.Color]::White
    $reply.BorderStyle = 'FixedSingle'
    $reply.Location    = New-Object System.Drawing.Point(40, ($btnY + 3))
    $reply.Size        = New-Object System.Drawing.Size(($form.Width - 40 - 100), 26)
    $reply.Visible     = $false
    $send = New-PillButton 'Send' '' ($form.Width - 90) $btnY $blue
    $send.Size    = New-Object System.Drawing.Size(76, 30)
    $send.Visible = $false
    function Send-Reply {
        $t = $reply.Text.Trim()
        if ($t.Length -eq 0) { return }
        Send-Line ('BANNER_REPLY ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($t)))
    }
    function Show-ReplyBox([bool]$on) {
        foreach ($b in @($yes, $other, $no)) { $b.Visible = -not $on }
        $reply.Visible = $on; $send.Visible = $on
        if ($on) { $form.TakeKeyboard(); [void]$reply.Focus() }
        elseif ($script:userWindow -ne [IntPtr]::Zero) { [void][NoActivateBannerForm]::SetForegroundWindow($script:userWindow) }
    }
    $other.Add_Click({ Show-ReplyBox $true })
    $send.Add_Click({ Send-Reply })
    $reply.Add_KeyDown({
        param($s, $e)
        if ($e.KeyCode -eq 'Return') { $e.SuppressKeyPress = $true; Send-Reply }
        elseif ($e.KeyCode -eq 'Escape') { $e.SuppressKeyPress = $true; $reply.Text = ''; Show-ReplyBox $false }
    })

    $form.Height = $btnY + 30 + 14
    $form.Controls.AddRange(@($dot, $title, $msg, $yes, $other, $no, $reply, $send))
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

    $form.Add_Shown({ $form.StartStdinCommands() })
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

$form.Add_Shown({ $form.StartStdinCommands() })
[System.Windows.Forms.Application]::Run($form)
