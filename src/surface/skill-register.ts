/**
 * Cross-framework skill registration.
 *
 * clawdcursor exposes the SAME capability two ways: an MCP server (typed tools)
 * and a Skill (SKILL.md — the "how to use me" knowledge: fallback positioning,
 * the el_NN UI map, the SEE/ACT ladder, handing a step to the user).
 * An agent that only gets the MCP tools has the hands but not the playbook.
 *
 * This used to run ONLY inside `clawdcursor doctor`. But doctor configures the
 * autonomous daemon, and the MCP-first onboarding explicitly tells people to
 * skip it — so MCP-direct users never registered the skill, and clawdcursor
 * showed up as bare MCP tools with none of the guidance. Pulling it out here
 * lets `consent` (always required) and `clawdcursor register-skill` install the
 * skill into EVERY detected agent framework, regardless of install path.
 *
 * Best-effort and non-invasive: only writes into a framework's skills directory
 * if that directory already exists (never creates host config the user doesn't
 * have), and symlinks the package root so SKILL.md's referenced paths (scripts/,
 * etc.) resolve — falling back to a plain SKILL.md copy when symlinks are blocked.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getPackageRoot } from '../paths';

export interface SkillRegResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SkillRegSummary {
  registered: number;
  results: SkillRegResult[];
}

/** Agent frameworks that expose a skills registry, and where it lives. */
export function hostRegistries(homeDir: string): [name: string, skillsDir: string][] {
  return [
    // Claude Code — ~/.claude/skills/<name>/SKILL.md (Skill tool + /<skill>).
    ['Claude Code', path.join(homeDir, '.claude', 'skills')],
    // OpenClaw — the original target. Both the workspace and flat layouts.
    ['OpenClaw', path.join(homeDir, '.openclaw', 'workspace', 'skills')],
    ['OpenClaw (dev)', path.join(homeDir, '.openclaw-dev', 'workspace', 'skills')],
    ['OpenClaw (flat)', path.join(homeDir, '.openclaw', 'skills')],
    // Codex — ~/.codex/skills.
    ['Codex', path.join(homeDir, '.codex', 'skills')],
    // Cursor — ~/.cursor/skills (only if the user's Cursor has skills enabled).
    ['Cursor', path.join(homeDir, '.cursor', 'skills')],
  ];
}

/**
 * Register clawdcursor as a skill in every detected agent framework.
 * Returns per-host results + how many registries got it.
 */
export function registerSkills(folderName = 'clawdcursor'): SkillRegSummary {
  const results: SkillRegResult[] = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (!homeDir) return { registered: 0, results };

  const clawdCursorRoot = getPackageRoot();
  const skillSource = path.join(clawdCursorRoot, 'SKILL.md');
  if (!fs.existsSync(skillSource)) {
    results.push({ name: 'Skill registration', ok: false, detail: 'SKILL.md not found at package root' });
    return { registered: 0, results };
  }

  let registered = 0;
  for (const [name, skillsDir] of hostRegistries(homeDir)) {
    if (!fs.existsSync(skillsDir)) continue; // framework not installed → skip silently

    const skillTarget = path.join(skillsDir, folderName);
    const targetSkillFile = path.join(skillTarget, 'SKILL.md');

    // Already present → refresh the SKILL.md if ours is newer (so an upgrade
    // propagates new guidance), otherwise leave it.
    if (fs.existsSync(skillTarget)) {
      try {
        if (fs.existsSync(targetSkillFile)) {
          const srcMtime = fs.statSync(skillSource).mtimeMs;
          const dstMtime = fs.statSync(targetSkillFile).mtimeMs;
          if (srcMtime > dstMtime) {
            fs.copyFileSync(skillSource, targetSkillFile);
            results.push({ name: `${name} skill`, ok: true, detail: 'Refreshed (SKILL.md updated)' });
          } else {
            results.push({ name: `${name} skill`, ok: true, detail: 'Registered (up to date)' });
          }
        } else {
          fs.copyFileSync(skillSource, targetSkillFile);
          results.push({ name: `${name} skill`, ok: true, detail: 'Registered (SKILL.md copied)' });
        }
        registered++;
      } catch {
        // best-effort
      }
      continue;
    }

    // Fresh: symlink the whole package root (keeps SKILL.md's relative paths
    // valid); fall back to a SKILL.md copy if symlinks are blocked.
    try {
      fs.symlinkSync(clawdCursorRoot, skillTarget, process.platform === 'win32' ? 'junction' : 'dir');
      results.push({ name: `${name} skill`, ok: true, detail: 'Registered (symlink)' });
      registered++;
    } catch {
      try {
        fs.mkdirSync(skillTarget, { recursive: true });
        fs.copyFileSync(skillSource, targetSkillFile);
        results.push({ name: `${name} skill`, ok: true, detail: 'Registered (SKILL.md copied)' });
        registered++;
      } catch {
        // non-critical
      }
    }
  }

  if (registered === 0) {
    results.push({
      name: 'Skill registration',
      ok: true,
      detail: 'No host registry found (Claude Code, OpenClaw, Codex, Cursor) — clawdcursor still works standalone via MCP',
    });
  }

  return { registered, results };
}

/**
 * The registrations registerSkills made, for `uninstall`: in each host's skills dir, a `clawdcursor` link to a clawdcursor
 * package, or a folder holding only the SKILL.md it copied. A folder the user made there (registerSkills only refreshes
 * the SKILL.md inside one) is not ours and is left.
 */
export function ourSkillRegistrations(homeDir: string, folderName = 'clawdcursor'): string[] {
  return hostRegistries(homeDir).map(([, dir]) => path.join(dir, folderName)).filter(target => {
    try {
      if (fs.lstatSync(target).isSymbolicLink()) {
        return JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).name === 'clawdcursor';
      }
      return fs.readdirSync(target).join('/') === 'SKILL.md';
    } catch {
      return false;
    }
  });
}
