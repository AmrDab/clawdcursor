# Persistent PowerShell UIA Bridge
# Reads newline-delimited JSON commands from stdin, writes results to stdout.
# Keeps UI Automation assemblies and Win32 types loaded between calls —
# eliminates 200-500ms PowerShell startup overhead on every a11y operation.

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    [Console]::Out.WriteLine((@{ error = "Assembly load failed: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    exit 1
}

try {
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public static class Win32UIA {
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    }
"@
} catch { } # May already be defined in a long-running session

$ErrorActionPreference = 'Continue'

# Control type map
$ctMap = @{
    "Button"      = [System.Windows.Automation.ControlType]::Button
    "CheckBox"    = [System.Windows.Automation.ControlType]::CheckBox
    "ComboBox"    = [System.Windows.Automation.ControlType]::ComboBox
    "Custom"      = [System.Windows.Automation.ControlType]::Custom
    "DataGrid"    = [System.Windows.Automation.ControlType]::DataGrid
    "DataItem"    = [System.Windows.Automation.ControlType]::DataItem
    "Document"    = [System.Windows.Automation.ControlType]::Document
    "Edit"        = [System.Windows.Automation.ControlType]::Edit
    "Group"       = [System.Windows.Automation.ControlType]::Group
    "Hyperlink"   = [System.Windows.Automation.ControlType]::Hyperlink
    "Image"       = [System.Windows.Automation.ControlType]::Image
    "List"        = [System.Windows.Automation.ControlType]::List
    "ListItem"    = [System.Windows.Automation.ControlType]::ListItem
    "Menu"        = [System.Windows.Automation.ControlType]::Menu
    "MenuBar"     = [System.Windows.Automation.ControlType]::MenuBar
    "MenuItem"    = [System.Windows.Automation.ControlType]::MenuItem
    "Pane"        = [System.Windows.Automation.ControlType]::Pane
    "RadioButton" = [System.Windows.Automation.ControlType]::RadioButton
    "ScrollBar"   = [System.Windows.Automation.ControlType]::ScrollBar
    "Slider"      = [System.Windows.Automation.ControlType]::Slider
    "Spinner"     = [System.Windows.Automation.ControlType]::Spinner
    "SplitButton" = [System.Windows.Automation.ControlType]::SplitButton
    "Tab"         = [System.Windows.Automation.ControlType]::Tab
    "TabItem"     = [System.Windows.Automation.ControlType]::TabItem
    "Text"        = [System.Windows.Automation.ControlType]::Text
    "ToolBar"     = [System.Windows.Automation.ControlType]::ToolBar
    "Tree"        = [System.Windows.Automation.ControlType]::Tree
    "TreeItem"    = [System.Windows.Automation.ControlType]::TreeItem
    "Window"      = [System.Windows.Automation.ControlType]::Window
}

$interactiveTypes = @(
    'ControlType.Button', 'ControlType.Edit', 'ControlType.ComboBox',
    'ControlType.CheckBox', 'ControlType.RadioButton', 'ControlType.Hyperlink',
    'ControlType.MenuItem', 'ControlType.Menu', 'ControlType.Tab',
    'ControlType.TabItem', 'ControlType.ListItem', 'ControlType.TreeItem',
    'ControlType.Slider', 'ControlType.Document', 'ControlType.DataItem',
    'ControlType.Pane', 'ControlType.Custom', 'ControlType.ToolBar',
    'ControlType.Text', 'ControlType.Group'
)

# ── UI tree builder ───────────────────────────────────────────────────────────
function ConvertTo-UINode {
    param(
        [System.Windows.Automation.AutomationElement]$Element,
        [int]$Depth = 0,
        [int]$MaxDepth = 8
    )
    if ($null -eq $Element) { return $null }
    try { $cur = $Element.Current } catch { return $null }

    $typeName = $cur.ControlType.ProgrammaticName
    $hasName = $cur.Name -and $cur.Name.Trim().Length -gt 0
    $isInteractive = $interactiveTypes -contains $typeName

    if (-not $isInteractive -and -not $hasName -and $Depth -gt 0) {
        # Unnamed non-interactive element — only skip if it's a LEAF (no children)
        # or we've hit max depth. Electron/WebView2 apps nest: Window > Pane > Pane > Pane > Button
        if ($Depth -ge $MaxDepth) { return $null }
        $childNodes = @()
        try {
            $kids = $Element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($kid in $kids) {
                $cn = ConvertTo-UINode -Element $kid -Depth ($Depth + 1) -MaxDepth $MaxDepth
                if ($null -ne $cn) { $childNodes += $cn }
            }
        } catch {}
        # Skip unnamed leaves — but recurse into unnamed containers that have children
        if ($childNodes.Count -eq 0) { return $null }
        return $childNodes
    }

    $rect = $cur.BoundingRectangle
    $bounds = if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y) -or $rect.X -lt -100 -or $rect.Y -lt -100) {
        @{ x = 0; y = 0; width = 0; height = 0 }
    } else {
        @{ x = [Math]::Round($rect.X); y = [Math]::Round($rect.Y); width = [Math]::Round($rect.Width); height = [Math]::Round($rect.Height) }
    }

    $node = [ordered]@{
        name         = if ($cur.Name) { $cur.Name } else { "" }
        automationId = if ($cur.AutomationId) { $cur.AutomationId } else { "" }
        controlType  = $typeName
        className    = if ($cur.ClassName) { $cur.ClassName } else { "" }
        isEnabled    = $cur.IsEnabled
        bounds       = $bounds
        children     = @()
    }

    if ($Depth -lt $MaxDepth) {
        try {
            $kids = $Element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($kid in $kids) {
                $cn = ConvertTo-UINode -Element $kid -Depth ($Depth + 1) -MaxDepth $MaxDepth
                if ($null -ne $cn) {
                    if ($cn -is [array]) { $node.children += $cn } else { $node.children += $cn }
                }
            }
        } catch {}
    }
    return $node
}

