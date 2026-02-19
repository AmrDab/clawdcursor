<#
.SYNOPSIS
    Gets the UI Automation tree for a window or lists top-level windows.
.PARAMETER ProcessId
    If specified, returns the UI tree for the window belonging to this process.
    If omitted, returns a list of all named top-level windows.
.PARAMETER MaxDepth
    Maximum depth to traverse the UI tree (default 3).
#>
param(
    [int]$ProcessId = 0,
    [int]$MaxDepth = 3
)

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    [Console]::Out.Write((@{ error = "Failed to load UI Automation assemblies: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    exit 1
}

$ErrorActionPreference = 'Stop'

function ConvertTo-UINode {
    param(
        [System.Windows.Automation.AutomationElement]$Element,
        [int]$Depth = 0
    )

    if ($null -eq $Element) { return $null }

    try {
        $cur = $Element.Current
    } catch {
        return $null
    }

    $rect = $cur.BoundingRectangle
    # Skip off-screen / empty elements
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

    $node = [ordered]@{
        name         = if ($cur.Name) { $cur.Name } else { "" }
        automationId = if ($cur.AutomationId) { $cur.AutomationId } else { "" }
        controlType  = $cur.ControlType.ProgrammaticName
        className    = if ($cur.ClassName) { $cur.ClassName } else { "" }
        bounds       = $bounds
        children     = @()
    }

    if ($Depth -lt $MaxDepth) {
        try {
            $kids = $Element.FindAll(
                [System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition
            )
            foreach ($kid in $kids) {
                $childNode = ConvertTo-UINode -Element $kid -Depth ($Depth + 1)
                if ($null -ne $childNode) {
                    $node.children += $childNode
                }
            }
        } catch {
            # Silently skip inaccessible children
        }
    }

    return $node
}

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    if ($ProcessId -gt 0) {
        # Find the window for this process
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
            $ProcessId
        )
        $targetWindow = $root.FindFirst(
            [System.Windows.Automation.TreeScope]::Children,
            $condition
        )

        if ($null -eq $targetWindow) {
            [Console]::Out.Write((@{ error = "No window found for ProcessId $ProcessId" } | ConvertTo-Json -Compress))
            exit 0
        }

        $tree = ConvertTo-UINode -Element $targetWindow -Depth 0
        [Console]::Out.Write(($tree | ConvertTo-Json -Depth 50 -Compress))
    } else {
        # List all named top-level windows
        $allWindows = $root.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition
        )

        $result = @()
        foreach ($win in $allWindows) {
            try {
                $c = $win.Current
                if ($c.Name -and $c.Name.Trim().Length -gt 0) {
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
                    $result += [ordered]@{
                        name         = $c.Name
                        processId    = $c.ProcessId
                        automationId = if ($c.AutomationId) { $c.AutomationId } else { "" }
                        className    = if ($c.ClassName) { $c.ClassName } else { "" }
                        bounds       = $bounds
                    }
                }
            } catch {
                # Skip windows that throw on property access
            }
        }
        [Console]::Out.Write(($result | ConvertTo-Json -Depth 10 -Compress))
    }
} catch {
    [Console]::Out.Write((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
