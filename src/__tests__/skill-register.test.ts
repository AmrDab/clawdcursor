/**
 * Cross-framework skill registration (2026-06-15). Regression guard for the
 * gap where the skill only registered inside `doctor` — so MCP-direct agents,
 * told to skip doctor, never got clawdcursor as a skill. registerSkills() now
 * backs both `consent` and `clawdcursor register-skill`, and must:
 *   - register into a framework whose skills dir EXISTS,
 *   - never create config for a framework that ISN'T installed,
 *   - no-op cleanly when no framework is present.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSkills } from '../surface/skill-register';

describe('registerSkills', () => {
  let fakeHome: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'clawd-skillreg-'));
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('registers into a detected framework and leaves absent ones untouched', () => {
    // Pre-create the Claude Code target dir → exercises the copy path (no
    // junction into the repo root that recursive cleanup could follow).
    mkdirSync(join(fakeHome, '.claude', 'skills', 'clawdcursor'), { recursive: true });

    const { registered, results } = registerSkills();

    expect(registered).toBeGreaterThanOrEqual(1);
    // SKILL.md landed in the present framework…
    expect(existsSync(join(fakeHome, '.claude', 'skills', 'clawdcursor', 'SKILL.md'))).toBe(true);
    // …with the reference files its links point to.
    expect(existsSync(join(fakeHome, '.claude', 'skills', 'clawdcursor', 'references', 'patterns.md'))).toBe(true);
    // …and an absent framework was NOT created.
    expect(existsSync(join(fakeHome, '.codex'))).toBe(false);
    expect(existsSync(join(fakeHome, '.openclaw'))).toBe(false);
    expect(results.some(r => r.name.startsWith('Claude Code') && r.ok)).toBe(true);
  });

  it('no-ops cleanly when no agent framework is installed', () => {
    const { registered, results } = registerSkills();
    expect(registered).toBe(0);
    expect(results.some(r => r.detail.includes('No host registry found'))).toBe(true);
  });
});
