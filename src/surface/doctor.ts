/**
 * 🩺 Clawd Cursor Doctor - diagnoses the local setup.
 *
 * Checks: version, installed copies, consent, screen capture, macOS
 * permissions, the accessibility bridge, and external skill registration.
 * It configures nothing about models: clawdcursor runs none.
 */

import * as fs from 'fs';
import * as path from 'path';
import pc from 'picocolors';
import { NativeDesktop } from '../platform/native-desktop';
import { AccessibilityBridge } from '../platform/accessibility';
import { macAxStatus } from '../platform/mac-ax';
import { DEFAULT_CONFIG } from '../types';
import { getPackageRoot } from '../paths';
import { hasConsent } from './onboarding';
import { checkPermissionsQuick, requestPermissions, screenRecordingGranted, nativeBuildHint, isMacOS } from '../platform/native-helper';
import { findInstalledCopies, describeCopies } from './installed-copies';
import { installMethod, howToUpdate } from './update';

interface DiagResult {
  name: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

export async function runDoctor(): Promise<void> {
  const results: DiagResult[] = [];

  console.log(`\n🩺 Clawd Cursor Doctor - diagnosing your setup...\n`);

  // ─── 0. Version Check ───────────────────────────────────────────
  console.log('📦 Version check...');
  const latest = await checkForUpdates(results);

  // ─── 0a. Every installed copy ───────────────────────────────────
  // The installer updates the global copy only; the Desktop extension and the
  // Claude Code plugin carry their own. Show them all so a stale one is obvious.
  console.log('📦 Installed copies...');
  checkInstalledCopies(results, latest);

  // ─── 0b. Consent Check ──────────────────────────────────────────
  console.log('📝 Consent check...');
  const consentGranted = hasConsent();
  if (consentGranted) {
    results.push({ name: 'Desktop control consent', ok: true, detail: 'Granted' });
    console.log('   ✅ Consent granted');
  } else {
    results.push({ name: 'Desktop control consent', ok: false, detail: 'Run: clawdcursor consent' });
    console.log('   ❌ Consent not granted — run: clawdcursor consent');
  }

  // ─── 1. Screen Capture ───────────────────────────────────────────
  console.log('📸 Screen capture...');
  const config = { ...DEFAULT_CONFIG };
  const desktop = new NativeDesktop(config);
  try {
    const start = performance.now();
    await desktop.connect();
    const frame = await desktop.captureForLLM();
    const ms = Math.round(performance.now() - start);
    const size = desktop.getScreenSize();
    results.push({
      name: 'Screen capture',
      ok: true,
      detail: `${size.width}x${size.height}, ${(frame.buffer.length / 1024).toFixed(0)}KB, ${ms}ms`,
      latencyMs: ms,
    });
    console.log(`   ✅ ${size.width}x${size.height}, ${ms}ms`);
    desktop.disconnect();
  } catch (err) {
    results.push({ name: 'Screen capture', ok: false, detail: String(err) });
    console.log(`   ❌ ${err}`);
    desktop.disconnect();
  }

  // ─── 1b. macOS Permissions (Screen Recording + Accessibility) ───
  // Uses the SAME canonical path as readiness.ts and CLI status:
  //   Host /status → permission-check binary → direct AXIsProcessTrusted fallback
  // Screen Recording is the capture gate's own check (screenRecordingGranted), so doctor never disagrees with a capture.
  // This ensures doctor, status, and readiness always agree.
  if (isMacOS()) {
    console.log('🍎 macOS permissions (via native permission-check)...');
    try {
      let perms = await checkPermissionsQuick();

      // If any permission is missing, trigger system popups to request them
      if (!perms.accessibility || perms.screenRecording === false) {
        console.log('   🔐 Requesting macOS permissions (system dialogs may appear)...');
        try {
          perms = { ...(await requestPermissions()), screenRecording: await screenRecordingGranted() };
        } catch (err) {
          // Continue with the check results, but say why no dialog came (e.g. the helpers are not built yet).
          console.log(`   ⚠️  ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // With no app bundle the grant belongs to whatever runs clawdcursor — there is no "ClawdCursor" entry to enable.
      const who = perms.bundleId ? 'ClawdCursor' : 'the app running clawdcursor (your terminal or editor)';
      // Captures run as the app that launched clawdcursor, never as ClawdCursor.app (#276) — so this answer is this terminal's.
      const scope = 'checked for this terminal; the MCP server captures as its host app (e.g. Claude), which needs its own grant';
      const enable = 'System Settings → Privacy & Security → Screen & System Audio Recording → enable the app running clawdcursor';

      results.push({
        name: 'macOS Accessibility permission',
        ok: perms.accessibility,
        detail: perms.accessibility
          ? 'Granted — clawdcursor can read UI elements'
          : `DENIED — open System Settings → Privacy & Security → Accessibility → enable ${who}`,
      });
      if (perms.accessibility) {
        console.log('   ✅ Accessibility permission granted');
      } else {
        console.log('   ❌ Accessibility permission DENIED');
        console.log(`   → System Settings → Privacy & Security → Accessibility → enable ${who}`);
      }

      // null: the check could not run. Captures still go ahead (with a warning): not a denial, but not a pass either.
      results.push({
        name: 'macOS Screen Recording permission',
        ok: perms.screenRecording === true,
        detail: perms.screenRecording === null
          ? 'Could not check — captures go ahead, but a missing grant would show as a wallpaper-only image'
          : perms.screenRecording
            ? 'Granted — clawdcursor can capture the screen'
            : `DENIED — open ${enable}`,
      });
      if (perms.screenRecording === null) {
        console.log('   ⚠️  Screen Recording permission: could not check');
      } else if (perms.screenRecording) {
        console.log('   ✅ Screen Recording permission granted');
      } else {
        console.log('   ❌ Screen Recording permission DENIED');
        console.log(`   → ${enable}`);
      }
      console.log(`   ℹ  ${scope}`);

      if (perms.bundleId) {
        console.log(`   ℹ  Checked process: ${perms.bundleId}`);
      }

      // The fast accessibility helper (window list / trees in tens of ms). Missing Command Line Tools is not a
      // failure — the osascript path still works — but it is slower, and the fix is one command.
      const helper = await macAxStatus();
      results.push({ name: 'macOS accessibility helper', ok: true, detail: helper.detail });
      console.log(`   ${helper.state === 'no-devtools' ? '⚠️ ' : '✅'} Accessibility helper: ${helper.detail}`);
    } catch (err) {
      results.push({ name: 'macOS Accessibility permission', ok: false, detail: `Could not query: ${err}` });
      results.push({ name: 'macOS Screen Recording permission', ok: false, detail: `Could not query: ${err}` });
      console.log(`   ❌ Permission check failed: ${err}`);
      console.log(`   → ${nativeBuildHint()}`);
    }
  }

  // ─── 2. Accessibility Bridge ─────────────────────────────────────
  console.log('♿ Accessibility bridge...');
  const a11y = new AccessibilityBridge();
  try {
    const start = performance.now();
    const available = await a11y.isShellAvailable();
    if (available) {
      const windows = await a11y.getWindows(true);
      const ms = Math.round(performance.now() - start);
      results.push({
        name: 'Accessibility bridge',
        ok: true,
        detail: `${windows.length} windows detected, ${ms}ms`,
        latencyMs: ms,
      });
      console.log(`   ✅ ${windows.length} windows detected, ${ms}ms`);
    } else {
      results.push({ name: 'Accessibility bridge', ok: false, detail: 'Shell not available' });
      console.log(`   ❌ Shell not available`);
    }
  } catch (err) {
    results.push({ name: 'Accessibility bridge', ok: false, detail: String(err) });
    console.log(`   ❌ ${err}`);
  }

  // ─── 3. External Skill Registration (optional) ─────────────────
  await registerExternalSkills(results);

  // ─── Summary ────────────────────────────────────────────────────
  printSummary(results);
}

/**
 * Print the final summary.
 */
function printSummary(results: DiagResult[]): void {
  const allOk = results.every(r => r.ok);
  const consentMissing = results.some(r => r.name === 'Desktop control consent' && !r.ok);

  console.log(`\n${'═'.repeat(50)}`);
  if (allOk) {
    console.log(`✅ All systems go!\n`);
    console.log(`   Two ways to use clawdcursor — pick the one that fits your setup:\n`);
    console.log(`   ${pc.bold('1. As an MCP server for your editor')} ${pc.gray('(Claude Code, Cursor, Windsurf, Zed)')}`);
    console.log(`      Register ${pc.cyan('clawdcursor mcp')} in your editor's MCP config.`);
    console.log(`      Your editor's AI gets the desktop tools (or 6 compound via ${pc.cyan('--compact')}).`);
    console.log(`      Stdio transport — no daemon, no port, no token.\n`);
    console.log(`   ${pc.bold('2. As a local HTTP daemon')} ${pc.gray('(for any HTTP client)')}`);
    console.log(`      Run ${pc.cyan('clawdcursor agent')} — exposes the same tools at ${pc.cyan('POST /mcp')} on ${pc.cyan(':3847')}.\n`);
    console.log(`   Run now:`);
    console.log(`     ${pc.cyan('clawdcursor agent')}   ${pc.gray('# or skip the daemon and wire `clawdcursor mcp` into your editor')}`);
  } else {
    const failures = results.filter(r => !r.ok);
    console.log(`⚠️  ${failures.length} issue(s) detected:`);
    for (const f of failures) {
      console.log(`   ❌ ${f.name}: ${f.detail}`);
    }

    // Consent is critical — highlight it
    if (consentMissing) {
      console.log(`\n🔐 Consent required before desktop control can work:`);
      console.log(`   Run: clawdcursor consent`);
      console.log('');
    }
  }
  console.log('');
}


/**
 * Register Clawd Cursor as a skill in detected external platforms (Claude Code,
 * OpenClaw, Codex, Cursor). Delegates to the shared, install-path-agnostic
 * implementation in ./skill-register so `consent` and `register-skill` register
 * the skill the same way doctor does (the logic used to live ONLY here, which is
 * why MCP-direct users — told to skip doctor — never got the skill).
 */
async function registerExternalSkills(results: DiagResult[]): Promise<void> {
  const { registerSkills } = await import('./skill-register');
  for (const r of registerSkills().results) {
    results.push({ name: r.name, ok: r.ok, detail: r.detail });
  }
}

/**
 * List every copy of clawdcursor on this machine and flag the stale ones.
 */
function checkInstalledCopies(results: DiagResult[], latest: string | undefined): void {
  try {
    const { lines, stale } = describeCopies(findInstalledCopies(), { latest, running: getPackageRoot() });
    for (const line of lines) console.log(`   ${line}`);
    results.push(stale.length
      ? { name: 'Installed copies', ok: false, detail: `${stale.length} older cop${stale.length === 1 ? 'y' : 'ies'}: ${stale.map(c => `${c.kind} v${c.version}`).join(', ')}` }
      : { name: 'Installed copies', ok: true, detail: 'all on the same version' });
  } catch {
    console.log('   ⚠️  Could not list installed copies — skipping');
  }
}

/**
 * Check for newer versions on GitHub releases. Returns the latest released
 * version when the check succeeded.
 */
async function checkForUpdates(results: DiagResult[]): Promise<string | undefined> {
  try {
    const pkgPath = path.join(getPackageRoot(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const currentVersion = pkg.version || '0.0.0';
    console.log(`   Current: v${currentVersion}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(
      'https://api.github.com/repos/AmrDab/clawdcursor/releases/latest',
      {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'clawdcursor-doctor' },
        signal: controller.signal,
      },
    );
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json() as any;
      const latestTag = (data.tag_name || '').replace(/^v/, '');

      if (latestTag && latestTag !== currentVersion && compareVersions(latestTag, currentVersion) > 0) {
        console.log(`   ⬆️  Update available: v${latestTag} (you have v${currentVersion})`);
        const method = installMethod(getPackageRoot());
        console.log(`   ${method === 'npm-global' ? 'Run: clawdcursor update' : howToUpdate(method)}`);
        results.push({
          name: 'Version',
          ok: false,
          detail: `Update available: v${latestTag} (current: v${currentVersion})`,
        });
      } else {
        console.log(`   ✅ Up to date (v${currentVersion})`);
        results.push({ name: 'Version', ok: true, detail: `v${currentVersion} (latest)` });
      }
      return latestTag || undefined;
    } else {
      // GitHub API rate limit or error — skip gracefully
      console.log(`   ✅ v${currentVersion} (update check skipped — GitHub API returned ${res.status})`);
      results.push({ name: 'Version', ok: true, detail: `v${currentVersion} (update check skipped)` });
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.log(`   ⚠️  Update check timed out (5s) — skipping`);
    } else {
      console.log(`   ⚠️  Update check failed — skipping`);
    }
    // Don't fail the doctor for a version check issue
    const pkgPath = path.join(getPackageRoot(), 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      results.push({ name: 'Version', ok: true, detail: `v${pkg.version} (update check unavailable)` });
    } catch {
      results.push({ name: 'Version', ok: true, detail: 'unknown (update check unavailable)' });
    }
  }
}

/**
 * Simple semver comparison. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}
