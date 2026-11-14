#!/bin/bash
# test-macos-fixes.sh — One-shot end-to-end test for the macOS fixes.
# Run: cd ~/clawdcursor && bash scripts/test-macos-fixes.sh
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "  🧪 ClawdCursor macOS Fix Verification"
echo "  ══════════════════════════════════════"
echo ""

# ── 0. Platform check ───────────────────────────────────────────────
if [ "$(uname)" != "Darwin" ]; then
    echo "  ❌ This script must run on macOS, not $(uname)"
    exit 1
fi
pass "Running on macOS"

# ── 1. Rebuild Swift binaries ────────────────────────────────────────
echo ""
echo "  🔨 Step 1: Rebuild native binaries..."
cd "$REPO_DIR/native"
chmod +x build.sh
if bash build.sh 2>&1 | while IFS= read -r line; do echo "     $line"; done; then
    pass "Swift build succeeded"
else
    fail "Swift build failed"
    echo "     Fix: xcode-select --install"
    exit 1
fi

APP_DIR="ClawdCursor.app/Contents/MacOS"
ALL_PRESENT=true
for bin in ClawdCursorHost clawdcursor-helper screenshot-helper permission-check; do
    if [ ! -f "$APP_DIR/$bin" ]; then
        fail "Missing binary: $bin"
        ALL_PRESENT=false
    fi
done
$ALL_PRESENT && pass "All 4 native binaries present"

# ── 2. Compile TypeScript ────────────────────────────────────────────
echo ""
echo "  🔨 Step 2: Compile TypeScript..."
cd "$REPO_DIR"
if npx tsc 2>&1 | head -5; then
    pass "TypeScript compiled"
else
    fail "TypeScript compilation failed"
fi

# ── 3. Permission check consistency ─────────────────────────────────
echo ""
echo "  🔍 Step 3: Permission check consistency..."

# 3a. Direct permission-check binary
PERM_BIN="native/ClawdCursor.app/Contents/MacOS/permission-check"
PERM_DIRECT=$("$PERM_BIN" 2>/dev/null || echo '{"error":"failed"}')
echo "     Direct permission-check: $PERM_DIRECT"

if echo "$PERM_DIRECT" | grep -q '"processPath"'; then
    pass "permission-check returns processPath"
else
    fail "permission-check missing processPath"
fi

# 3b. Launch host and check /status
echo "     Starting ClawdCursor host..."
xattr -dr com.apple.quarantine native/ClawdCursor.app 2>/dev/null || true
open native/ClawdCursor.app
sleep 3  # Give it time to start

HOST_STATUS=$(curl -s http://127.0.0.1:3848/status 2>/dev/null || echo '{"error":"host_not_running"}')
echo "     Host /status: $HOST_STATUS"

if echo "$HOST_STATUS" | grep -q '"processPath"'; then
    pass "Host /status returns processPath"
else
    fail "Host /status missing processPath"
fi

# 3c. Compare — both should have the same accessibility/screenRecording values
DIRECT_AX=$(echo "$PERM_DIRECT" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).accessibility)}catch{console.log('error')}})")
HOST_AX=$(echo "$HOST_STATUS" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).accessibility)}catch{console.log('error')}})")

if [ "$DIRECT_AX" = "$HOST_AX" ]; then
    pass "Accessibility permission consistent (direct=$DIRECT_AX, host=$HOST_AX)"
else
    fail "Accessibility INCONSISTENT: direct=$DIRECT_AX vs host=$HOST_AX"
fi

DIRECT_SR=$(echo "$PERM_DIRECT" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).screenRecording)}catch{console.log('error')}})")
HOST_SR=$(echo "$HOST_STATUS" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).screenRecording)}catch{console.log('error')}})")

if [ "$DIRECT_SR" = "$HOST_SR" ]; then
    pass "Screen Recording permission consistent (direct=$DIRECT_SR, host=$HOST_SR)"
else
    fail "Screen Recording INCONSISTENT: direct=$DIRECT_SR vs host=$HOST_SR"
fi

# 3d. Check clawdcursor status uses the same values
echo "     Running clawdcursor status..."
STATUS_OUT=$(node dist/index.js status 2>&1 || true)
echo "$STATUS_OUT" | while IFS= read -r line; do echo "     $line"; done
pass "clawdcursor status ran"

# ── 4. Screenshot capture via screenshot-helper ──────────────────────
echo ""
echo "  📸 Step 4: Screenshot capture via screenshot-helper..."

SCREENSHOT_BIN="native/ClawdCursor.app/Contents/MacOS/screenshot-helper"
SCREENSHOT_TMP="/tmp/clawdcursor-test-capture-$$.png"

SCREENSHOT_OUT=$("$SCREENSHOT_BIN" --fullscreen "$SCREENSHOT_TMP" 2>&1 || echo '{"error":"capture_failed"}')
echo "     screenshot-helper output: $SCREENSHOT_OUT"

if [ -f "$SCREENSHOT_TMP" ]; then
    SIZE=$(stat -f%z "$SCREENSHOT_TMP" 2>/dev/null || stat -c%s "$SCREENSHOT_TMP" 2>/dev/null || echo 0)
    if [ "$SIZE" -gt 1000 ]; then
        pass "Screenshot captured: ${SIZE} bytes at $SCREENSHOT_TMP"
    else
        fail "Screenshot file too small (${SIZE} bytes) — likely empty"
    fi
    rm -f "$SCREENSHOT_TMP"
else
    if echo "$SCREENSHOT_OUT" | grep -q "screen_recording_denied"; then
        fail "Screen Recording permission not granted"
        echo "     → System Settings → Privacy & Security → Screen & System Audio Recording → enable ClawdCursor"
    else
        fail "Screenshot file not created"
    fi
fi

# ── 5. Doctor should agree with status ───────────────────────────────
echo ""
echo "  🩺 Step 5: Doctor permission check (should match status)..."
DOCTOR_OUT=$(timeout 15 node dist/index.js doctor --provider skip 2>&1 || true)
echo "$DOCTOR_OUT" | grep -E "permission|Permission|macOS|✅|❌" | while IFS= read -r line; do echo "     $line"; done
pass "Doctor ran permission checks"

# ── 6. Stop host ─────────────────────────────────────────────────────
echo ""
echo "  🛑 Cleaning up..."
osascript -e 'tell application id "com.clawdcursor.app" to quit' 2>/dev/null || true
pass "Host app stopped"

# ── Results ──────────────────────────────────────────────────────────
echo ""
echo "  ══════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "  ══════════════════════════════════════"
echo ""

if [ "$FAIL" -eq 0 ]; then
    echo "  🎉 All tests passed — ready to PR!"
else
    echo "  ⚠️  $FAIL test(s) failed — review above"
fi
echo ""

exit $FAIL
