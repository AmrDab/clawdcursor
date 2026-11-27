import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Single-source-of-truth guard. The McpServer constructor and onboarding
// consent file each had their own hardcoded version string for multiple
// releases (the v0.8.6 release shipped specifically to flush the drift).
// This test fails the build if any .ts under src/ pins package.json's
// current version as a literal — the helper at src/version.ts is the
// only allowed home for that string.

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const ALLOW = new Set([join(SRC, 'version.ts')]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('version drift guard', () => {
  it('no .ts file under src/ hardcodes the package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string };
    const needle = pkg.version;
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (ALLOW.has(file)) continue;
      const text = readFileSync(file, 'utf-8');
      if (text.includes(`'${needle}'`) || text.includes(`"${needle}"`)) {
        offenders.push(file.slice(ROOT.length + 1));
      }
    }
    expect(offenders, `Hardcoded version "${needle}" found. Import VERSION from './version' instead.`).toEqual([]);
  });

  // Inverse guard for off-tree version literals. SKILL.md frontmatter and
  // docs/index.html / install.{sh,ps1} all carry the version intentionally
  // — they're sync'd from package.json by `npm run sync-version` on every
  // release. If any of them drifts, fail the build and tell the dev to run
  // the sync. Keeps `npm version <bump>` honest even if its lifecycle hook
  // is bypassed (e.g. someone hand-edits package.json).
  it('SKILL.md + docs/ + install scripts + plugin.json match package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string };
    const needle = pkg.version;

    const skill = readFileSync(join(ROOT, 'SKILL.md'), 'utf-8');
    const skillMatch = skill.match(/^version:\s*(\d+\.\d+\.\d+)/m);
    expect(skillMatch?.[1], 'SKILL.md frontmatter version drifted; run `npm run sync-version`').toBe(needle);

    // .claude-plugin/plugin.json — synced by sync-version; guard it like the rest.
    const plugin = readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf-8');
    const pluginMatch = plugin.match(/"version":\s*"(\d+\.\d+\.\d+)"/);
    expect(pluginMatch?.[1], '.claude-plugin/plugin.json version drifted; run `npm run sync-version`').toBe(needle);

    const indexHtml = readFileSync(join(ROOT, 'docs', 'index.html'), 'utf-8');
    // The <title>, meta description, and og:title are intentionally version-FREE
    // (clean branding, 2026-06-14 reframe). The visible version lives in the
    // hero badge (checked below), the agent-summary header, and the footer.
    const heroBadgeMatch = indexHtml.match(/<div class="hero-badge"><div class="pulse"><\/div>\s*v(\d+\.\d+\.\d+)/);
    expect(heroBadgeMatch?.[1], 'docs/index.html hero badge drifted; run `npm run sync-version`').toBe(needle);

    for (const installer of ['install.sh', 'install.ps1']) {
      const text = readFileSync(join(ROOT, 'docs', installer), 'utf-8');
      const m = text.match(/# Specify version: \$?(?:env:)?VERSION=?'?(?:v)(\d+\.\d+\.\d+)'?/);
      expect(m?.[1], `docs/${installer} pin example drifted; run \`npm run sync-version\``).toBe(needle);
    }

    // skills/clawdcursor/SKILL.md must be byte-identical to root SKILL.md.
    // The copy is maintained by sync-version.ts (fs.copyFileSync). If this
    // assertion fails, the two files have drifted — run `npm run sync-version`.
    const rootSkill = readFileSync(join(ROOT, 'SKILL.md'));
    const pluginSkill = readFileSync(join(ROOT, 'skills', 'clawdcursor', 'SKILL.md'));
    expect(
      pluginSkill.equals(rootSkill),
      'skills/clawdcursor/SKILL.md is not byte-identical to root SKILL.md; run `npm run sync-version`',
    ).toBe(true);

    // skills/clawdcursor/references/ must match root references/ file for file (sync-version copies them too),
    // and every reference SKILL.md links to must exist.
    const refNames = readdirSync(join(ROOT, 'references')).filter(n => n.endsWith('.md')).sort();
    expect(readdirSync(join(ROOT, 'skills', 'clawdcursor', 'references')).filter(n => n.endsWith('.md')).sort()).toEqual(refNames);
    for (const name of refNames) {
      expect(
        readFileSync(join(ROOT, 'skills', 'clawdcursor', 'references', name)).equals(readFileSync(join(ROOT, 'references', name))),
        `skills/clawdcursor/references/${name} drifted; run \`npm run sync-version\``,
      ).toBe(true);
    }
    for (const m of rootSkill.toString('utf-8').matchAll(/\]\((references\/[^)]+)\)/g)) {
      expect(existsSync(join(ROOT, m[1])), `SKILL.md links to missing ${m[1]}`).toBe(true);
    }

    // .claude-plugin/marketplace.json plugins[0].version must track package.json.
    // metadata.version ("1.0.0") is the marketplace-format version and is NOT checked here.
    const marketplace = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf-8')) as {
      plugins: Array<{ version: string }>;
    };
    expect(
      marketplace.plugins[0]?.version,
      '.claude-plugin/marketplace.json plugins[0].version drifted; run `npm run sync-version`',
    ).toBe(needle);
  });
});
