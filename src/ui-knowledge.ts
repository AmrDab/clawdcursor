/**
 * UI Knowledge Layer
 *
 * Loads app-specific instruction sets (shortcuts, workflows, selectors)
 * from a local knowledge base. In production this becomes a Cloudana DB query.
 *
 * Think of it as a "blind person's instruction manual" — the AI knows exactly
 * how to drive an app before it even looks at the screen.
 */

import * as fs from 'fs';
import * as path from 'path';
import { UI_KNOWLEDGE_DIR } from './paths';

export interface AppWorkflowStep {
  action: 'pressKey' | 'typeAtFocus' | 'click' | 'wait';
  key?: string;
  field?: string;
  note?: string;
}

export interface AppWorkflow {
  description: string;
  steps: AppWorkflowStep[];
}

export interface AppKnowledge {
  app: string;
  domain: string;
  shortcuts: Record<string, string>;
  workflows: Record<string, AppWorkflow>;
  selectors?: Record<string, string>;
  notes?: string[];
}

// Domain → app name mapping
const DOMAIN_MAP: Record<string, string> = {
  'mail.google.com': 'gmail',
  'gmail.com': 'gmail',
  'app.asana.com': 'asana',
  'asana.com': 'asana',
  'figma.com': 'figma',
  'app.slack.com': 'slack',
  'slack.com': 'slack',
  'monday.com': 'monday',
  'notion.so': 'notion',
  'app.posthog.com': 'posthog',
  'canva.com': 'canva',
  'app.hex.tech': 'hex',
  'amplitude.com': 'amplitude',
  'app.gusto.com': 'gusto',
  'box.com': 'box',
};

// Local knowledge base path — in production, replace with cloud DB fetch
const KNOWLEDGE_BASE_DIR = UI_KNOWLEDGE_DIR;

export class UIKnowledgeLayer {
  private cache: Map<string, AppKnowledge | null> = new Map();

  /**
   * Detect which app is being used from a URL or window title.
   */
  detectApp(urlOrTitle: string): string | null {
    const lower = urlOrTitle.toLowerCase();

    // Check domain map
    for (const [domain, appName] of Object.entries(DOMAIN_MAP)) {
      if (lower.includes(domain)) return appName;
    }

    // Fallback: title-based detection
    if (lower.includes('gmail')) return 'gmail';
    if (lower.includes('slack')) return 'slack';
    if (lower.includes('figma')) return 'figma';
    if (lower.includes('asana')) return 'asana';
    if (lower.includes('notion')) return 'notion';

    return null;
  }

  /**
   * Load knowledge for a detected app.
   * Returns null if no knowledge available for this app.
   */
  async loadKnowledge(appName: string): Promise<AppKnowledge | null> {
    if (this.cache.has(appName)) return this.cache.get(appName) ?? null;

    const filePath = path.join(KNOWLEDGE_BASE_DIR, `${appName}.json`);

    // TODO: Replace with Cloudana DB fetch:
    // const knowledge = await fetch(`https://api.cloudana.io/ui-knowledge/${appName}`).then(r => r.json());

    if (!fs.existsSync(filePath)) {
      this.cache.set(appName, null);
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const knowledge = JSON.parse(raw) as AppKnowledge;
      this.cache.set(appName, knowledge);
      return knowledge;
    } catch {
      this.cache.set(appName, null);
      return null;
    }
  }

  /**
   * Get the best workflow for a task + app combination.
   * Returns the workflow steps as a ready-to-inject prompt string.
   */
  getWorkflowPrompt(knowledge: AppKnowledge, taskDescription: string): string | null {
    const taskLower = taskDescription.toLowerCase();

    // Match task to workflow
    let bestWorkflow: AppWorkflow | null = null;
    let bestKey = '';

    const workflowMatchMap: Record<string, string[]> = {
      'compose_and_send': ['send email', 'compose', 'write email', 'new email', 'email to'],
      'reply': ['reply', 'respond'],
      'reply_all': ['reply all'],
      'forward': ['forward'],
      'search': ['search', 'find email', 'look for'],
      'archive': ['archive'],
      'delete': ['delete email', 'trash'],
      'go_to_inbox': ['go to inbox', 'open inbox', 'inbox'],
    };

    for (const [workflowKey, keywords] of Object.entries(workflowMatchMap)) {
      if (keywords.some(kw => taskLower.includes(kw)) && knowledge.workflows[workflowKey]) {
        bestKey = workflowKey;
        bestWorkflow = knowledge.workflows[workflowKey];
        break;
      }
    }

    if (!bestWorkflow) return null;

    const stepsText = bestWorkflow.steps.map((s, i) => {
      if (s.action === 'pressKey') return `${i + 1}. pressKey "${s.key}"${s.note ? ` (${s.note})` : ''}`;
      if (s.action === 'typeAtFocus') return `${i + 1}. typeAtFocus — type the ${s.field}${s.note ? ` (${s.note})` : ''}`;
      return `${i + 1}. ${s.action}`;
    }).join('\n');

    return `APP KNOWLEDGE — ${knowledge.app.toUpperCase()} (${knowledge.domain}):
Use this EXACT sequence for "${bestWorkflow.description}":
${stepsText}

Key shortcuts available: ${Object.entries(knowledge.shortcuts).slice(0, 10).map(([k, v]) => `${k}=${v}`).join(', ')}
${knowledge.notes ? `Notes: ${knowledge.notes.join('; ')}` : ''}

Follow this sequence precisely. Do not try to click UI elements — use the keyboard sequence above.`;
  }

  /**
   * Full context string to inject into the ReAct prompt when an app is detected.
   */
  async getContextForTask(taskDescription: string, urlOrTitle: string): Promise<string | null> {
    const appName = this.detectApp(urlOrTitle);
    if (!appName) return null;

    const knowledge = await this.loadKnowledge(appName);
    if (!knowledge) return null;

    const workflowPrompt = this.getWorkflowPrompt(knowledge, taskDescription);
    if (!workflowPrompt) return null;

    console.log(`   📚 UI Knowledge: loaded ${appName} instruction set`);
    return workflowPrompt;
  }
}

export const uiKnowledge = new UIKnowledgeLayer();
