#!/bin/bash
# Clawd Cursor Installer for macOS / Linux
# Usage: curl -fsSL https://clawdcursor.com/install.sh | bash

set -e

VERSION="v0.7.2"
INSTALL_DIR="$HOME/clawdcursor"

echo ""
echo "  /\___/\\"
echo " ( >^.^< )  Clawd Cursor Installer"
echo "  )     ("
echo " (_)_(_)_)"
echo ""

# ── 1. Check Node.js ─────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
    echo "  ❌ Node.js not found. Install v20+ from https://nodejs.org"
    exit 1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "  ❌ Node.js $(node --version) is too old. Update to v20+: https://nodejs.org"
    exit 1
fi
echo "  ✅ Node.js $(node --version)"

# ── 2. Check git ──────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
    echo "  ❌ git not found. Install: brew install git (macOS) or sudo apt install git (Linux)"
    exit 1
fi
echo "  ✅ $(git --version)"

# ── 3. Clone or update ───────────────────────────────────────────────────────
echo ""
if [ -d "$INSTALL_DIR/.git" ]; then
    # Update existing install
    echo "  📦 Updating to $VERSION..."
    cd "$INSTALL_DIR"
    git fetch --tags --quiet 2>/dev/null
    git checkout "$VERSION" --quiet 2>/dev/null || {
        echo "  ⚠️  Update failed, doing fresh install..."
        cd "$HOME"
        rm -rf "$INSTALL_DIR"
        git clone https://github.com/AmrDab/clawdcursor.git --branch "$VERSION" "$INSTALL_DIR" --quiet
    }
elif [ -d "$INSTALL_DIR" ]; then
    # Corrupted — no .git, remove and reclone
    rm -rf "$INSTALL_DIR"
    echo "  📦 Downloading $VERSION..."
    git clone https://github.com/AmrDab/clawdcursor.git --branch "$VERSION" "$INSTALL_DIR" --quiet
else
    echo "  📦 Downloading $VERSION..."
    git clone https://github.com/AmrDab/clawdcursor.git --branch "$VERSION" "$INSTALL_DIR" --quiet
fi

# ── 4. Install dependencies ──────────────────────────────────────────────────
echo "  📦 Installing dependencies..."
cd "$INSTALL_DIR"
npm install --loglevel error 2>/dev/null

# ── 5. Build ──────────────────────────────────────────────────────────────────
echo "  🔨 Building..."
npm run build 2>/dev/null

# ── 6. Link ───────────────────────────────────────────────────────────────────
echo "  🔗 Linking..."
npm link --force 2>/dev/null || true

# ── 7. Verify ─────────────────────────────────────────────────────────────────
echo ""
if command -v clawdcursor &>/dev/null; then
    echo "  ✅ Clawd Cursor $(clawdcursor --version 2>/dev/null || echo $VERSION) installed!"
else
    NPM_PREFIX="$(npm prefix -g 2>/dev/null)/bin"
    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$NPM_PREFIX"; then
        echo "  ✅ Installed, but npm's bin folder is not in your PATH."
        echo "     Add this to your shell profile (~/.bashrc or ~/.zshrc):"
        echo "       export PATH=\"$NPM_PREFIX:\$PATH\""
    else
        echo "  ✅ Installed! Reopen your terminal to use 'clawdcursor'."
    fi
fi

echo ""
echo "  Quick start:"
echo "    clawdcursor start     Launch the agent (auto-configures on first run)"
echo ""
