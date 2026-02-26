# Apply Clawd Cursor performance optimizations
# Usage: .\apply-optimizations.ps1 -ProjectRoot <path-to-clawd-cursor>
#
# Creates .orig backups before modifying any file.
# Run `npx tsc --noEmit` after to verify.

param(
    [Parameter(Mandatory=$true)]
    [string]$ProjectRoot
)

$srcDir = Join-Path $ProjectRoot "src"
$sandboxDir = Join-Path $ProjectRoot "sandbox-perf"

if (-not (Test-Path $sandboxDir)) {
    Write-Error "sandbox-perf/ directory not found. Generate optimized files first."
    exit 1
}

$files = @("ai-brain.ts", "agent.ts", "vnc-client.ts", "accessibility.ts")

foreach ($f in $files) {
    $src = Join-Path $srcDir $f
    $opt = Join-Path $sandboxDir $f
    $bak = "$src.orig"

    if (-not (Test-Path $opt)) {
        Write-Warning "Skipping $f — not found in sandbox-perf/"
        continue
    }

    if (-not (Test-Path $bak)) {
        Copy-Item $src $bak
        Write-Host "[BACKUP] $f -> $f.orig"
    }

    Copy-Item $opt $src -Force
    Write-Host "[APPLIED] $f"
}

Write-Host "`nVerifying build..."
Push-Location $ProjectRoot
npx tsc --noEmit
if ($LASTEXITCODE -eq 0) {
    Write-Host "`n[OK] All optimizations applied. Build clean."
} else {
    Write-Error "`n[FAIL] Build errors detected. Check output above."
}
Pop-Location
