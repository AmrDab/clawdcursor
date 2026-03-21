# Clawd Cursor Installer for Windows
# Usage: powershell -c "irm https://clawdcursor.com/install.ps1 | iex"

$ErrorActionPreference = "Stop"
$VERSION = "v0.7.2"
$INSTALL_DIR = "$HOME\clawdcursor"

Write-Host ""
Write-Host "  /\___/\" -ForegroundColor Green
Write-Host " ( >^.^< )  Clawd Cursor Installer" -ForegroundColor Green
Write-Host "  )     (" -ForegroundColor Green
Write-Host " (_)_(_)_)" -ForegroundColor Green
Write-Host ""

# 1. Check Node.js
try {
    $nodeVersion = (node --version 2>$null)
    if (-not $nodeVersion) { throw "not found" }
    $major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
    if ($major -lt 20) {
        Write-Host "  Node.js $nodeVersion found, but v20+ is required." -ForegroundColor Red
        Write-Host "  Download: https://nodejs.org" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "  Node.js $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  Node.js not found. Install it first:" -ForegroundColor Red
    Write-Host "  https://nodejs.org (v20 or later)" -ForegroundColor Yellow
    exit 1
}

# 2. Check git
try {
    $gitVersion = (git --version 2>$null)
    if (-not $gitVersion) { throw "not found" }
    Write-Host "  $gitVersion" -ForegroundColor Green
} catch {
    Write-Host "  git not found. Install it first:" -ForegroundColor Red
    Write-Host "  https://git-scm.com" -ForegroundColor Yellow
    exit 1
}

# 3. Remove old install if exists
if (Test-Path $INSTALL_DIR) {
    Write-Host ""
    Write-Host "  Existing installation found at $INSTALL_DIR" -ForegroundColor Yellow
    Write-Host "  Removing old version..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $INSTALL_DIR
}

# 4. Clone
Write-Host ""
Write-Host "  Downloading Clawd Cursor $VERSION..." -ForegroundColor Cyan
git clone https://github.com/AmrDab/clawdcursor.git --branch $VERSION $INSTALL_DIR --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Clone failed. Check your internet connection." -ForegroundColor Red
    exit 1
}

# 5. Install dependencies
Write-Host "  Installing dependencies..." -ForegroundColor Cyan
Push-Location $INSTALL_DIR
npm install --loglevel error 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  npm install failed." -ForegroundColor Red
    Pop-Location
    exit 1
}

# 6. Build and link
Write-Host "  Building..." -ForegroundColor Cyan
npm run setup 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Build failed. Try running manually:" -ForegroundColor Red
    Write-Host "    cd $INSTALL_DIR; npm run build; npm link --force" -ForegroundColor Yellow
    Pop-Location
    exit 1
}
Pop-Location

# 7. Verify
try {
    $ver = (clawdcursor --version 2>$null)
    Write-Host ""
    Write-Host "  Clawd Cursor $ver installed successfully!" -ForegroundColor Green
} catch {
    Write-Host ""
    Write-Host "  Installed to $INSTALL_DIR" -ForegroundColor Green
    Write-Host "  Note: 'clawdcursor' command may require reopening your terminal." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Get started:" -ForegroundColor White
Write-Host "    clawdcursor start        Launch the agent" -ForegroundColor Gray
Write-Host "    clawdcursor doctor       Configure AI providers" -ForegroundColor Gray
Write-Host "    clawdcursor mcp          Run as MCP server" -ForegroundColor Gray
Write-Host ""
