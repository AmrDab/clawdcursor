<#
.SYNOPSIS
    Finds a UI element and invokes an action on it using UIA Patterns.
.PARAMETER AutomationId
    Find the element by AutomationId (exact match).
.PARAMETER Name
    Find the element by Name (exact match). Used if AutomationId is not specified.
.PARAMETER ControlType
    Optional. Filter by ControlType to narrow the search (e.g. "Button", "Edit").
.PARAMETER ProcessId
    Required. The process ID of the target window.
.PARAMETER Action
    The action to perform: "click", "set-value", "get-value", "focus", "expand", "collapse", "toggle", "select".
.PARAMETER Value
    The value to set (only used with "set-value" action).
#>
param(
    [string]$AutomationId = "",
    [string]$Name = "",
    [string]$ControlType = "",
    [Parameter(Mandatory=$true)]
    [int]$ProcessId,
    [Parameter(Mandatory=$true)]
    [ValidateSet("click", "set-value", "get-value", "focus", "expand", "collapse", "toggle", "select")]
    [string]$Action,
    [string]$Value = ""
)

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    [Console]::Out.Write((@{ success = $false; error = "Failed to load UI Automation assemblies: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    exit 1
}

$ErrorActionPreference = 'Stop'

# Control type mapping
$ctMap = @{
    "Button"      = [System.Windows.Automation.ControlType]::Button
    "CheckBox"    = [System.Windows.Automation.ControlType]::CheckBox
    "ComboBox"    = [System.Windows.Automation.ControlType]::ComboBox
    "Custom"      = [System.Windows.Automation.ControlType]::Custom
    "DataItem"    = [System.Windows.Automation.ControlType]::DataItem
    "Document"    = [System.Windows.Automation.ControlType]::Document
    "Edit"        = [System.Windows.Automation.ControlType]::Edit
    "Group"       = [System.Windows.Automation.ControlType]::Group
    "Hyperlink"   = [System.Windows.Automation.ControlType]::Hyperlink
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

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    # Find the target window
    $procCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $ProcessId
    )
    $window = $root.FindFirst(
        [System.Windows.Automation.TreeScope]::Children,
        $procCondition
    )

    if ($null -eq $window) {
        [Console]::Out.Write((@{ success = $false; error = "No window found for ProcessId $ProcessId" } | ConvertTo-Json -Compress))
        exit 0
    }

    # Build condition (without name — fuzzy name matching done below)
    $conditions = @()
    if ($AutomationId -ne "") {
        $conditions += New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $AutomationId
        )
    }
    if ($ControlType -ne "" -and $ctMap.ContainsKey($ControlType)) {
        $conditions += New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ctMap[$ControlType]
        )
    }
    if ($conditions.Count -eq 0 -and $Name -eq "") {
        [Console]::Out.Write((@{ success = $false; error = "Must specify at least -AutomationId or -Name" } | ConvertTo-Json -Compress))
        exit 0
    }

    $searchCondition = if ($conditions.Count -eq 0) { [System.Windows.Automation.Condition]::TrueCondition }
        elseif ($conditions.Count -eq 1) { $conditions[0] }
        else { New-Object System.Windows.Automation.AndCondition([System.Windows.Automation.Condition[]]$conditions) }

    $element = $null

    # Fast path: exact automationId match
    if ($AutomationId -ne "" -and $conditions.Count -gt 0) {
        $element = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $searchCondition)
    }

    # Fuzzy name match: strip keyboard shortcut suffix ("Save\tCtrl+S" → "save")
    if ($null -eq $element -and $Name -ne "") {
        $nameLower = $Name.ToLower()
        $candidates = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $searchCondition)
        # First pass: exact stripped match
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
        $searchDesc = ""
        if ($AutomationId -ne "") { $searchDesc += "AutomationId='$AutomationId' " }
        if ($Name -ne "") { $searchDesc += "Name='$Name' " }
        if ($ControlType -ne "") { $searchDesc += "ControlType='$ControlType' " }
        [Console]::Out.Write((@{ success = $false; error = "Element not found: $($searchDesc.Trim())" } | ConvertTo-Json -Compress))
        exit 0
    }

    # Execute the requested action
    switch ($Action) {
        "click" {
            # Try InvokePattern first, then fall back to SetFocus + boundary click info
            try {
                $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                $pattern.Invoke()
                [Console]::Out.Write((@{ success = $true; action = "click"; method = "InvokePattern" } | ConvertTo-Json -Compress))
            } catch {
                # If InvokePattern not supported, try TogglePattern (for checkboxes)
                try {
                    $togglePattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                    $togglePattern.Toggle()
                    [Console]::Out.Write((@{ success = $true; action = "click"; method = "TogglePattern" } | ConvertTo-Json -Compress))
                } catch {
                    # Last resort: report bounds so caller can click by coordinates
                    $rect = $element.Current.BoundingRectangle
                    $clickX = [int]($rect.X + $rect.Width / 2)
                    $clickY = [int]($rect.Y + $rect.Height / 2)
                    [Console]::Out.Write((@{
                        success  = $false
                        action   = "click"
                        error    = "No InvokePattern or TogglePattern supported. Use coordinate click."
                        clickPoint = @{ x = $clickX; y = $clickY }
                    } | ConvertTo-Json -Depth 5 -Compress))
                }
            }
        }
        "set-value" {
            if ($Value -eq "") {
                [Console]::Out.Write((@{ success = $false; error = "Value parameter required for set-value action" } | ConvertTo-Json -Compress))
                exit 0
            }
            try {
                $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                $pattern.SetValue($Value)
                [Console]::Out.Write((@{ success = $true; action = "set-value"; value = $Value } | ConvertTo-Json -Compress))
            } catch {
                [Console]::Out.Write((@{ success = $false; error = "ValuePattern not supported on this element: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
            }
        }
        "get-value" {
            try {
                $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                $val = $pattern.Current.Value
                [Console]::Out.Write((@{ success = $true; action = "get-value"; value = $val } | ConvertTo-Json -Compress))
            } catch {
                # Try TextPattern as fallback
                try {
                    $textPattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                    $range = $textPattern.DocumentRange
                    $val = $range.GetText(-1)
                    [Console]::Out.Write((@{ success = $true; action = "get-value"; value = $val; method = "TextPattern" } | ConvertTo-Json -Compress))
                } catch {
                    # Last resort: return the element's Name
                    $val = $element.Current.Name
                    [Console]::Out.Write((@{ success = $true; action = "get-value"; value = $val; method = "NameProperty" } | ConvertTo-Json -Compress))
                }
            }
        }
        "focus" {
            try {
                $element.SetFocus()
                [Console]::Out.Write((@{ success = $true; action = "focus" } | ConvertTo-Json -Compress))
            } catch {
                [Console]::Out.Write((@{ success = $false; error = "Failed to set focus: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
            }
        }
        "expand" {
            try {
                $pattern = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
                $pattern.Expand()
                [Console]::Out.Write((@{ success = $true; action = "expand" } | ConvertTo-Json -Compress))
            } catch {
                [Console]::Out.Write((@{ success = $false; error = "ExpandCollapsePattern not supported: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
            }
        }
        "collapse" {
            try {
                $pattern = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
                $pattern.Collapse()
                [Console]::Out.Write((@{ success = $true; action = "collapse" } | ConvertTo-Json -Compress))
            } catch {
                [Console]::Out.Write((@{ success = $false; error = "ExpandCollapsePattern not supported: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
            }
        }
        "toggle" {
            try {
                $pattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                $pattern.Toggle()
                $state = $pattern.Current.ToggleState.ToString()
                [Console]::Out.Write((@{ success = $true; action = "toggle"; toggleState = $state } | ConvertTo-Json -Compress))
            } catch {
                [Console]::Out.Write((@{ success = $false; error = "TogglePattern not supported: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
            }
        }
        "select" {
            try {
                $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                $pattern.Select()
                [Console]::Out.Write((@{ success = $true; action = "select" } | ConvertTo-Json -Compress))
            } catch {
                [Console]::Out.Write((@{ success = $false; error = "SelectionItemPattern not supported: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
            }
        }
    }
} catch {
    [Console]::Out.Write((@{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
