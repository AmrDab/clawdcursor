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
    require('playwright');
    console.log(`✅ playwright (browser automation)`);
  } catch {
    console.warn(`⚠️  playwright — not installed (browser/CDP features will be limited)`);
    console.warn(`   Fix: npx playwright install chromium`);
  }

  if (ok) {
    console.log(`\n🐾 All dependencies verified. Run: npm run setup\n`);
  } else {
    console.warn(`\n⚠️  Some dependencies have issues. clawdcursor may still work with reduced functionality.`);
    console.warn(`   Run: npm run setup\n`);
  }
}

check();
