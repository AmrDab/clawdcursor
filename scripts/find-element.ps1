<#
.SYNOPSIS
    Searches the UI tree for elements matching given criteria.
.PARAMETER Name
    Match elements whose Name property contains this string (case-insensitive).
.PARAMETER AutomationId
    Match elements whose AutomationId equals this string exactly.
.PARAMETER ControlType
    Match elements whose ControlType ProgrammaticName contains this string
    (e.g. "Button", "Edit", "MenuItem").
.PARAMETER ProcessId
    If specified, only search within the window belonging to this process.
    If omitted, searches all top-level windows.
.PARAMETER MaxResults
    Maximum number of results to return (default 20).
#>
param(
    [string]$Name = "",
    [string]$AutomationId = "",
    [string]$ControlType = "",
    [int]$ProcessId = 0,
    [int]$MaxResults = 20
)

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

    # Determine the search root
    if ($ProcessId -gt 0) {
        $procCondition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
            $ProcessId
        )
        $searchRoot = $root.FindFirst(
            [System.Windows.Automation.TreeScope]::Children,
            $procCondition
        )
        if ($null -eq $searchRoot) {
            [Console]::Out.Write((@{ error = "No window found for ProcessId $ProcessId" } | ConvertTo-Json -Compress))
            exit 0
        }
    } else {
        $searchRoot = $root
    }

    # Build UIA condition for FindAll
    $conditions = @()

    if ($AutomationId -ne "") {
        $conditions += New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
            $AutomationId
        )
    }

    if ($ControlType -ne "") {
        # Map common control type names to ControlType objects
        $ctMap = @{
            "Button"           = [System.Windows.Automation.ControlType]::Button
            "Calendar"         = [System.Windows.Automation.ControlType]::Calendar
            "CheckBox"         = [System.Windows.Automation.ControlType]::CheckBox
            "ComboBox"         = [System.Windows.Automation.ControlType]::ComboBox
            "Custom"           = [System.Windows.Automation.ControlType]::Custom
            "DataGrid"         = [System.Windows.Automation.ControlType]::DataGrid
            "DataItem"         = [System.Windows.Automation.ControlType]::DataItem
            "Document"         = [System.Windows.Automation.ControlType]::Document
            "Edit"             = [System.Windows.Automation.ControlType]::Edit
            "Group"            = [System.Windows.Automation.ControlType]::Group
            "Header"           = [System.Windows.Automation.ControlType]::Header
            "HeaderItem"       = [System.Windows.Automation.ControlType]::HeaderItem
            "Hyperlink"        = [System.Windows.Automation.ControlType]::Hyperlink
            "Image"            = [System.Windows.Automation.ControlType]::Image
            "List"             = [System.Windows.Automation.ControlType]::List
            "ListItem"         = [System.Windows.Automation.ControlType]::ListItem
            "Menu"             = [System.Windows.Automation.ControlType]::Menu
            "MenuBar"          = [System.Windows.Automation.ControlType]::MenuBar
            "MenuItem"         = [System.Windows.Automation.ControlType]::MenuItem
            "Pane"             = [System.Windows.Automation.ControlType]::Pane
            "ProgressBar"      = [System.Windows.Automation.ControlType]::ProgressBar
            "RadioButton"      = [System.Windows.Automation.ControlType]::RadioButton
            "ScrollBar"        = [System.Windows.Automation.ControlType]::ScrollBar
            "Separator"        = [System.Windows.Automation.ControlType]::Separator
            "Slider"           = [System.Windows.Automation.ControlType]::Slider
            "Spinner"          = [System.Windows.Automation.ControlType]::Spinner
            "SplitButton"      = [System.Windows.Automation.ControlType]::SplitButton
            "StatusBar"        = [System.Windows.Automation.ControlType]::StatusBar
            "Tab"              = [System.Windows.Automation.ControlType]::Tab
            "TabItem"          = [System.Windows.Automation.ControlType]::TabItem
            "Table"            = [System.Windows.Automation.ControlType]::Table
            "Text"             = [System.Windows.Automation.ControlType]::Text
            "Thumb"            = [System.Windows.Automation.ControlType]::Thumb
            "TitleBar"         = [System.Windows.Automation.ControlType]::TitleBar
            "ToolBar"          = [System.Windows.Automation.ControlType]::ToolBar
            "ToolTip"          = [System.Windows.Automation.ControlType]::ToolTip
            "Tree"             = [System.Windows.Automation.ControlType]::Tree
            "TreeItem"         = [System.Windows.Automation.ControlType]::TreeItem
            "Window"           = [System.Windows.Automation.ControlType]::Window
        }

        if ($ctMap.ContainsKey($ControlType)) {
            $conditions += New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                $ctMap[$ControlType]
            )
        }
    }

    if ($Name -ne "") {
        $conditions += New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            $Name
        )
    }

    # Combine conditions
    if ($conditions.Count -eq 0) {
        $searchCondition = [System.Windows.Automation.Condition]::TrueCondition
    } elseif ($conditions.Count -eq 1) {
        $searchCondition = $conditions[0]
    } else {
        $searchCondition = New-Object System.Windows.Automation.AndCondition(
            [System.Windows.Automation.Condition[]]$conditions
        )
    }

    # Search descendants
    $scope = [System.Windows.Automation.TreeScope]::Descendants
    if ($ProcessId -eq 0) {
        # If no process specified, only search children to avoid walking the entire desktop tree
        $scope = [System.Windows.Automation.TreeScope]::Subtree
    }

    $elements = $searchRoot.FindAll($scope, $searchCondition)

    $results = @()
    $count = 0
    foreach ($el in $elements) {
        if ($count -ge $MaxResults) { break }
        try {
            $c = $el.Current
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
            $results += [ordered]@{
                name         = if ($c.Name) { $c.Name } else { "" }
                automationId = if ($c.AutomationId) { $c.AutomationId } else { "" }
                controlType  = $c.ControlType.ProgrammaticName
                className    = if ($c.ClassName) { $c.ClassName } else { "" }
                processId    = $c.ProcessId
                isEnabled    = $c.IsEnabled
                bounds       = $bounds
            }
            $count++
        } catch {
            # Skip elements that throw on property access
        }
    }

    [Console]::Out.Write(($results | ConvertTo-Json -Depth 10 -Compress))
} catch {
    [Console]::Out.Write((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
