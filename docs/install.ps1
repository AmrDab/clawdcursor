# Clawd Cursor Installer for Windows
# Usage: powershell -c "iex (iwr -useb https://clawdcursor.com/install.ps1).Content"

$ErrorActionPreference = "Continue"
$VERSION = "v0.7.2"
$INSTALL_DIR = "$HOME\clawdcursor"

Write-Host ""
Write-Host "  /\___/\" -ForegroundColor Green
Write-Host " ( >^.^< )  Clawd Cursor Installer" -ForegroundColor Green
Write-Host "  )     (" -ForegroundColor Green
Write-Host " (_)_(_)_)" -ForegroundColor Green
Write-Host ""

# ── 1. Check Node.js ─────────────────────────────────────────────────────────
$nodeVersion = $null
try { $nodeVersion = (node --version 2>$null) } catch {}
if (-not $nodeVersion) {
    Write-Host "  [X] Node.js not found. Get it from https://nodejs.org (v20+)" -ForegroundColor Red
    exit 1
}
$major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
if ($major -lt 20) {
    Write-Host "  [X] Node.js $nodeVersion is too old. Update to v20+: https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] Node.js $nodeVersion" -ForegroundColor Green

# ── 2. Check git ──────────────────────────────────────────────────────────────
$gitVer = $null
try { $gitVer = (git --version 2>$null) } catch {}
if (-not $gitVer) {
    Write-Host "  [X] git not found. Get it from https://git-scm.com" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] $gitVer" -ForegroundColor Green

# ── 3. Clone or update ───────────────────────────────────────────────────────
Write-Host ""
if (Test-Path "$INSTALL_DIR\.git") {
    # Update existing install
    Write-Host "  Updating to $VERSION..." -ForegroundColor Cyan
    Push-Location $INSTALL_DIR
    git fetch --tags --quiet 2>&1 | Out-Null
    git checkout $VERSION --quiet 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Update failed, doing fresh install..." -ForegroundColor Yellow
        Pop-Location; Set-Location $HOME
        Remove-Item -Recurse -Force $INSTALL_DIR 2>$null
        git clone https://github.com/AmrDab/clawdcursor.git --branch $VERSION $INSTALL_DIR --quiet 2>&1 | Out-Null
    } else {
        Pop-Location
    }
} else {
    # Fresh install (remove corrupted dir if exists)
    if (Test-Path $INSTALL_DIR) {
        Set-Location $HOME
        Remove-Item -Recurse -Force $INSTALL_DIR 2>$null
    }
    Write-Host "  Downloading $VERSION..." -ForegroundColor Cyan
    git clone https://github.com/AmrDab/clawdcursor.git --branch $VERSION $INSTALL_DIR --quiet 2>&1 | Out-Null
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [X] Download failed. Check your internet and try again." -ForegroundColor Red
    exit 1
}

# ── 4. Install dependencies ──────────────────────────────────────────────────
Write-Host "  Installing dependencies..." -ForegroundColor Cyan
Push-Location $INSTALL_DIR
$output = npm install --loglevel error 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [X] npm install failed. Run manually: cd $INSTALL_DIR; npm install" -ForegroundColor Red
    Pop-Location; exit 1
}

# ── 5. Build ──────────────────────────────────────────────────────────────────
Write-Host "  Building..." -ForegroundColor Cyan
$output = npm run build 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [X] Build failed. Run manually: cd $INSTALL_DIR; npm run build" -ForegroundColor Red
    Pop-Location; exit 1
}

# ── 6. Link (with pre-cleanup to avoid EEXIST) ───────────────────────────────
Write-Host "  Linking..." -ForegroundColor Cyan
$npmPrefix = (npm prefix -g 2>$null)
if ($npmPrefix) {
    $npmPrefix = $npmPrefix.Trim()
    # Remove old shims — prevents EEXIST errors on re-install
    foreach ($ext in @('', '.cmd', '.ps1')) {
        $shimPath = "$npmPrefix\clawdcursor$ext"
        if (Test-Path $shimPath) { Remove-Item -Force $shimPath 2>$null }
    }
    # Remove old junction safely (cmd rmdir won't follow into target)
    $junctionPath = "$npmPrefix\node_modules\clawdcursor"
    if (Test-Path $junctionPath) {
        cmd /c "rmdir `"$junctionPath`"" 2>$null
    }
}
$output = npm link --force 2>&1 | Out-String
Pop-Location

# ── 7. Verify ─────────────────────────────────────────────────────────────────
# Refresh PATH so we can find the newly linked command
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

$exe = Get-Command clawdcursor -ErrorAction SilentlyContinue
Write-Host ""
if ($exe) {
    $ver = & clawdcursor --version 2>$null
    Write-Host "  [OK] Clawd Cursor $ver installed!" -ForegroundColor Green
} else {
    # Diagnose: is npm prefix in PATH?
    if ($npmPrefix) {
        $inPath = $env:Path -split ';' | Where-Object { $_ -eq $npmPrefix }
        if (-not $inPath) {
            Write-Host "  [OK] Installed, but npm's bin folder is not in your PATH." -ForegroundColor Yellow
            Write-Host "       Add this to your system PATH, then reopen your terminal:" -ForegroundColor Yellow
            Write-Host "       $npmPrefix" -ForegroundColor White
        } else {
            Write-Host "  [OK] Installed! Close and reopen your terminal to use 'clawdcursor'." -ForegroundColor Green
        }
    } else {
        Write-Host "  [OK] Installed to $INSTALL_DIR" -ForegroundColor Green
        Write-Host "       Reopen your terminal to use 'clawdcursor'." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "  Quick start:" -ForegroundColor White
Write-Host "    clawdcursor start     Launch the agent (auto-configures on first run)" -ForegroundColor Gray
Write-Host ""
