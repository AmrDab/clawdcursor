#!/usr/bin/env node
// macOS verification on a real Mac: Retina coordinate scale (#154), the warm OCR
// path, the accessibility wake, the accessibility helper (window list / active
// window / tree), the macOS-only unit tests, and the on-screen
// overlay (glow + pill, pause for the user — interactive, last).
// Run from the repo root after `npm ci && npm run build`:
//   node scripts/verify-macos.mjs                 # auto-detects a running Electron app
//   node scripts/verify-macos.mjs --app "Slack"   # or name one (System Events process name)
// Prints a PASS / FAIL / SKIP line per check and writes verify-macos-report.json.
// Read-only apart from: compiling the OCR helper and the overlay into ~/.clawdcursor/bin,
// helpers into a temp dir, and setting AXManualAccessibility on the tested app (resets
// when the app quits).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowListVerdict } from './verify-macos-checks.mjs';

if (process.platform !== 'darwin') { console.error('verify-macos: run this on a Mac.'); process.exit(1); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const dist = p => path.join(ROOT, 'dist', p);
if (!fs.existsSync(dist('platform/ocr-engine.js')) || !fs.existsSync(dist('platform/mac-screen.js'))) { console.error('verify-macos: run `npm ci && npm run build` first.'); process.exit(1); }

const results = [];
const line = (status, name, detail = '') => { results.push({ status, name, detail }); console.log(`${status.padEnd(4)} ${name}${detail ? ' — ' + detail : ''}`); };
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const jxa = code => sh('osascript', ['-l', 'JavaScript', '-e', code]);
const ms = t0 => Date.now() - t0;
const sleep = t => new Promise(r => setTimeout(r, t));
const appArg = (() => { const i = process.argv.indexOf('--app'); return i > 0 ? process.argv[i + 1] : undefined; })();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-verify-'));
const NATIVE = path.join(ROOT, 'native', 'ClawdCursor.app', 'Contents', 'MacOS');
const PERMISSION_CHECK = path.join(NATIVE, 'permission-check');
const SCREENSHOT_HELPER = path.join(NATIVE, 'screenshot-helper');

// ── 0. environment ────────────────────────────────────────────────────────────
const env = { macos: sh('sw_vers', ['-productVersion']), arch: os.arch(), node: process.version };
try { env.swiftc = sh('swiftc', ['--version']).split('\n')[0]; } catch { env.swiftc = null; }
try { env.accessibility = jxa("ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()") === 'true'; } catch { env.accessibility = null; }
// Screen Recording: JXA does not bridge CGPreflightScreenCaptureAccess (the old probe
// threw and reported "not granted" on Macs that have the permission). Ask the native
// helper; otherwise try an actual capture. null = could not tell.
try { env.screenRecording = JSON.parse(sh(PERMISSION_CHECK, [])).screenRecording === true; }
catch {
  try { const p = path.join(tmp, 'probe.png'); sh(SCREENSHOT_HELPER, ['--fullscreen', p]); env.screenRecording = fs.statSync(p).size > 1000; }
  catch { env.screenRecording = null; }
}
console.log(`macOS ${env.macos} ${env.arch} · node ${env.node} · ${env.swiftc ?? 'NO swiftc (xcode-select --install)'}`);
console.log(`permissions for this terminal: Accessibility=${env.accessibility} · Screen Recording=${env.screenRecording}\n`);

const { compileMacOcrBinary, resetMacOcrBinaryState } = require(dist('platform/mac-ocr-binary.js'));
const { OcrEngine } = require(dist('platform/ocr-engine.js'));
const { getUiTreeWithWake, wakeAccessibility, resetWakeState } = require(dist('platform/a11y-wake.js'));
const { MacOSAdapter } = require(dist('platform/macos.js'));
const { readMainScreenInfo } = require(dist('platform/mac-screen.js'));
const sharp = require('sharp');
const SCRIPT = path.join(ROOT, 'scripts', 'mac', 'ocr-recognize.swift');
const AX_COUNT_SCRIPT = path.join(ROOT, 'scripts', 'mac', 'ax-node-count.swift');

// ── 1. Retina geometry (#154): logical vs physical, and the mouse scale that follows ──
try {
  const main = await readMainScreenInfo();
  const a = new MacOSAdapter(); await a.init();            // locates the helper binaries; no permission prompts
  const size = await a.getScreenSize();
  const mouseScale = size.logicalWidth / 1280, physicalScale = size.physicalWidth / 1280;
  const ok = !!main && size.logicalWidth === main.logicalWidth && Math.abs(size.dpiRatio - main.backingScaleFactor) < 0.01;
  line(ok ? 'PASS' : 'FAIL', 'Retina geometry (#154)',
    `${size.physicalWidth}×${size.physicalHeight} physical / ${size.logicalWidth}×${size.logicalHeight} logical · dpiRatio ${size.dpiRatio}`
    + ` (NSScreen backingScaleFactor ${main?.backingScaleFactor ?? 'unreadable'}) → mouse scale ${mouseScale.toFixed(2)}`
    + (size.dpiRatio > 1 ? ` (physical/1280 would be ${physicalScale.toFixed(2)}: the #154 symptom)` : ''));
  const displays = await a.listDisplays();
  const d0 = displays[0];
  const dok = displays.length >= 1 && d0.primary && d0.bounds.width === size.logicalWidth && Math.abs(d0.dpiRatio - size.dpiRatio) < 0.01;
  line(dok ? 'PASS' : 'FAIL', 'listDisplays', displays.map(d => `#${d.index} ${d.bounds.width}×${d.bounds.height} @${d.bounds.x},${d.bounds.y} ×${d.dpiRatio}${d.primary ? ' primary' : ''}`).join(' · '));
  // The input driver's own ratio (what OCR → screen-coordinate conversion divides by).
  // It lived behind an early return on the helper path, so it stayed 1 on every Mac.
  if (env.screenRecording === true) {
    const { NativeDesktop } = require(dist('platform/native-desktop.js'));
    const nd = new NativeDesktop({ capture: { format: 'jpeg', quality: 70 } });
    await nd.connect();
    const ratio = nd.getDpiRatio();
    const rok = Math.abs(ratio - size.dpiRatio) < 0.01;
    line(rok ? 'PASS' : 'FAIL', 'NativeDesktop dpiRatio (OCR → screen coordinates)', `getDpiRatio() = ${ratio}${rok ? '' : ` — expected ${size.dpiRatio}: OCR reports physical pixels as screen coordinates`}`);
  }
} catch (err) { line('FAIL', 'Retina geometry (#154)', String(err.message).slice(0, 160)); }

// ── 2. compile the Vision OCR helper (fresh, in a temp dir) ──────────────────
let bin = null;
if (!env.swiftc) line('FAIL', 'compile OCR helper', 'swiftc missing — install Xcode Command Line Tools');
else {
  resetMacOcrBinaryState();
  const t0 = Date.now(); bin = await compileMacOcrBinary(SCRIPT, path.join(tmp, 'bin'));
  line(bin ? 'PASS' : 'FAIL', 'compile OCR helper (swiftc -O)', bin ? `${ms(t0)} ms` : 'compile failed');
}

// ── 3. OCR accuracy + speed on an image with known text ───────────────────────
const KNOWN = ['Order ID', 'ord_Ko4WnlI1O0', 'Total', '$29.99', 'Status', 'cancelled', 'Alpha', 'Bravo', 'Submit', 'Row 001', 'Row 002', 'Settings'];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="520"><rect width="100%" height="100%" fill="white"/>
  <g font-family="Helvetica, Arial, sans-serif" font-size="26" fill="#111">
  <text x="40" y="60">Order ID: ord_Ko4WnlI1O0</text><text x="40" y="110">Total: $29.99</text><text x="40" y="160">Status: cancelled</text>
  <text x="40" y="240">Alpha</text><text x="200" y="240">Bravo</text><text x="360" y="240">Submit</text>
  <text x="40" y="320">Row 001</text><text x="40" y="370">Row 002</text><text x="40" y="450" font-size="16">Settings</text></g></svg>`;
const img = path.join(tmp, 'known.png');
await sharp(Buffer.from(svg)).png().toFile(img);
const score = data => { const b = (data.elements || []).map(e => e.text).join(' ').toLowerCase().replace(/\s+/g, ''); return KNOWN.filter(k => b.includes(k.toLowerCase().replace(/\s+/g, ''))); };
// Compare what matters (words, boxes, confidence), not raw JSON: a Swift dictionary
// serializes its keys in a random order per process.
const canon = els => (els || []).map(e => [e.text, e.x, e.y, e.width, e.height, e.confidence, e.line]);
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
    const same = JSON.stringify(canon(interpreted.elements)) === JSON.stringify(canon(data.elements));
    line(same ? 'PASS' : 'FAIL', 'compiled binary output == interpreted script output (words, boxes, confidence)', same ? 'identical' : 'differs');
  }
}

// ── 4. the real engine on the live screen (needs Screen Recording) ────────────
if (env.screenRecording !== true) line('SKIP', 'live screen OCR', env.screenRecording === null ? 'could not determine Screen Recording permission (native helper not built?)' : 'grant Screen Recording to this terminal app, then re-run');
else try {
  const e = new OcrEngine(); const runs = [];
  for (let i = 0; i < 2; i++) { e.invalidateCache(); const t0 = Date.now(); const r = await e.recognizeScreen(); runs.push(`${ms(t0)} ms/${r.elements.length} words`); }
  // the first read compiles the cached helper in the background — wait for it, then read warm
  const cached = await compileMacOcrBinary(SCRIPT);
  const warm = []; for (let i = 0; i < 2; i++) { e.invalidateCache(); const t0 = Date.now(); const r = await e.recognizeScreen(); warm.push(`${ms(t0)} ms/${r.elements.length} words`); }
  line(cached ? 'PASS' : 'FAIL', 'live screen OCR: cold → warm', `cold ${runs.join(', ')} · warm ${warm.join(', ')}${cached ? '' : ' (cached helper did not build)'}`);
} catch (err) { line('FAIL', 'live screen OCR', String(err.message).slice(0, 160)); }

// ── 5. find a running Electron app ───────────────────────────────────────────
const CANDIDATES = appArg ? [appArg] : ['Code', 'Slack', 'Discord', 'Claude', 'Notion', 'Obsidian', 'Cursor', 'Microsoft Teams', 'Figma', 'Postman', 'Spotify'];
let target = null;
for (const name of CANDIDATES) {
  try { const pid = Number(sh('osascript', ['-e', `tell application "System Events" to unix id of process "${name}"`])); if (pid > 0) { target = { name, pid }; break; } } catch { /* not running */ }
}

// ── 6. sleeping Electron tree: did it wake? (AX C API count, independent of the JXA walk) ──
// Runs before the setter check below, which would otherwise wake the app first.
if (!env.accessibility) line('SKIP', 'Electron wake', 'grant Accessibility to this terminal app, then re-run');
else if (!target) line('SKIP', 'Electron wake', `no Electron app running — open one (e.g. VS Code, Slack, Claude) or pass --app "<name>"`);
else try {
  let axNodes = null;
  if (env.swiftc) {
    try { const counter = path.join(tmp, 'ax-node-count'); sh('swiftc', ['-O', AX_COUNT_SCRIPT, '-o', counter]); axNodes = () => JSON.parse(sh(counter, [String(target.pid)])).nodes; } catch { axNodes = null; }
  }
  const DENSE_AX = 50;                                   // a loaded Electron page is hundreds of nodes; a frame alone is well under
  const a = new MacOSAdapter();
  const axBefore = axNodes ? axNodes() : null;
  const raw = await a.getUiTree(target.pid).catch(() => []);
  const asleepBefore = axBefore !== null ? axBefore < DENSE_AX : raw.length < 10;
  let axAfter = axBefore, mechanism = '';
  if (asleepBefore) {
    // The product switch, applied directly, judged by the AX C API three seconds later.
    const t0 = Date.now(); await wakeAccessibility(target.pid); await sleep(3000);
    axAfter = axNodes ? axNodes() : null;
    mechanism = ` · wake: AX nodes ${axBefore ?? '?'} → ${axAfter ?? '?'} after ${ms(t0)} ms`;
  }
  // What the product path sees through the adapter (its thin-tree threshold and JXA walk).
  resetWakeState();
  const t1 = Date.now(); const w = await getUiTreeWithWake(a, target.pid); const t = ms(t1);
  const awake = axAfter !== null ? axAfter >= DENSE_AX : w.tree.length >= 10;
  const note = !asleepBefore ? ' — tree was already awake (another assistive client woke it); quit and reopen the app to test from cold' : awake ? ' — woke' : ' — still asleep after the wake';
  const walkNote = axAfter !== null && awake && w.tree.length < 20 ? ` · NOTE: the JXA/System Events walk reads only ${w.tree.length} of ${axAfter} AX nodes (known limitation)` : '';
  line(awake ? 'PASS' : 'FAIL', `Electron wake (${target.name}, pid ${target.pid})`,
    `AX nodes ${axBefore ?? '?'}${mechanism} · adapter read ${raw.length} → ${w.tree.length} els in ${t} ms (woke=${w.woke})${note}${walkNote}`);
} catch (err) { line('FAIL', 'Electron wake', String(err.message).slice(0, 160)); }

// ── 7. the AXManualAccessibility setter, on its own ───────────────────────────
const frontPid = (() => { try { return Number(sh('osascript', ['-e', 'tell application "System Events" to unix id of first process whose frontmost is true'])); } catch { return 0; } })();
const setPid = target?.pid ?? frontPid;
try {
  const out = JSON.parse(sh('osascript', ['-l', 'JavaScript', path.join(ROOT, 'scripts', 'mac', 'enable-accessibility.jxa'), String(setPid)]));
  const verdict = out.ok || out.axError === -25205 ? 'PASS' : out.axError === -25211 ? 'SKIP' : 'FAIL';
  const why = out.ok ? '' : out.axError === -25205 ? ' (attribute unsupported: not an Electron app — fine)'
    : out.axError === -25211 ? ' (no Accessibility permission for this terminal)'
    : out.axError === -25200 ? ' (kAXErrorFailure — the old $.kCFBooleanTrue bridge bug)' : '';
  line(verdict, 'enable-accessibility.jxa sets AXManualAccessibility', `pid ${setPid}${target ? ` (${target.name})` : ' (frontmost app)'} → ${JSON.stringify(out)}${why}`);
} catch (err) { line('FAIL', 'enable-accessibility.jxa sets AXManualAccessibility', String(err.message).slice(0, 160)); }

// ── 7b. the accessibility helper: window list, active window, tree, system dialogs ──
// The osascript scripts it replaces took 9–10 s for the window list and 12–25 s for a tree,
// past the old 8 s / 12 s timeouts whose errors were reported as "0 windows" / "empty tree".
const { macAxBinary } = require(dist('platform/mac-ocr-binary.js'));
const AX_HELPER = path.join(ROOT, 'scripts', 'mac', 'ax-helper.swift');
{
  const t0 = Date.now();
  macAxBinary.reset();
  const bin = await macAxBinary.compile(AX_HELPER, path.join(tmp, 'bin'));
  line(bin ? 'PASS' : 'FAIL', 'compile ax-helper (scripts/mac/ax-helper.swift)', bin ? `${ms(t0)} ms` : 'compile failed — run: swiftc -O scripts/mac/ax-helper.swift -o /tmp/ax  to see the error');
  if (bin) {
    const ax = args => { const t = Date.now(); const out = JSON.parse(sh(bin, args)); return { out, ms: ms(t) }; };
    const front = ax(['frontmost']);
    const f = front.out.frontmost;
    line(front.out.ok ? 'PASS' : 'FAIL', 'ax-helper frontmost (NSWorkspace)', `${f ? `${f.name} (${f.activationPolicy})` : 'none'} · locked=${front.out.locked} · ${front.ms} ms`);
    if (front.out.locked) {
      for (const c of ['windows', 'active', 'tree']) line('SKIP', `ax-helper ${c}`, 'the screen is locked — unlock it (the AX tree behind the lock screen is empty shells)');
    } else {
      const w = ax(['windows']);
      if (!w.out.ok) line(w.out.kind === 'permission' ? 'SKIP' : 'FAIL', 'ax-helper windows', `${w.out.kind}: ${w.out.error}`);
      else {
        let old = null;
        const t1 = Date.now();
        try { old = JSON.parse(sh('osascript', ['-l', 'JavaScript', path.join(ROOT, 'scripts', 'mac', 'get-windows.jxa')], { timeout: 90_000 })); } catch { /* too slow / failed — itself the finding */ }
        const oldMs = ms(t1);
        const key = x => `${x.processId}\u0000${x.title}`;
        const mine = new Set(w.out.windows.map(key));
        const lost = old ? old.filter(x => !mine.has(key(x))).length : null;
        const v = windowListVerdict({ old, helperMs: w.ms, lost });
        line(v.pass ? 'PASS' : 'FAIL', 'ax-helper window list: fast, and nothing the old script saw is missing',
          `${w.out.windows.length} windows in ${w.ms} ms${w.out.unresponsive.length ? ` (+${w.out.unresponsive.length} not responding)` : ''}${w.out.truncated ? ` · PARTIAL: ${w.out.skipped.length} app(s) not reached in the time budget` : ''} · old osascript: ${old ? `${old.length} windows` : 'failed'} in ${oldMs} ms${v.note ? ` · ${v.note}` : ''}`);
      }
      const a = ax(['active']);
      if (a.out.ok) {
        const seFront = (() => { try { return sh('osascript', ['-e', 'tell application "System Events" to name of first process whose frontmost is true']); } catch { return '?'; } })();
        const same = !a.out.active || a.out.active.processName === seFront;
        line('PASS', 'ax-helper active window', `${a.out.active ? `${a.out.active.processName} via ${a.out.active.source}` : 'none'} · ${a.ms} ms · System Events says ${seFront}${same ? '' : ' (differs: a system dialog or accessory app has the keyboard)'}`);
        const pid = a.out.active?.processId;
        if (pid) {
          const t = ax(['tree', '--pid', String(pid)]);
          if (!t.out.ok) line('FAIL', 'ax-helper tree of the active app', `${t.out.kind}: ${t.out.error}`);
          else {
            const ids = (function count(n) { return !n ? 0 : (n.automationId ? 1 : 0) + (n.children || []).reduce((acc, c) => acc + count(c), 0); })(t.out.tree);
            line(t.out.nodeCount > 0 ? 'PASS' : 'SKIP', 'ax-helper tree of the active app', `${t.out.nodeCount} nodes, ${ids} with an AXIdentifier, in ${t.ms} ms${t.out.truncated ? ` (truncated: ${t.out.reason})` : ''}`);
          }
        }
      } else line(a.out.kind === 'permission' ? 'SKIP' : 'FAIL', 'ax-helper active window', `${a.out.kind}: ${a.out.error}`);
    }
  }
}

// ── 8. the macOS-only unit tests ──────────────────────────────────────────────
try {
  const out = sh('npx', ['vitest', 'run', 'src/__tests__/mac-ocr-binary.test.ts', 'src/__tests__/a11y-wake.test.ts', 'src/__tests__/mac-screen.test.ts', 'src/__tests__/mac-screen-displays.test.ts', 'src/__tests__/mac-ax-live.test.ts'], { cwd: ROOT, timeout: 600_000 });
  const m = /Tests\s+(.*)/.exec(out); line('PASS', 'macOS-only unit tests', m ? m[1].replace(/\x1b\[[0-9;]*m/g, '') : 'passed');
} catch (err) { const o = String(err.stdout || err.message); line('FAIL', 'macOS-only unit tests', (o.match(/FAIL.*|×.*/g) || [o.slice(-300)]).slice(0, 3).join(' | ').replace(/\x1b\[[0-9;]*m/g, '')); }

// ── 9. the on-screen overlay (glow + pill) and the pause prompt — interactive ─
const { macOverlayBinary } = require(dist('platform/mac-ocr-binary.js'));
const { spawn } = await import('node:child_process');
const OVERLAY = path.join(ROOT, 'scripts', 'mac', 'overlay.swift');
// NSWorkspace, not System Events: System Events keeps naming the old app while
// another process is really active (measured on macOS 26).
const frontApp = () => { try { return sh('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.js"]); } catch { return '?'; } };
/** Run the overlay; resolve with its first stdout line, its exit code, or 'timeout'. */
const runOverlay = (bin, args, env, waitMs) => new Promise(resolve => {
  const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const timer = setTimeout(() => { child.kill(); resolve('timeout'); }, waitMs);
  child.stdout.on('data', d => { out += d; if (out.includes('\n')) { clearTimeout(timer); child.kill(); resolve(out.trim()); } });
  child.on('exit', code => { clearTimeout(timer); resolve(out.trim() || `exit ${code}`); });
});
let overlayBin = null;
if (!env.swiftc) line('FAIL', 'compile overlay', 'swiftc missing — install Xcode Command Line Tools');
else {
  macOverlayBinary.reset();
  const t0 = Date.now(); overlayBin = await macOverlayBinary.compile(OVERLAY, path.join(tmp, 'bin'));
  line(overlayBin ? 'PASS' : 'FAIL', 'compile overlay (scripts/mac/overlay.swift)', overlayBin ? `${ms(t0)} ms` : 'compile failed — run: swiftc -O scripts/mac/overlay.swift -o /tmp/o  to see the error');
}
if (overlayBin) {
  console.log('\n  → Watch your screens: a BLUE glow should pulse on every edge of every display for 5 s.');
  const g = await runOverlay(overlayBin, ['glow', '--color', '#3b82f6', '--duration', '5'], {}, 20_000);
  line(g === 'exit 0' ? 'PASS' : 'FAIL', 'glow runs on every display and exits on time', `${g} (check by eye: did all ${sh('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); $.NSScreen.screens.count"])} screen(s) glow blue?)`);

  const before = frontApp();
  console.log('\n  → A pill saying "ClawdCursor paused - your turn" is at the top of your main screen. Click RESUME (60 s).');
  let during = null;
  const sample = setTimeout(() => { during = frontApp(); }, 2000); // while the pill is up, before any click
  const r = await runOverlay(overlayBin, ['pill'], { CLAWD_BANNER_MODE: 'paused', CLAWD_BANNER_MESSAGE: 'This is the clawdcursor Mac check. Click Resume on this pill.' }, 60_000);
  clearTimeout(sample);
  const after = frontApp();
  if (during !== null) line(during === before ? 'PASS' : 'FAIL', 'showing the pill does not take focus', `frontmost before "${before}", while the pill is up "${during}"`);
  if (r === 'timeout') line('SKIP', 'paused pill: Resume', 'no click within 60 s');
  else line(r === 'BANNER_RESUME' ? 'PASS' : 'FAIL', 'paused pill: Resume prints BANNER_RESUME', r);
  if (r !== 'timeout') line(after === before ? 'PASS' : 'FAIL', 'clicking the pill keeps focus where it was', `frontmost before "${before}", after "${after}"`);

  console.log('\n  → Now the normal "desktop control in progress" pill: DOUBLE-CLICK it (30 s).');
  const s = await runOverlay(overlayBin, ['pill'], {}, 30_000);
  if (s === 'timeout') line('SKIP', 'running pill: double-click to stop', 'no double-click within 30 s');
  else line(s === 'BANNER_STOP' ? 'PASS' : 'FAIL', 'running pill: double-click prints BANNER_STOP', s);

  // End to end through clawdcursor itself: the pause gate draws the blue glow + pill via banner.ts.
  await macOverlayBinary.compile(OVERLAY); // the real cache in ~/.clawdcursor/bin, which banner.ts uses
  delete process.env.CLAWD_NO_PAUSE; delete process.env.CLAWD_NO_BANNER;
  const { pauseGate } = require(dist('core/pause-gate.js'));
  const { controlBanner } = require(dist('core/banner.js'));
  if (!pauseGate.available()) line('FAIL', 'clawdcursor pause (end to end)', 'pauseGate.available() is false — the overlay binary is not usable');
  else {
    console.log('\n  → Last one, through clawdcursor itself: blue glow + pill again. Click RESUME (60 s).');
    let t;
    const outcome = await Promise.race([
      pauseGate.request({ message: 'clawdcursor Mac check (end to end): click Resume.' }),
      new Promise(r => { t = setTimeout(() => r('timeout'), 60_000); }),
    ]);
    clearTimeout(t);
    controlBanner.setEnabled(false); // take the amber "running" form down again
    if (outcome === 'timeout') { pauseGate.answer('end'); line('SKIP', 'clawdcursor pause (end to end)', 'no click within 60 s'); }
    else line(outcome === 'resumed' ? 'PASS' : 'FAIL', 'clawdcursor pause (end to end): Resume continues', outcome);
  }
  console.log('');
}

const report = { env, results, at: new Date().toISOString() };
fs.writeFileSync(path.join(ROOT, 'verify-macos-report.json'), JSON.stringify(report, null, 2));
const n = s => results.filter(r => r.status === s).length;
console.log(`\n${n('PASS')} passed · ${n('FAIL')} failed · ${n('SKIP')} skipped — paste verify-macos-report.json (or this output) back to Claude.`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(n('FAIL') ? 1 : 0);
