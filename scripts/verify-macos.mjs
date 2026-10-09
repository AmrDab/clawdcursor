#!/usr/bin/env node
// macOS verification for the warm-OCR / accessibility-wake changes.
// Run from the repo root after `npm ci && npm run build`:
//   node scripts/verify-macos.mjs                 # auto-detects a running Electron app
//   node scripts/verify-macos.mjs --app "Slack"   # or name one (System Events process name)
// Prints a PASS / FAIL / SKIP line per check and writes verify-macos-report.json.
// Read-only apart from: compiling the OCR helper into ~/.clawdcursor/bin and a temp dir,
// and setting AXManualAccessibility on the tested app (resets when the app quits).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') { console.error('verify-macos: run this on a Mac.'); process.exit(1); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const dist = p => path.join(ROOT, 'dist', p);
if (!fs.existsSync(dist('platform/ocr-engine.js'))) { console.error('verify-macos: run `npm ci && npm run build` first.'); process.exit(1); }

const results = [];
const line = (status, name, detail = '') => { results.push({ status, name, detail }); console.log(`${status.padEnd(4)} ${name}${detail ? ' — ' + detail : ''}`); };
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const jxa = code => sh('osascript', ['-l', 'JavaScript', '-e', code]);
const ms = t0 => Date.now() - t0;
const appArg = (() => { const i = process.argv.indexOf('--app'); return i > 0 ? process.argv[i + 1] : undefined; })();

// ── 0. environment ────────────────────────────────────────────────────────────
const env = { macos: sh('sw_vers', ['-productVersion']), arch: os.arch(), node: process.version };
try { env.swiftc = sh('swiftc', ['--version']).split('\n')[0]; } catch { env.swiftc = null; }
try { env.accessibility = jxa("ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()") === 'true'; } catch { env.accessibility = null; }
try { env.screenRecording = jxa("ObjC.import('CoreGraphics'); $.CGPreflightScreenCaptureAccess()") === 'true'; } catch { env.screenRecording = null; }
console.log(`macOS ${env.macos} ${env.arch} · node ${env.node} · ${env.swiftc ?? 'NO swiftc (xcode-select --install)'}`);
console.log(`permissions for this terminal: Accessibility=${env.accessibility} · Screen Recording=${env.screenRecording}\n`);

const { compileMacOcrBinary, resetMacOcrBinaryState } = require(dist('platform/mac-ocr-binary.js'));
const { OcrEngine } = require(dist('platform/ocr-engine.js'));
const { getUiTreeWithWake, resetWakeState } = require(dist('platform/a11y-wake.js'));
const sharp = require('sharp');
const SCRIPT = path.join(ROOT, 'scripts', 'mac', 'ocr-recognize.swift');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-verify-'));

// ── 1. compile the Vision OCR helper (fresh, in a temp dir) ──────────────────
let bin = null;
if (!env.swiftc) line('FAIL', 'compile OCR helper', 'swiftc missing — install Xcode Command Line Tools');
else {
  resetMacOcrBinaryState();
  const t0 = Date.now(); bin = await compileMacOcrBinary(SCRIPT, path.join(tmp, 'bin'));
  line(bin ? 'PASS' : 'FAIL', 'compile OCR helper (swiftc -O)', bin ? `${ms(t0)} ms` : 'compile failed');
}

