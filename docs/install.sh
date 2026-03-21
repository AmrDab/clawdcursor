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

# 1. Check Node.js
if ! command -v node &>/dev/null; then
    echo "  ❌ Node.js not found. Install it first:"
    echo "     https://nodejs.org (v20 or later)"
    echo "     or: brew install node  (macOS)"
    echo "     or: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs  (Debian/Ubuntu)"
    exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "  ❌ Node.js v$(node --version) found, but v20+ is required."
    echo "     Download: https://nodejs.org"
    exit 1
fi
echo "  ✅ Node.js $(node --version)"

# 2. Check git
if ! command -v git &>/dev/null; then
    echo "  ❌ git not found. Install it first:"
    echo "     macOS: xcode-select --install"
    echo "     Linux: sudo apt install git"
    exit 1
fi
echo "  ✅ $(git --version)"

# 3. Remove old install if exists
if [ -d "$INSTALL_DIR" ]; then
    echo ""
    echo "  ⚠️  Existing installation found at $INSTALL_DIR"
    echo "  Removing old version..."
    rm -rf "$INSTALL_DIR"
fi

# 4. Clone
echo ""
echo "  📦 Downloading Clawd Cursor $VERSION..."
git clone https://github.com/AmrDab/clawdcursor.git --branch "$VERSION" "$INSTALL_DIR" --quiet

# 5. Install dependencies
echo "  📦 Installing dependencies..."
cd "$INSTALL_DIR"
npm install --loglevel error 2>/dev/null

# 6. Build and link
echo "  🔨 Building..."
npm run setup 2>/dev/null

# 7. Verify
echo ""
if command -v clawdcursor &>/dev/null; then
    echo "  ✅ Clawd Cursor $(clawdcursor --version 2>/dev/null || echo $VERSION) installed successfully!"
else
    echo "  ✅ Installed to $INSTALL_DIR"
    echo "  ⚠️  'clawdcursor' command may require reopening your terminal."
fi

echo ""
echo "  Get started:"
echo "    clawdcursor start        Launch the agent"
echo "    clawdcursor doctor       Configure AI providers"
echo "    clawdcursor mcp          Run as MCP server"
echo ""
