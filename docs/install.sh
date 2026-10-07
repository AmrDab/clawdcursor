#!/bin/bash
# Clawd Cursor Installer for macOS / Linux
# Usage: curl -fsSL https://clawdcursor.com/install.sh | bash
# Specify version: VERSION=v1.5.14 curl -fsSL https://clawdcursor.com/install.sh | bash
#
# Installs the published npm package globally (npm i -g clawdcursor) — no git
# clone, no local build toolchain. On macOS the package's postinstall builds
# and ad-hoc-signs the native helper from source automatically (needs the Xcode
# command-line tools; the install continues and tells you how to finish if not).

set -e
set -o pipefail

# VERSION maps to an npm dist-tag/version. The old git-branch default ("main")
# and a leading "v" both normalise to npm's "latest"/"x.y.z" form.
VERSION="${VERSION:-latest}"
case "$VERSION" in
  main|latest|"") PKG="clawdcursor@latest"; DISPLAY_VERSION="latest" ;;
  *)              PKG="clawdcursor@${VERSION#v}"; DISPLAY_VERSION="${VERSION#v}" ;;
esac

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

# ── 2. Install from npm ──────────────────────────────────────────────────────
echo "  📦 Installing $PKG (global)..."
if ! npm install -g "$PKG" --loglevel error; then
    echo ""
    echo "  ❌ npm install failed."
    echo "     If it was a permissions (EACCES) error, either:"
    echo "       • set a user-writable npm prefix:  npm config set prefix ~/.npm-global"
    echo "         then add ~/.npm-global/bin to your PATH and re-run, or"
    echo "       • re-run with elevated privileges:  sudo npm install -g $PKG"
    exit 1
fi

# ── 3. macOS native helper note ──────────────────────────────────────────────
# The npm postinstall already built + ad-hoc-signed the helper. TCC permissions
# still need a human click; `clawdcursor grant` walks you through them.
if [ "$(uname)" = "Darwin" ]; then
    echo "  🍎 macOS: grant Accessibility + Screen Recording when prompted —"
    echo "     run:  clawdcursor grant"
fi

# ── 4. Verify ─────────────────────────────────────────────────────────────────
echo ""
if command -v clawdcursor &>/dev/null; then
    echo "  ✅ Clawd Cursor $(clawdcursor --version 2>/dev/null || echo "$DISPLAY_VERSION") installed!"
else
    NPM_PREFIX="$(npm prefix -g 2>/dev/null)/bin"
    echo "  ✅ Installed, but npm's global bin folder isn't on your PATH."
    echo "     Add this to your shell profile (~/.bashrc or ~/.zshrc):"
    echo "       export PATH=\"$NPM_PREFIX:\$PATH\""
    echo "     then reopen your terminal."
fi

# ── 5. Next steps ──────────────────────────────────────────────────────────────
# Detect prior consent (known path) so repeat installs don't re-prompt for it.
CONSENT_FILE="$HOME/.clawdcursor/consent"

echo ""
if [ ! -f "$CONSENT_FILE" ]; then
    echo "  Start here:"
    echo "    clawdcursor consent     One-time desktop-control authorization"
else
    echo "  [OK] Consent already accepted from a previous install."
fi
echo ""
echo "  Then pick a path:"
echo ""
echo "    Autonomous agent (clawdcursor brings the AI brain):"
echo "      1. clawdcursor doctor   Configure AI provider + models"
echo "      2. clawdcursor agent    Start the daemon (HTTP + MCP on :3847)"
echo ""
echo "    MCP-only (your editor brings the AI brain):"
echo "      • Claude Code: install the plugin (bundles the MCP server + skill,"
echo "        no hand-edited config) — see the README's plugin section."
echo "      • Cursor / Windsurf / Zed: register \`clawdcursor mcp --compact\`."
echo "      No daemon, no API key in clawdcursor — your editor handles both."
echo ""
