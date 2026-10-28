#!/usr/bin/env node
/**
 * macOS-only postinstall step (issue #149).
 *
 * The published npm package ships the Swift SOURCES for the native helper
 * but not a prebuilt binary. Without the binary, screenshots / display
 * enumeration / TCC permission checks all fail. This script builds the
 * helper from the shipped sources on a fresh `npm i -g clawdcursor` so a
 * Mac user gets a working install out of the box.
 *
 * Best-effort by design: it NEVER fails the install. If the Xcode toolchain
 * (`swift`) is absent, it prints actionable guidance and exits 0 — the
 * runtime emits the same guidance the first time a screenshot is needed.
 *
 * No-op on Windows/Linux.
 */
'use strict';
const { execFileSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

if (process.platform !== 'darwin') process.exit(0);

const root = path.join(__dirname, '..');
const nativeDir = path.join(root, 'native');
const buildSh = path.join(nativeDir, 'build.sh');

// Dev checkouts / odd layouts: if sources aren't present, there's nothing to do.
if (!fs.existsSync(buildSh)) process.exit(0);

// Is the Swift toolchain available?
try {
  execSync('command -v swift', { stdio: 'ignore', shell: '/bin/bash' });
} catch {
  console.log('[clawdcursor] Native macOS helper not built — Xcode Command Line Tools (swift) not found.');
  console.log('             Screenshots, display enumeration, and permission checks need it.');
  console.log('             Install the tools, then build:  xcode-select --install  &&  cd "' + nativeDir + '" && ./build.sh');
  process.exit(0);
}

try {
  console.log('[clawdcursor] Building native macOS helper from source (native/build.sh)…');
  execFileSync('/bin/bash', [buildSh], { stdio: 'inherit', cwd: nativeDir });
  console.log('[clawdcursor] Native macOS helper built.');
} catch (_e) {
  console.log('[clawdcursor] Native macOS helper build failed (non-fatal). Build manually with: cd "' + nativeDir + '" && ./build.sh');
}
process.exit(0);
