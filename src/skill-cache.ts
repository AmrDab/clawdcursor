/**
 * Skill Cache — Layer 2.
 *
 * Stores and replays learned task paths. When the same task+app pattern
 * succeeds 2+ times via OcrReasoner, the action sequence is promoted to
 * a skill. Future runs skip OCR+LLM and execute directly from cache.
 *
 * This is the "growing a11y tree" — each successful interaction teaches
 * the system a faster path for next time.
 *
 * Storage: ~/.clawdcursor/skills.json
 * Matching: token overlap ratio (no new npm deps)
 * Promotion: auto after 2 successes for the same task+app pair
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './paths';
import { NativeDesktop } from './native-desktop';
import { AccessibilityBridge } from './accessibility';

const SKILLS_PATH = path.join(DATA_DIR, 'skills.json');
const MATCH_THRESHOLD = 0.75;   // token overlap ratio for fuzzy matching
const PROMOTE_THRESHOLD = 2;     // successes before auto-promotion
const MAX_SKILLS = 200;          // cap to prevent unbounded growth
const MAX_SKILL_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days unused → evict

// ─── Skill types ─────────────────────────────────────────────────────────────

export interface SkillStep {
  type: 'click' | 'type' | 'key' | 'scroll' | 'wait';
  /** For click — pixel coordinates (real screen) */
  x?: number;
  y?: number;
  /** For type — the text (may contain {variable} placeholders) */
  text?: string;
  /** For key — the key combo */
  key?: string;
  /** For scroll */
  direction?: 'up' | 'down';
  amount?: number;
  /** For wait */
  ms?: number;
  /** Human-readable description */
  description: string;
}

export interface Skill {
  id: string;
  taskPattern: string;      // normalized task string
  appName: string;          // process name (e.g. "msedge", "OUTLOOK")
  steps: SkillStep[];
  successCount: number;
  lastUsed: number;         // timestamp
  createdAt: number;
}

// ─── Token matching utilities ────────────────────────────────────────────────

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(t => t.length > 1); // drop single chars
}

function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap++;
  }
  return overlap / Math.max(setA.size, setB.size);
}

// ─── SkillCache class ────────────────────────────────────────────────────────

export class SkillCache {
  private skills: Skill[] = [];
  private loaded = false;
  /** Pending recordings — tasks that succeeded once but aren't promoted yet */
  private pending: Map<string, { task: string; app: string; steps: SkillStep[]; count: number }> = new Map();

  /**
   * Load skills from disk. Safe to call multiple times (no-op after first).
   */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;