# ── Command: get-screen-context ───────────────────────────────────────────────
function Cmd-GetScreenContext {
    param($cmd)
    $focusedPid = if ($cmd.focusedProcessId) { [int]$cmd.focusedProcessId } else { 0 }
    $maxDepth   = if ($cmd.maxDepth)         { [int]$cmd.maxDepth }         else { 8 }

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $winCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window
    )
    $allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)

    $windowList = @()
    foreach ($win in $allWins) {
        try {
            $c = $win.Current
            if (-not $c.Name -or $c.Name.Trim().Length -eq 0) { continue }
            $pName = "unknown"
            try { $pName = [System.Diagnostics.Process]::GetProcessById($c.ProcessId).ProcessName } catch {}
            $rect = $c.BoundingRectangle
            $bounds = if ([double]::IsInfinity($rect.X)) { @{ x=0;y=0;width=0;height=0 } }
                else { @{ x=[Math]::Round($rect.X); y=[Math]::Round($rect.Y); width=[Math]::Round($rect.Width); height=[Math]::Round($rect.Height) } }
            $isMin = $false
            try {
                $wp = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
                if ($wp.Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized) { $isMin = $true }
            } catch {}
            $windowList += [ordered]@{
                handle = $c.NativeWindowHandle; title = $c.Name; processName = $pName
                processId = $c.ProcessId; bounds = $bounds; isMinimized = $isMin
            }
        } catch {}
    }

    $uiTree = $null
    if ($focusedPid -gt 0) {
        $pidCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $focusedPid
        )
        $targetWin = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pidCond)
        if ($null -ne $targetWin) {
            $uiTree = ConvertTo-UINode -Element $targetWin -Depth 0 -MaxDepth $maxDepth
        }
    }

    return [ordered]@{ windows = $windowList; uiTree = $uiTree }
}

