/**
 * @clawd-cursor/router
 * 
 * Action Router & Safety Layer — the brain that translates
 * LLM intent into concrete automation actions, choosing between
 * automation APIs and vision fallback, and enforcing safety tiers.
 * 
 * TODO:
 * - [ ] Intent parser (LLM output → Action objects)
 * - [ ] Strategy selector (automation vs vision vs hybrid)
 * - [ ] Safety tier classifier per action
 * - [ ] Action queue with ordering
 * - [ ] Confirmation flow (pause for user approval on 🔴 actions)
 * - [ ] Undo stack
 * - [ ] Audit logger
 */

import { Action, ActionResult, SafetyTier } from '@clawd-cursor/shared';

export interface ActionRouter {
  /** Parse LLM intent into actions */
  planActions(intent: string, context: ScreenContext): Promise<Action[]>;
  
  /** Execute an action (auto-selects automation vs vision) */
  execute(action: Action): Promise<ActionResult>;
  
  /** Get safety tier for an action */
  classifySafety(action: Action): SafetyTier;
  
  /** Request user confirmation for an action */
  requestConfirm(action: Action): Promise<boolean>;
  
  /** Undo last action if possible */
  undo(): Promise<boolean>;
  
  /** Get audit log */
  getLog(): Action[];
}

export interface ScreenContext {
  activeWindow?: string;
  openApps: string[];
  clipboardText?: string;
  recentActions: Action[];
}
