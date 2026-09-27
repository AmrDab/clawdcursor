/**
 * Propagate package.json version to every other place it appears.
 *
 * Why: SKILL.md frontmatter, the marketing site (docs/index.html), and the
 * install scripts (docs/install.{sh,ps1}) all carry the version as a
 * literal. Hand-syncing them on every release is exactly the kind of
 * task that gets forgotten — leading to a site that advertises the wrong
 * version or an MCP host registry that lies about which version is in
 * the npm package.
 *
 * Wired into npm's `version` lifecycle hook (see package.json scripts).
 * `npm version <bump>` flow:
 *   1. npm bumps package.json
 *   2. THIS script runs — propagates the new version to all other files
 *   3. npm stages the version-bump commit (we git-add the propagated files)
 *   4. npm creates the tag
 *
 * Can also be invoked directly as `tsx scripts/sync-version.ts` to verify
 * everything is in sync without bumping (exits 0 if no changes needed).
 *
 * Adding new sites: append a SyncTarget below. Each target uses an
 * intent-anchored regex (e.g. matched against the surrounding HTML
 * attribute or YAML key) rather than a global "find any v0.x.y" — this
 * avoids accidentally rewriting historical version markers in the
 * CHANGELOG / "What's new" sections.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const VERSION: string = PKG.version;

if (!/^\d+\.\d+\.\d+/.test(VERSION)) {
  console.error(`✗ package.json version "${VERSION}" is not a valid semver`);
  process.exit(1);
}

interface SyncTarget {
  file: string;
  pattern: RegExp;
  replacement: string;
  /** Human-readable description of what this target represents. */
  desc: string;
  /** When true, a non-matching pattern is NOT an error (illustrative examples
   *  that may be absent depending on the marketing-site layout). */
  optional?: boolean;
}