# ── Command: get-foreground-window ────────────────────────────────────────────
function Cmd-GetForegroundWindow {
    $fgWin = [Win32UIA]::GetForegroundWindow()
    if ($fgWin -eq [IntPtr]::Zero) { return @{ error = "No foreground window" } }
    $wpid = 0
    [void][Win32UIA]::GetWindowThreadProcessId($fgWin, [ref]$wpid)
    $pName = "unknown"
    try { $pName = [System.Diagnostics.Process]::GetProcessById($wpid).ProcessName } catch {}
    $title = ""
    try {
        $el = [System.Windows.Automation.AutomationElement]::FromHandle($fgWin)
        if ($el) { $title = $el.Current.Name }
    } catch {}
    return [ordered]@{ handle=[int]$fgWin; processId=$wpid; processName=$pName; title=$title; success=$true }
}

# ── Command: focus-window ─────────────────────────────────────────────────────
function Cmd-FocusWindow {
    param($cmd)
    $title   = if ($cmd.title)     { $cmd.title }           else { "" }
    $wpid    = if ($cmd.processId) { [int]$cmd.processId }  else { 0 }
    $restore = if ($cmd.restore)   { $true }                else { $false }

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $winCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window
    )
    $allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)

    $target = $null
    if ($wpid -gt 0) {
        foreach ($w in $allWins) {
            try { if ($w.Current.ProcessId -eq $wpid) { $target = $w; break } } catch {}
        }
    } elseif ($title -ne "") {
        $tl = $title.ToLower()
        foreach ($w in $allWins) {
            try { if ($w.Current.Name -and $w.Current.Name.ToLower().Contains($tl)) { $target = $w; break } } catch {}
        }
    }

    if ($null -eq $target) { return @{ success=$false; error="Window not found: title='$title' pid=$wpid" } }

    if ($restore) {
        try {
            $wp = $target.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
            if ($wp.Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized) {
                $wp.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
                Start-Sleep -Milliseconds 120
            }
        } catch {}
    }

    try { $target.SetFocus() } catch {
        try {
            $hwnd = [IntPtr]$target.Current.NativeWindowHandle
            [Win32UIA]::ShowWindow($hwnd, 9) | Out-Null
            Start-Sleep -Milliseconds 60
            [Win32UIA]::SetForegroundWindow($hwnd) | Out-Null
        } catch {}
    }

    $c = $target.Current
    return [ordered]@{ success=$true; title=$c.Name; processId=$c.ProcessId; handle=$c.NativeWindowHandle }
}

# ── Command: find-element (fuzzy name match) ──────────────────────────────────
function Cmd-FindElement {
    param($cmd)
    $name        = if ($cmd.name)        { $cmd.name }           else { "" }
    $automationId= if ($cmd.automationId){ $cmd.automationId }   else { "" }
    $controlType = if ($cmd.controlType) { $cmd.controlType }    else { "" }
    $wpid        = if ($cmd.processId)   { [int]$cmd.processId } else { 0 }
    $maxResults  = if ($cmd.maxResults)  { [int]$cmd.maxResults } else { 20 }

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $searchRoot = $root
    if ($wpid -gt 0) {
        $pc = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $wpid
        )
        $searchRoot = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pc)
        if ($null -eq $searchRoot) { return ,(New-Object System.Object[] 0) }
    }

    $conditions = @()
    if ($automationId -ne "") {
        $conditions += New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $automationId
        )
    }
    if ($controlType -ne "" -and $ctMap.ContainsKey($controlType)) {
        $conditions += New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ctMap[$controlType]
        )
    }

    $searchCond = if ($conditions.Count -eq 0) { [System.Windows.Automation.Condition]::TrueCondition }
        elseif ($conditions.Count -eq 1) { $conditions[0] }
        else { New-Object System.Windows.Automation.AndCondition([System.Windows.Automation.Condition[]]$conditions) }

    $elements = $searchRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $searchCond)
    $results = @()
    $nameLower = $name.ToLower()

    foreach ($el in $elements) {
        if ($results.Count -ge $maxResults) { break }
        try {
            $c = $el.Current
            if ($name -ne "") {
                # Fuzzy: strip keyboard shortcut suffix ("Save\tCtrl+S" → "save"), then contains-match
                $elName = ($c.Name -replace '\t.*$', '').Trim().ToLower()
                if (-not $elName.Contains($nameLower) -and -not $nameLower.Contains($elName)) { continue }
                if ($elName.Length -eq 0) { continue }
            }
            $rect = $c.BoundingRectangle
            $bounds = if ([double]::IsInfinity($rect.X)) { @{x=0;y=0;width=0;height=0} }
                else { @{x=[int]$rect.X;y=[int]$rect.Y;width=[int]$rect.Width;height=[int]$rect.Height} }
            $results += [ordered]@{
                name=$c.Name; automationId=$c.AutomationId; controlType=$c.ControlType.ProgrammaticName
                className=$c.ClassName; processId=$c.ProcessId; isEnabled=$c.IsEnabled; bounds=$bounds
            }
        } catch {}
    }
    return ,$results
}

