# Clawd Cursor Installer for Windows
# Usage: powershell -c "irm https://clawdcursor.com/install.ps1 | iex"
# Specify version: $env:VERSION='v1.5.19'; irm https://clawdcursor.com/install.ps1 | iex
#
# Installs the published npm package globally (npm i -g clawdcursor) -- no git
# clone, no local build toolchain. Windows needs no native build step.

$ErrorActionPreference = "Continue"

# VERSION maps to an npm dist-tag/version. The old git-branch default ("main")
# and a leading "v" both normalise to npm's "latest"/"x.y.z" form.
$VERSION = if ($env:VERSION) { $env:VERSION } else { "latest" }
if ($VERSION -in @("main", "latest", "")) {
    $PKG = "clawdcursor@latest"; $DISPLAY_VERSION = "latest"
} else {
    $clean = $VERSION -replace '^v', ''
    $PKG = "clawdcursor@$clean"; $DISPLAY_VERSION = $clean
}

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

# ── 2. Install from npm (updates an existing global copy in place) ───────────
# The version already installed, so we can say "updated X -> Y" afterwards.
$before = $null
try {
    $ls = npm ls -g clawdcursor --depth=0 --json 2>$null | Out-String | ConvertFrom-Json
    $before = $ls.dependencies.clawdcursor.version
} catch {}

# Windows refuses to replace files a running process has open (EBUSY): an
# editor or Claude session that has clawdcursor running blocks the update.
# Only processes running from the global copy hold its files open.
$globalDir = $null
try { $globalDir = (Join-Path (npm prefix -g 2>$null).Trim() 'node_modules\clawdcursor').ToLower() } catch {}
$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $globalDir -and $_.CommandLine -and $_.CommandLine.Replace('/', '\').ToLower().Contains($globalDir) })
if ($before -and $running.Count -gt 0) {
    Write-Host "  [!] clawdcursor is running in $($running.Count) session(s) (your editor or Claude app)." -ForegroundColor Yellow
    Write-Host "      If the update fails with EBUSY, close those sessions or run 'clawdcursor stop', then re-run this." -ForegroundColor Yellow
}

Write-Host "  Installing $PKG (global)..." -ForegroundColor Cyan
$output = npm install -g $PKG --loglevel error 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [X] npm install failed:" -ForegroundColor Red
    foreach ($line in ($output -split "`r?`n" | Where-Object { $_ })) { Write-Host "      $line" }
    if ($output -match 'EBUSY|EPERM') {
        Write-Host "      A running clawdcursor has its files open. Close the editor / Claude sessions using it" -ForegroundColor Yellow
        Write-Host "      (or run 'clawdcursor stop'), then re-run this command." -ForegroundColor Yellow
    } else {
        Write-Host "      Retry in an elevated terminal, or set a user-writable npm prefix." -ForegroundColor Yellow
    }
    exit 1
}

# ── 3. Verify ─────────────────────────────────────────────────────────────────
# Refresh PATH so we can find the newly installed command this session.
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
$npmPrefix = (npm prefix -g 2>$null)
if ($npmPrefix) { $npmPrefix = $npmPrefix.Trim() }

$exe = Get-Command clawdcursor -ErrorAction SilentlyContinue
Write-Host ""
if ($exe) {
    $ver = (& clawdcursor --version 2>$null | Select-Object -Last 1)
    if (-not $before) {
        Write-Host "  [OK] Clawd Cursor $ver installed!" -ForegroundColor Green
    } elseif ($before -eq $ver) {
        Write-Host "  [OK] Clawd Cursor $ver is already the latest (reinstalled)." -ForegroundColor Green
    } else {
        Write-Host "  [OK] Clawd Cursor updated: $before -> $ver" -ForegroundColor Green
        Write-Host "       Restart any editor or Claude session that uses clawdcursor so it picks up $ver." -ForegroundColor Gray
    }
    # The installer only updates this global copy. The Claude Desktop extension
    # and the Claude Code plugin carry their own: list them so old ones show.
    Write-Host ""
    Write-Host "  Copies of clawdcursor on this machine:" -ForegroundColor Cyan
    & clawdcursor versions 2>$null
} elseif ($npmPrefix -and (-not ($env:Path -split ';' | Where-Object { $_ -eq $npmPrefix }))) {
    Write-Host "  [OK] Installed, but npm's bin folder is not in your PATH." -ForegroundColor Yellow
    Write-Host "       Add this to your PATH, then reopen your terminal:" -ForegroundColor Yellow
    Write-Host "       $npmPrefix" -ForegroundColor White
} else {
    Write-Host "  [OK] Installed! Close and reopen your terminal to use 'clawdcursor'." -ForegroundColor Green
}

# ── 4. Next steps ──────────────────────────────────────────────────────────────
# Detect prior consent (known path) so repeat installs don't re-prompt for it.
$consentGiven = Test-Path "$HOME\.clawdcursor\consent"

Write-Host ""
if (-not $consentGiven) {
    Write-Host "  Start here:" -ForegroundColor Cyan
    Write-Host "    clawdcursor consent     " -NoNewline -ForegroundColor Yellow
    Write-Host "One-time desktop-control authorization" -ForegroundColor Gray
} else {
    Write-Host "  [OK] Consent already accepted from a previous install." -ForegroundColor Green
}
Write-Host ""
Write-Host "  Then pick a path:" -ForegroundColor Cyan
Write-Host ""
Write-Host "    Autonomous agent" -NoNewline -ForegroundColor White
Write-Host " (clawdcursor brings the AI brain):" -ForegroundColor Gray
Write-Host "      1. clawdcursor doctor   " -NoNewline -ForegroundColor Yellow
Write-Host "Configure AI provider + models" -ForegroundColor Gray
Write-Host "      2. clawdcursor agent    " -NoNewline -ForegroundColor Yellow
Write-Host "Start the daemon (HTTP + MCP on :3847)" -ForegroundColor Gray
Write-Host ""
Write-Host "    MCP-only" -NoNewline -ForegroundColor White
Write-Host " (your editor brings the AI brain):" -ForegroundColor Gray
Write-Host "      - Claude Code: install the plugin (bundles the MCP server + skill," -ForegroundColor Gray
Write-Host "        no hand-edited config) -- see the README's plugin section." -ForegroundColor Gray
Write-Host "      - Cursor / Windsurf / Zed: register " -NoNewline -ForegroundColor Gray
Write-Host "clawdcursor mcp --compact" -ForegroundColor Yellow
Write-Host "      No daemon, no API key in clawdcursor -- your editor handles both." -ForegroundColor Gray
Write-Host ""