const TARGETS: SyncTarget[] = [
  // SKILL.md frontmatter — the version field MCP hosts read for skill metadata.
  {
    file: 'SKILL.md',
    pattern: /^(version:\s*)\d+\.\d+\.\d+([^\d.]|$)/m,
    replacement: `$1${VERSION}$2`,
    desc: 'SKILL frontmatter `version:` field',
  },

  // server.json — the MCP registry manifest (added 2026-06-11). Carries the
  // version TWICE: the server entry and the npm package pin. A stale value
  // here makes the official registry advertise an old release.
  {
    file: 'server.json',
    pattern: /("version":\s*")\d+\.\d+\.\d+(")/g,
    replacement: `$1${VERSION}$2`,
    desc: 'server.json registry manifest versions (server + npm package)',
  },

  // .claude-plugin/plugin.json — the Claude Code plugin manifest. Wraps the
  // same npm release; a stale version here makes the plugin advertise the
  // wrong version to plugin hosts.
  {
    file: '.claude-plugin/plugin.json',
    pattern: /("version":\s*")\d+\.\d+\.\d+(")/,
    replacement: `$1${VERSION}$2`,
    desc: 'Claude Code plugin manifest version',
  },

  // .claude-plugin/plugin.json — the npx launcher arg, pinned to an exact
  // version. The Claude plugin directory BLOCKS submission on an unpinned
  // launcher ("Unpinned npx launcher": pin to `npx <pkg>@1.2.3`, not a range
  // or @latest), so this pin is load-bearing, not cosmetic — and it is a
  // SECOND version literal in the same file, which the target above does not
  // reach (that one only matches the `"version"` field). Without this target
  // the pin silently rots and every release ships a plugin that installs the
  // PREVIOUS version.
  {
    file: '.claude-plugin/plugin.json',
    pattern: /("clawdcursor@)\d+\.\d+\.\d+(")/,
    replacement: `$1${VERSION}$2`,
    desc: 'Claude Code plugin npx launcher pin',
  },

  // docs/index.html — marketing site. Several places, all distinct contexts.
  {
    file: 'docs/index.html',
    pattern: /(AGENT-READABLE SUMMARY \(v)\d+\.\d+\.\d+(\))/,
    replacement: `$1${VERSION}$2`,
    desc: 'index.html agent-readable summary header',
  },
  // NOTE: the <title>, meta description, and og:title are intentionally
  // VERSION-FREE (clean branding, 2026-06-14 reframe) — the visible version
  // lives in the hero badge / footer / agent-summary, which ARE synced below.
  {
    file: 'docs/index.html',
    pattern: /(<div class="hero-badge"><div class="pulse"><\/div>\s*v)\d+\.\d+\.\d+/,
    replacement: `$1${VERSION}`,
    desc: 'index.html hero badge',
  },
  {
    file: 'docs/index.html',
    pattern: /(clawd<strong>cursor<\/strong> v)\d+\.\d+\.\d+/,
    replacement: `$1${VERSION}`,
    desc: 'index.html footer brand',
  },
  // The installer-pin examples — PowerShell + bash. These are illustrative and
  // the marketing site may render only one (or neither) depending on layout, so
  // the PowerShell example is OPTIONAL: update it if present, don't error if not.
  {
    file: 'docs/index.html',
    pattern: /(\$env:VERSION='v)\d+\.\d+\.\d+(')/g,
    replacement: `$1${VERSION}$2`,
    desc: 'index.html PowerShell install-pin example',
    optional: true,
  },
  {
    file: 'docs/index.html',
    pattern: /(\bVERSION=v)\d+\.\d+\.\d+(\b)/g,
    replacement: `$1${VERSION}$2`,
    desc: 'index.html bash install-pin example',
    // Optional for the same reason as the PowerShell example above: the
    // npm-first install section may render only one pin example (or neither).
    optional: true,
  },

  // Installer scripts — header comments that document the example pin.
  // The runtime VERSION="${VERSION:-main}" default below is intentionally
  // dynamic (defaults to main branch) and is NOT touched.
  {
    file: 'docs/install.sh',
    pattern: /(# Specify version: VERSION=v)\d+\.\d+\.\d+/,
    replacement: `$1${VERSION}`,
    desc: 'install.sh header pin example',
  },
  {
    file: 'docs/install.ps1',
    pattern: /(# Specify version: \$env:VERSION='v)\d+\.\d+\.\d+(')/,
    replacement: `$1${VERSION}$2`,
    desc: 'install.ps1 header pin example',
  },

  // .claude-plugin/marketplace.json — plugin marketplace manifest. Has TWO
  // version fields: metadata.version ("1.0.0", the marketplace-format version,
  // intentionally NOT touched) and plugins[0].version (the clawdcursor release
  // version, synced here). The regex is anchored to the plugin's `"source": "./"
  // line so it only rewrites the plugin-entry version, never metadata.version.
  {
    file: '.claude-plugin/marketplace.json',
    pattern: /("source":\s*"\.\/",[\s\S]*?"version":\s*")\d+\.\d+\.\d+(")/,
    replacement: `$1${VERSION}$2`,
    desc: 'marketplace.json plugins[0].version',
  },
];

let changed = 0;
const touchedFiles = new Set<string>();
const errors: string[] = [];

for (const t of TARGETS) {
  const fp = path.join(REPO_ROOT, t.file);
  if (!fs.existsSync(fp)) {
    errors.push(`✗ missing file: ${t.file} (target: ${t.desc})`);
    continue;
  }
  const before = fs.readFileSync(fp, 'utf-8');
  const after = before.replace(t.pattern, t.replacement);
  if (before === after) {
    // Either already at the right version, or the pattern didn't match — both
    // are non-fatal but the second case is interesting. We can't distinguish
    // cleanly without re-scanning, so just print a quiet status line.
    if (!t.pattern.test(after) && !t.optional) {
      errors.push(`✗ ${t.desc} pattern did not match in ${t.file}`);
    }
    continue;
  }
  fs.writeFileSync(fp, after);
  changed++;
  touchedFiles.add(t.file);
  console.log(`  ✓ ${t.desc}  →  ${t.file}`);
}

// Copy root SKILL.md → skills/clawdcursor/SKILL.md.
// This runs AFTER the regex loop so the root already carries the new version.
// We only write if the destination differs to avoid churning mtime.
{
  const srcSkill = path.join(REPO_ROOT, 'SKILL.md');
  const dstSkill = path.join(REPO_ROOT, 'skills', 'clawdcursor', 'SKILL.md');
  if (!fs.existsSync(srcSkill)) {
    errors.push('✗ missing file: SKILL.md (skill copy source)');
  } else {
    const srcContent = fs.readFileSync(srcSkill);
    const dstContent = fs.existsSync(dstSkill) ? fs.readFileSync(dstSkill) : null;
    if (!dstContent || !srcContent.equals(dstContent)) {
      fs.copyFileSync(srcSkill, dstSkill);
      changed++;
      touchedFiles.add('skills/clawdcursor/SKILL.md');
      console.log(`  ✓ skills/clawdcursor/SKILL.md copied from root SKILL.md  →  skills/clawdcursor/SKILL.md`);
    }
  }
}

if (errors.length > 0) {
  console.error('\nErrors:');
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

if (changed === 0) {
  console.log(`All version literals already match v${VERSION}.`);
  process.exit(0);
}

console.log(`\nUpdated ${changed} site(s) in ${touchedFiles.size} file(s) to v${VERSION}.`);
console.log('Files: ' + Array.from(touchedFiles).join(', '));

// Stage exactly what we touched, HERE, so the file list can never drift from a
// hardcoded `git add` in the package.json "version" hook again. That drift is
// not hypothetical: the hook's list predated server.json + plugin.json being
// added as targets, so v1.5.8's release commit shipped without them and the
// version-drift CI guard failed on every OS. Files staged during the "version"
// lifecycle are included in npm's version commit.
try {
  execFileSync('git', ['add', ...touchedFiles], { cwd: REPO_ROOT, stdio: 'inherit' });
  console.log('Staged all touched files for the version commit.');
} catch {
  console.error('✗ git add of touched files failed — stage them manually before the version commit.');
  process.exit(1);
}
