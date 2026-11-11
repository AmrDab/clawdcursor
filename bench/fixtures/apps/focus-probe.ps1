# Says which process has the keyboard focus, for the benchmark's privacy guard. It reads process ids and, for a Store
# app frame, the frame's title: no text of any window is read.
#
# Output:
#   chain <pid> <parent pid> <grandparent pid> ...     the focused element's process and its ancestors
#   frame <pid> <pid> ...                              only when the focus is in an ApplicationFrameHost window: the
#   title <text>                                       processes hosted in that frame, and the frame's exact title
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$auto = [System.Windows.Automation.AutomationElement]
$el = $auto::FocusedElement
if (-not $el) { exit 1 }
$focusPid = $el.Current.ProcessId

$chain = @()
$p = $focusPid
while ($p -and $chain.Count -lt 12 -and ($chain -notcontains $p)) {
  $chain += $p
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
  if (-not $proc) { break }
  $p = $proc.ParentProcessId
}
Write-Output ("chain " + ($chain -join ' '))

# A Store app's window belongs to ApplicationFrameHost; the app's own process owns the CoreWindow inside it.
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$top = $el
while ($true) {
  $parent = $walker.GetParent($top)
  if (-not $parent -or $parent -eq $auto::RootElement) { break }
  $top = $parent
}
if ($top.Current.ClassName -eq 'ApplicationFrameWindow') {
  $hosted = @{}
  foreach ($c in $top.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $hosted[$c.Current.ProcessId] = $true
  }
  Write-Output ("frame " + ($hosted.Keys -join ' '))
  Write-Output ("title " + $top.Current.Name)
}
