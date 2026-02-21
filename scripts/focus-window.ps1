<#
.SYNOPSIS
    Focuses (brings to front) a window by title substring or process ID.
    Uses UI Automation WindowPattern.SetWindowVisualState + SetFocus.
.PARAMETER Title
    Substring match against window titles (case-insensitive).
.PARAMETER ProcessId
    Exact process ID to focus.
.PARAMETER Restore
    If true, restore from minimized state before focusing.
#>
param(
    [string]$Title = "",
    [int]$ProcessId = 0,
    [switch]$Restore
)

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    [Console]::Out.Write((@{ success = $false; error = "Failed to load UI Automation assemblies: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    exit 1
}

$ErrorActionPreference = 'Stop'

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window
    )
    $allWindows = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        $windowCondition
    )

    $targetWindow = $null

    if ($ProcessId -gt 0) {
        foreach ($win in $allWindows) {
            try {
                if ($win.Current.ProcessId -eq $ProcessId) {
                    $targetWindow = $win
                    break
                }
            } catch {}
        }
    } elseif ($Title -ne "") {
        $titleLower = $Title.ToLower()
        foreach ($win in $allWindows) {
            try {
                $winTitle = $win.Current.Name
                if ($winTitle -and $winTitle.ToLower().Contains($titleLower)) {
                    $targetWindow = $win
                    break
                }
            } catch {}
        }
    } else {
        [Console]::Out.Write((@{ success = $false; error = "Must specify -Title or -ProcessId" } | ConvertTo-Json -Compress))
        exit 0
    }

    if ($null -eq $targetWindow) {
        [Console]::Out.Write((@{ success = $false; error = "Window not found matching Title='$Title' ProcessId=$ProcessId" } | ConvertTo-Json -Compress))
        exit 0
    }

    # Restore from minimized if needed
    try {
        $winPattern = $targetWindow.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
        $state = $winPattern.Current.WindowVisualState
        if ($state -eq [System.Windows.Automation.WindowVisualState]::Minimized) {
            $winPattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
            Start-Sleep -Milliseconds 200
        }
    } catch {
        # WindowPattern may not be available
    }

    # Set focus
    try {
        $targetWindow.SetFocus()
    } catch {
        # Fallback: try using Win32 SetForegroundWindow
        Add-Type @"
            using System;
            using System.Runtime.InteropServices;
            public class Win32Focus {
                [DllImport("user32.dll")]
                public static extern bool SetForegroundWindow(IntPtr hWnd);
                [DllImport("user32.dll")]
                public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
            }
"@
        $hwnd = [IntPtr]$targetWindow.Current.NativeWindowHandle
        [Win32Focus]::ShowWindow($hwnd, 9) | Out-Null # SW_RESTORE
        Start-Sleep -Milliseconds 100
        [Win32Focus]::SetForegroundWindow($hwnd) | Out-Null
    }

    $c = $targetWindow.Current
    [Console]::Out.Write((@{
        success     = $true
        title       = $c.Name
        processId   = $c.ProcessId
        handle      = $c.NativeWindowHandle
    } | ConvertTo-Json -Compress))

} catch {
    [Console]::Out.Write((@{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
