<#
.SYNOPSIS
    Lists all visible top-level windows with their properties.
.DESCRIPTION
    Returns a JSON array of all visible, named top-level windows including
    window handle, title, process info, bounds, and minimized state.
#>

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    [Console]::Out.Write((@{ error = "Failed to load UI Automation assemblies: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    exit 1
}

$ErrorActionPreference = 'Stop'

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    # Find all top-level windows (ControlType.Window)
    $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window
    )
    $allWindows = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        $windowCondition
    )

    $results = @()
    foreach ($win in $allWindows) {
        try {
            $c = $win.Current

            # Skip windows with no name (invisible/system windows)
            if (-not $c.Name -or $c.Name.Trim().Length -eq 0) { continue }

            # Get native window handle
            $handle = $c.NativeWindowHandle

            # Get process info
            $processName = ""
            try {
                $proc = [System.Diagnostics.Process]::GetProcessById($c.ProcessId)
                $processName = $proc.ProcessName
            } catch {
                $processName = "unknown"
            }

            # Get bounds
            $rect = $c.BoundingRectangle
            if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y)) {
                $bounds = @{ x = 0; y = 0; width = 0; height = 0 }
            } else {
                $bounds = @{
                    x      = [int]$rect.X
                    y      = [int]$rect.Y
                    width  = [int]$rect.Width
                    height = [int]$rect.Height
                }
            }

            # Check if minimized via WindowPattern
            $isMinimized = $false
            try {
                $winPattern = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
                if ($winPattern.Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized) {
                    $isMinimized = $true
                }
            } catch {
                # WindowPattern not available — assume not minimized
            }

            $results += [ordered]@{
                handle      = $handle
                title       = $c.Name
                processName = $processName
                processId   = $c.ProcessId
                bounds      = $bounds
                isMinimized = $isMinimized
            }
        } catch {
            # Skip windows that throw on property access
        }
    }

    [Console]::Out.Write(($results | ConvertTo-Json -Depth 10 -Compress))
} catch {
    [Console]::Out.Write((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
