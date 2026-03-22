/**
 * App Guide Loader
 *
 * Loads community-contributed application guides from the guides/ directory.
 * Guides teach the AI how to efficiently operate specific apps — workflows,
 * keyboard shortcuts, UI layout, and tips.
 *
 * Guides are JSON files named {process-name}.json and loaded automatically
 * when the target app is detected. No code changes needed to add new guides.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface AppGuide {
  app: string;
  processNames: string[];
  workflows: Record<string, string>;
  shortcuts: Record<string, string>;
  layout: Record<string, string>;
  tips: string[];
}

// Cache loaded guides to avoid re-reading files
const guideCache = new Map<string, AppGuide | null>();
const processToGuide = new Map<string, string>(); // process name → guide file name
let indexBuilt = false;

/**
 * Build an index of process names → guide files (done once).
 */
function buildIndex(): void {
  if (indexBuilt) return;
  indexBuilt = true;

  const guidesDir = path.join(__dirname, '..', 'guides');
  if (!fs.existsSync(guidesDir)) return;

  try {
    const files = fs.readdirSync(guidesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(guidesDir, file), 'utf8');
        const guide: AppGuide = JSON.parse(content);
        const baseName = file.replace('.json', '');
        guideCache.set(baseName, guide);

        // Map all process names to this guide
        for (const pn of guide.processNames || []) {
          processToGuide.set(pn.toLowerCase(), baseName);
        }
      } catch {
        // Skip malformed guides silently
      }
    }
  } catch {
    // guides dir unreadable
  }
}

/**
 * Load a guide for the given process name. Returns null if no guide exists.
 */
export function loadGuide(processName: string): AppGuide | null {
  buildIndex();

  const normalized = processName.toLowerCase();

  // Direct match on process name
  const guideName = processToGuide.get(normalized);
  if (guideName && guideCache.has(guideName)) {
    return guideCache.get(guideName) || null;
  }

  // Try loading by filename
  if (guideCache.has(normalized)) {
    return guideCache.get(normalized) || null;
  }

  return null;
}

/**
 * Format a guide as concise text for injection into the LLM system prompt.
 * Keeps it compact to minimize token usage.
 */
export function formatGuideForPrompt(guide: AppGuide): string {
  const lines: string[] = [];
  lines.push(`\n--- APP GUIDE: ${guide.app} ---`);

  // Workflows (most important)
  if (guide.workflows && Object.keys(guide.workflows).length > 0) {
    lines.push('WORKFLOWS:');
    for (const [name, steps] of Object.entries(guide.workflows)) {
      lines.push(`  ${name}: ${steps}`);
    }
  }

  // Key shortcuts
  if (guide.shortcuts && Object.keys(guide.shortcuts).length > 0) {
    const shortcutStr = Object.entries(guide.shortcuts)
      .map(([name, key]) => `${name}=${key}`)
      .join(', ');
    lines.push(`SHORTCUTS: ${shortcutStr}`);
  }

  // Layout
  if (guide.layout && Object.keys(guide.layout).length > 0) {
    lines.push('LAYOUT:');
    for (const [area, desc] of Object.entries(guide.layout)) {
      lines.push(`  ${area}: ${desc}`);
    }
  }

  // Tips
  if (guide.tips && guide.tips.length > 0) {
    lines.push('IMPORTANT TIPS:');
    for (const tip of guide.tips) {
      lines.push(`  - ${tip}`);
    }
  }

  lines.push('--- END GUIDE ---\n');
  return lines.join('\n');
}

/**
 * Get formatted guide text for a process name, ready for prompt injection.
 * Returns empty string if no guide found.
 */
export function getGuidePrompt(processName: string): string {
  const guide = loadGuide(processName);
  if (!guide) return '';
  return formatGuideForPrompt(guide);
}
