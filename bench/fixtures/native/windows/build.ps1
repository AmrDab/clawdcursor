# Builds the Windows native fixture: BenchFixture.cs -> <OutDir>\BenchFixture.exe, with Windows PowerShell's Add-Type.
# Run with powershell.exe (5.1): its Add-Type compiles for .NET Framework, which every Windows has.
param([Parameter(Mandatory = $true)][string]$OutDir)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$exe = Join-Path $OutDir 'BenchFixture.exe'
if (Test-Path $exe) { Remove-Item -Force $exe }
$source = Get-Content -Raw -Path (Join-Path $PSScriptRoot 'BenchFixture.cs')
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms, System.Drawing `
  -OutputAssembly $exe -OutputType WindowsApplication
Write-Output $exe
