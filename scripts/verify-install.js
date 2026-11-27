#!/usr/bin/env node
/**
 * verify-install.js — Lightweight post-install verification.
 *
 * Checks Node.js version and critical native dependencies.
 * Runs after `npm install` and before `npm run setup`.
 * Non-blocking: prints warnings but never fails the install.
 */

const MIN_NODE_MAJOR = 20;

function check() {
  let ok = true;

  // ── Node.js version check ──
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < MIN_NODE_MAJOR) {
    console.error(`\n❌ Node.js ${MIN_NODE_MAJOR}+ required (found ${process.versions.node})`);
    console.error(`   Download: https://nodejs.org/\n`);
    process.exit(1); // Hard fail — nothing will work
  }
  console.log(`✅ Node.js ${process.versions.node}`);

  // ── Critical native dependencies ──
  const deps = [
    { name: '@nut-tree-fork/nut-js', label: 'nut-js (desktop automation)' },
    { name: 'sharp', label: 'sharp (image processing)' },
  ];

  for (const dep of deps) {
    try {
      require(dep.name);
      console.log(`✅ ${dep.label}`);
    } catch (err) {
      ok = false;
      console.warn(`⚠️  ${dep.label} — failed to load`);
      if (process.platform === 'win32') {
        console.warn(`   Fix: npm install --global windows-build-tools`);
        console.warn(`   Or: Install Visual C++ Build Tools from https://visualstudio.microsoft.com/visual-cpp-build-tools/`);
      } else if (process.platform === 'darwin') {
        console.warn(`   Fix: xcode-select --install`);
      } else {
        console.warn(`   Fix: sudo apt-get install build-essential libx11-dev`);
      }
    }
  }

  // ── Optional dependencies ──
  try {
    require('playwright-core');
    console.log(`✅ playwright-core (browser automation)`);
  } catch {
    console.warn(`⚠️  playwright-core — not installed (browser/CDP features will be limited)`);
    console.warn(`   Fix: npm install -g clawdcursor (reinstall)`);
  }

  // ── macOS native build check ──
  if (process.platform === 'darwin') {
    const path = require('path');
    const fs = require('fs');
    const appDir = path.join(__dirname, '..', 'native', 'ClawdCursor.app', 'Contents', 'MacOS');
    const requiredBinaries = ['ClawdCursorHost', 'clawdcursor-helper', 'screenshot-helper', 'permission-check'];
    const missing = requiredBinaries.filter(b => !fs.existsSync(path.join(appDir, b)));
    if (missing.length > 0) {
      console.warn(`⚠️  Native macOS binaries not built: ${missing.join(', ')}`);
      console.warn(`   Fix: cd native && chmod +x build.sh && ./build.sh`);
      ok = false;
    } else {
      console.log(`✅ Native macOS binaries (ClawdCursor.app)`);
    }
  }

  if (ok) {
    console.log(`\n🐾 All dependencies verified. Run: npm run setup\n`);
  } else {
    console.warn(`\n⚠️  Some dependencies have issues. clawdcursor may still work with reduced functionality.`);
    console.warn(`   Run: npm run setup\n`);
  }
}

check();
