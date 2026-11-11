# Reads the display of the Windows Calculator through UI Automation and prints it ("Display is 4,183").
# Read-only: it looks at Calculator's window and nothing else. Exit 1 when no Calculator window has a display.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$auto = [System.Windows.Automation.AutomationElement]
$display = New-Object System.Windows.Automation.PropertyCondition($auto::AutomationIdProperty, 'CalculatorResults')
$windows = $auto::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($w in $windows) {
  if ($w.Current.Name -notlike '*Calculator*') { continue }
  $el = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $display)
  if ($el) { Write-Output $el.Current.Name; exit 0 }
}
exit 1