# ── Command: invoke-element (fuzzy name match) ────────────────────────────────
function Cmd-InvokeElement {
    param($cmd)
    $name        = if ($cmd.name)        { $cmd.name }           else { "" }
    $automationId= if ($cmd.automationId){ $cmd.automationId }   else { "" }
    $controlType = if ($cmd.controlType) { $cmd.controlType }    else { "" }
    $wpid        = [int]$cmd.processId
    $action      = $cmd.action
    $value       = if ($cmd.value)       { $cmd.value }          else { "" }

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $pc = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $wpid
    )
    $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pc)
    if ($null -eq $window) { return @{ success=$false; error="No window for pid $wpid" } }

    # Find element: prefer automationId (exact), then fuzzy name walk
    $element = $null
    if ($automationId -ne "") {
        $aidCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $automationId
        )
        $element = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $aidCond)
    }

    if ($null -eq $element -and $name -ne "") {
        $nameLower = $name.ToLower()
        $ctCond = if ($controlType -ne "" -and $ctMap.ContainsKey($controlType)) {
            New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ctMap[$controlType]
            )
        } else { [System.Windows.Automation.Condition]::TrueCondition }

        $candidates = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $ctCond)
        # First pass: exact match after stripping shortcut suffix
        foreach ($el in $candidates) {
            try {
                $elName = ($el.Current.Name -replace '\t.*$', '').Trim().ToLower()
                if ($elName -eq $nameLower -and $elName.Length -gt 0) { $element = $el; break }
            } catch {}
        }
        # Second pass: contains match
        if ($null -eq $element) {
            foreach ($el in $candidates) {
                try {
                    $elName = ($el.Current.Name -replace '\t.*$', '').Trim().ToLower()
                    if ($elName.Length -gt 0 -and ($elName.Contains($nameLower) -or $nameLower.Contains($elName))) {
                        $element = $el; break
                    }
                } catch {}
            }
        }
    }

    if ($null -eq $element) {
        return @{ success=$false; error="Element not found: name='$name' id='$automationId' ct='$controlType'" }
    }

    switch ($action) {
        "click" {
            try {
                $p = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                $p.Invoke()
                return @{ success=$true; action="click"; method="InvokePattern" }
            } catch {
                try {
                    $p = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                    $p.Toggle()
                    return @{ success=$true; action="click"; method="TogglePattern" }
                } catch {
                    $rect = $element.Current.BoundingRectangle
                    return @{ success=$false; action="click"; error="No invoke/toggle pattern";
                        clickPoint=@{x=[int]($rect.X+$rect.Width/2);y=[int]($rect.Y+$rect.Height/2)} }
                }
            }
        }
        "set-value" {
            if ($value -eq "") { return @{ success=$false; error="value required for set-value" } }
            try {
                $p = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                $p.SetValue($value)
                return @{ success=$true; action="set-value"; value=$value }
            } catch {
                return @{ success=$false; error="ValuePattern not supported: $($_.Exception.Message)" }
            }
        }
        "get-value" {
            try {
                $p = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                return @{ success=$true; action="get-value"; value=$p.Current.Value }
            } catch {
                try {
                    $p = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                    return @{ success=$true; action="get-value"; value=$p.DocumentRange.GetText(-1); method="TextPattern" }
                } catch {
                    return @{ success=$true; action="get-value"; value=$element.Current.Name; method="Name" }
                }
            }
        }
        "focus" {
            try { $element.SetFocus(); return @{ success=$true; action="focus" } }
            catch { return @{ success=$false; error="SetFocus failed: $($_.Exception.Message)" } }
        }
        "expand" {
            try {
                $p = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
                $p.Expand(); return @{ success=$true; action="expand" }
            } catch { return @{ success=$false; error="ExpandCollapsePattern not supported" } }
        }
        "select" {
            try {
                $p = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                $p.Select(); return @{ success=$true; action="select" }
            } catch { return @{ success=$false; error="SelectionItemPattern not supported" } }
        }
        default { return @{ success=$false; error="Unknown action: $action" } }
    }
}