// ── 2. OCR accuracy + speed on an image with known text ───────────────────────
const KNOWN = ['Order ID', 'ord_Ko4WnlI1O0', 'Total', '$29.99', 'Status', 'cancelled', 'Alpha', 'Bravo', 'Submit', 'Row 001', 'Row 002', 'Settings'];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="520"><rect width="100%" height="100%" fill="white"/>
  <g font-family="Helvetica, Arial, sans-serif" font-size="26" fill="#111">
  <text x="40" y="60">Order ID: ord_Ko4WnlI1O0</text><text x="40" y="110">Total: $29.99</text><text x="40" y="160">Status: cancelled</text>
  <text x="40" y="240">Alpha</text><text x="200" y="240">Bravo</text><text x="360" y="240">Submit</text>
  <text x="40" y="320">Row 001</text><text x="40" y="370">Row 002</text><text x="40" y="450" font-size="16">Settings</text></g></svg>`;
const img = path.join(tmp, 'known.png');
await sharp(Buffer.from(svg)).png().toFile(img);
const score = data => { const b = (data.elements || []).map(e => e.text).join(' ').toLowerCase().replace(/\s+/g, ''); return KNOWN.filter(k => b.includes(k.toLowerCase().replace(/\s+/g, ''))); };
let interpreted = null;
try {
  const t0 = Date.now(); interpreted = JSON.parse(sh('swift', [SCRIPT, img])); const t = ms(t0);
  const hit = score(interpreted);
  line(interpreted.error ? 'FAIL' : 'PASS', 'old path: interpreted `swift ocr-recognize.swift`', `${t} ms · ${hit.length}/${KNOWN.length} known strings`);
} catch (e) { line('FAIL', 'old path: interpreted swift script', String(e.message).slice(0, 160)); }
if (bin) {
  const times = []; let data;
  for (let i = 0; i < 3; i++) { const t0 = Date.now(); data = JSON.parse(sh(bin, [img])); times.push(ms(t0)); }
  const hit = score(data);
  line(!data.error && hit.length >= KNOWN.length - 2 ? 'PASS' : 'FAIL', 'new path: compiled binary', `${times.join('/')} ms · ${hit.length}/${KNOWN.length} known strings${hit.length < KNOWN.length ? ' (missed: ' + KNOWN.filter(k => !hit.includes(k)).join(', ') + ')' : ''}`);
  if (interpreted && !interpreted.error) {
    const same = JSON.stringify(interpreted.elements) === JSON.stringify(data.elements);
    line(same ? 'PASS' : 'FAIL', 'compiled binary output == interpreted script output', same ? 'identical' : 'differs');
  }
}

// ── 3. the real engine on the live screen (needs Screen Recording) ────────────
if (!env.screenRecording) line('SKIP', 'live screen OCR', 'grant Screen Recording to this terminal app, then re-run');
else try {
  const e = new OcrEngine(); const runs = [];
  for (let i = 0; i < 2; i++) { e.invalidateCache(); const t0 = Date.now(); const r = await e.recognizeScreen(); runs.push(`${ms(t0)} ms/${r.elements.length} words`); }
  // the first read compiles the cached helper in the background — wait for it, then read warm
  const cached = await compileMacOcrBinary(SCRIPT);
  const warm = []; for (let i = 0; i < 2; i++) { e.invalidateCache(); const t0 = Date.now(); const r = await e.recognizeScreen(); warm.push(`${ms(t0)} ms/${r.elements.length} words`); }
  line(cached ? 'PASS' : 'FAIL', 'live screen OCR: cold → warm', `cold ${runs.join(', ')} · warm ${warm.join(', ')}${cached ? '' : ' (cached helper did not build)'}`);
} catch (err) { line('FAIL', 'live screen OCR', String(err.message).slice(0, 160)); }

// ── 4. the AXManualAccessibility script ───────────────────────────────────────
const frontPid = (() => { try { return Number(sh('osascript', ['-e', 'tell application "System Events" to unix id of first process whose frontmost is true'])); } catch { return 0; } })();
try {
  const out = JSON.parse(sh('osascript', ['-l', 'JavaScript', path.join(ROOT, 'scripts', 'mac', 'enable-accessibility.jxa'), String(frontPid)]));
  line(typeof out.ok === 'boolean' ? 'PASS' : 'FAIL', 'enable-accessibility.jxa runs', `frontmost pid ${frontPid} → ${JSON.stringify(out)}${out.axError === -25211 ? ' (no Accessibility permission for this terminal)' : ''}`);
} catch (err) { line('FAIL', 'enable-accessibility.jxa runs', String(err.message).slice(0, 160)); }

// ── 5. sleeping Electron tree: raw read vs. read-with-wake ────────────────────
const CANDIDATES = appArg ? [appArg] : ['Code', 'Slack', 'Discord', 'Claude', 'Notion', 'Obsidian', 'Cursor', 'Microsoft Teams', 'Figma', 'Postman', 'Spotify'];
let target = null;
for (const name of CANDIDATES) {
  try { const pid = Number(sh('osascript', ['-e', `tell application "System Events" to unix id of process "${name}"`])); if (pid > 0) { target = { name, pid }; break; } } catch { /* not running */ }
}
if (!env.accessibility) line('SKIP', 'Electron wake', 'grant Accessibility to this terminal app, then re-run');
else if (!target) line('SKIP', 'Electron wake', `no Electron app running — open one (e.g. VS Code, Slack, Claude) or pass --app "<name>"`);
else try {
  const { MacOSAdapter } = require(dist('platform/macos.js'));
  const a = new MacOSAdapter();
  const raw = await a.getUiTree(target.pid).catch(() => []);
  resetWakeState();
  const t0 = Date.now(); const w = await getUiTreeWithWake(a, target.pid); const t = ms(t0);
  const after = await a.getUiTree(target.pid).catch(() => []);
  const verdict = raw.length >= 10 ? 'PASS' : (w.tree.length > raw.length ? 'PASS' : 'FAIL');
  line(verdict, `Electron wake (${target.name}, pid ${target.pid})`, `raw read ${raw.length} els → with wake ${w.tree.length} els in ${t} ms (woke=${w.woke}) → plain re-read ${after.length} els${raw.length >= 10 ? ' — tree was already awake (another assistive app may have woken it); quit and reopen the app to test from cold' : ''}`);
} catch (err) { line('FAIL', 'Electron wake', String(err.message).slice(0, 160)); }

// ── 6. the macOS-only unit tests ──────────────────────────────────────────────
try {
  const out = sh('npx', ['vitest', 'run', 'src/__tests__/mac-ocr-binary.test.ts', 'src/__tests__/a11y-wake.test.ts'], { cwd: ROOT, timeout: 600_000 });
  const m = /Tests\s+(.*)/.exec(out); line('PASS', 'macOS-only unit tests', m ? m[1].replace(/\x1b\[[0-9;]*m/g, '') : 'passed');
} catch (err) { const o = String(err.stdout || err.message); line('FAIL', 'macOS-only unit tests', (o.match(/FAIL.*|×.*/g) || [o.slice(-300)]).slice(0, 3).join(' | ').replace(/\x1b\[[0-9;]*m/g, '')); }

const report = { env, results, at: new Date().toISOString() };
fs.writeFileSync(path.join(ROOT, 'verify-macos-report.json'), JSON.stringify(report, null, 2));
const n = s => results.filter(r => r.status === s).length;
console.log(`\n${n('PASS')} passed · ${n('FAIL')} failed · ${n('SKIP')} skipped — paste verify-macos-report.json (or this output) back to Claude.`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(n('FAIL') ? 1 : 0);
