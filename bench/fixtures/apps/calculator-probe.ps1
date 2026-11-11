# Reads the display and the expression of the Windows Calculator through UI Automation and prints them:
#   display Display is 4,183
#   expression Expression is 47 x 89=
# Read-only: it looks at Calculator's window and nothing else. Exit 1 when no Calculator window has a display.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$auto = [System.Windows.Automation.AutomationElement]
$display = New-Object System.Windows.Automation.PropertyCondition($auto::AutomationIdProperty, 'CalculatorResults')
$expression = New-Object System.Windows.Automation.PropertyCondition($auto::AutomationIdProperty, 'CalculatorExpression')
$windows = $auto::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($w in $windows) {
  if ($w.Current.Name -notlike '*Calculator*') { continue }
  $el = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $display)
  if ($el) {
    Write-Output ('display ' + $el.Current.Name)
    $ex = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $expression)
    if ($ex) { Write-Output ('expression ' + $ex.Current.Name) }
    exit 0
  }
}
exit 1