# ── Command: get-focused-element ──────────────────────────────────────────────
function Cmd-GetFocusedElement {
    try {
        $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($null -eq $focused) { return @{ success=$false; error="No focused element" } }
        $cur = $focused.Current
        $rect = $cur.BoundingRectangle
        $bounds = if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y)) {
            @{ x=0; y=0; width=0; height=0 }
        } else {
            @{ x=[Math]::Round($rect.X); y=[Math]::Round($rect.Y); width=[Math]::Round($rect.Width); height=[Math]::Round($rect.Height) }
        }
        $typeName = if ($cur.ControlType) { $cur.ControlType.ProgrammaticName } else { "" }
        # Try to read current value if it's an editable element
        $value = ""
        try {
            $vp = $focused.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $value = $vp.Current.Value
        } catch {
            try {
                $tp = $focused.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                $value = $tp.DocumentRange.GetText(1000)
            } catch {}
        }
        return [ordered]@{
            success      = $true
            name         = if ($cur.Name) { $cur.Name } else { "" }
            automationId = if ($cur.AutomationId) { $cur.AutomationId } else { "" }
            controlType  = $typeName
            className    = if ($cur.ClassName) { $cur.ClassName } else { "" }
            processId    = $cur.ProcessId
            isEnabled    = $cur.IsEnabled
            bounds       = $bounds
            value        = $value
        }
    } catch {
        return @{ success=$false; error=$_.Exception.Message }
    }
}

# ── Main: signal ready, then read commands ────────────────────────────────────
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line.Trim() -eq "EXIT") { break }
    $line = $line.Trim()
    if ($line -eq "") { continue }

    try {
        $cmd = $line | ConvertFrom-Json
        $result = switch ($cmd.cmd) {
            "get-screen-context"    { Cmd-GetScreenContext $cmd }
            "get-foreground-window" { Cmd-GetForegroundWindow }
            "focus-window"          { Cmd-FocusWindow $cmd }
            "find-element"          { Cmd-FindElement $cmd }
            "invoke-element"        { Cmd-InvokeElement $cmd }
            "get-focused-element"   { Cmd-GetFocusedElement }
            "ping"                  { @{ pong=$true } }
            default                 { @{ error="Unknown command: $($cmd.cmd)" } }
        }
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 50 -Compress))
    } catch {
        [Console]::Out.WriteLine((@{ error=$_.Exception.Message } | ConvertTo-Json -Compress))
    }
    [Console]::Out.Flush()
}