    try {
      if (fs.existsSync(SKILLS_PATH)) {
        const raw = fs.readFileSync(SKILLS_PATH, 'utf-8');
        const data = JSON.parse(raw);
        this.skills = Array.isArray(data) ? data : [];
        // Evict stale skills
        const now = Date.now();
        this.skills = this.skills.filter(s => (now - s.lastUsed) < MAX_SKILL_AGE_MS);
        console.log(`   📚 Skill cache loaded: ${this.skills.length} skills`);
      }
    } catch {
      this.skills = [];
    }
  }

  /**
   * Save skills to disk.
   */
  private save(): void {
    try {
      fs.mkdirSync(path.dirname(SKILLS_PATH), { recursive: true });
      fs.writeFileSync(SKILLS_PATH, JSON.stringify(this.skills, null, 2), 'utf-8');
    } catch (err: any) {
      console.error(`   [SkillCache] Save failed: ${err.message}`);
    }
  }

  /**
   * Find the best matching skill for a task+app pair.
   * Returns null if no skill matches above the threshold.
   */
  findSkill(task: string, appName: string): Skill | null {
    this.load();
    if (this.skills.length === 0) return null;

    const taskTokens = tokenize(task);
    const appLower = (appName || '').toLowerCase();

    let bestSkill: Skill | null = null;
    let bestScore = 0;

    for (const skill of this.skills) {
      // App must match (case-insensitive)
      if (skill.appName.toLowerCase() !== appLower) continue;

      const skillTokens = tokenize(skill.taskPattern);
      const score = tokenOverlap(taskTokens, skillTokens);

      if (score >= MATCH_THRESHOLD && score > bestScore) {
        bestScore = score;
        bestSkill = skill;
      }
    }

    return bestSkill;
  }

  /**
   * Execute a cached skill. Returns 'success' if all steps completed,
   * 'miss' if an element wasn't found or an action failed.
   */
  async executeSkill(
    skill: Skill,
    desktop: NativeDesktop,
    a11y: AccessibilityBridge,
  ): Promise<'success' | 'miss'> {
    console.log(`   ⚡ Skill cache HIT: "${skill.taskPattern}" (${skill.steps.length} steps, used ${skill.successCount}x)`);

    try {
      for (const step of skill.steps) {
        switch (step.type) {
          case 'click':
            if (step.x !== undefined && step.y !== undefined) {
              await desktop.mouseClick(step.x, step.y);
              a11y.invalidateCache();
            }
            break;

          case 'type':
            if (step.text) {
              await a11y.writeClipboard(step.text);
              await new Promise(r => setTimeout(r, 50));
              await desktop.keyPress('ctrl+v');
              await new Promise(r => setTimeout(r, 100));
              a11y.invalidateCache();
            }
            break;

          case 'key':
            if (step.key) {
              await desktop.keyPress(step.key);
              a11y.invalidateCache();
            }
            break;

          case 'scroll':
            if (step.x !== undefined && step.y !== undefined) {
              const delta = step.direction === 'down' ? (step.amount ?? 3) : -(step.amount ?? 3);
              await desktop.mouseScroll(step.x, step.y, delta);
            }
            break;

          case 'wait':
            await new Promise(r => setTimeout(r, step.ms ?? 500));
            break;
        }

        // Brief pause between steps
        await new Promise(r => setTimeout(r, 200));
      }

      // Update skill metadata
      skill.successCount++;
      skill.lastUsed = Date.now();
      this.save();

      console.log(`   ✅ Skill replayed successfully (${skill.steps.length} steps)`);
      return 'success';
    } catch (err: any) {
      console.log(`   ❌ Skill replay failed: ${err.message} — falling through`);
      // Decrement success count — the UI may have changed
      skill.successCount = Math.max(0, skill.successCount - 1);
      if (skill.successCount <= 0) {
        // Remove broken skill
        this.skills = this.skills.filter(s => s.id !== skill.id);
        console.log(`   🗑️  Removed broken skill: "${skill.taskPattern}"`);
      }
      this.save();
      return 'miss';
    }
  }

  /**
   * Record a successful task completion. After PROMOTE_THRESHOLD successes
   * for the same task+app pair, auto-promote to a cached skill.
   */
  recordSuccess(task: string, appName: string, steps: SkillStep[]): void {
    this.load();
    if (steps.length === 0) return;

    const key = `${appName.toLowerCase()}::${tokenize(task).sort().join(' ')}`;

    const existing = this.pending.get(key);
    if (existing) {
      existing.count++;
      existing.steps = steps; // use latest steps (may be more refined)

      if (existing.count >= PROMOTE_THRESHOLD) {
        this.promote(task, appName, steps);
        this.pending.delete(key);
      }
    } else {
      this.pending.set(key, { task, app: appName, steps, count: 1 });
    }
  }

  /**
   * Promote a task to a cached skill.
   */
  private promote(taskPattern: string, appName: string, steps: SkillStep[]): void {
    // Check if skill already exists
    const taskTokens = tokenize(taskPattern);
    const exists = this.skills.some(s => {
      if (s.appName.toLowerCase() !== appName.toLowerCase()) return false;
      return tokenOverlap(taskTokens, tokenize(s.taskPattern)) >= 0.9;
    });

    if (exists) return; // Already have this skill

    // Enforce max skills limit
    if (this.skills.length >= MAX_SKILLS) {
      // Evict least-recently-used
      this.skills.sort((a, b) => a.lastUsed - b.lastUsed);
      this.skills.shift();
    }

    const skill: Skill = {
      id: `skill-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      taskPattern,
      appName,
      steps,
      successCount: PROMOTE_THRESHOLD,
      lastUsed: Date.now(),
      createdAt: Date.now(),
    };

    this.skills.push(skill);
    this.save();
    console.log(`   🎓 Skill promoted: "${taskPattern}" on ${appName} (${steps.length} steps)`);
  }

  /**
   * Get skill cache stats.
   */
  getStats(): { total: number; pending: number } {
    this.load();
    return {
      total: this.skills.length,
      pending: this.pending.size,
    };
  }

  /**
   * Clear all skills (for testing or user reset).
   */
  clear(): void {
    this.skills = [];
    this.pending.clear();
    try { fs.unlinkSync(SKILLS_PATH); } catch { /* non-fatal */ }
  }
}
