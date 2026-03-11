/**
 * Safety Layer — classifies actions by risk tier
 * and enforces confirmation/blocking rules.
 */

import { SafetyTier } from './types';
import type { ClawdConfig, InputAction } from './types';

export class SafetyLayer {
  private config: ClawdConfig;
  private pendingConfirm: {
    resolve: (approved: boolean) => void;
    action: InputAction;
    description: string;
  } | null = null;

  constructor(config: ClawdConfig) {
    this.config = config;
  }

  /**
   * Classify an action's safety tier based on its description.
   */
  classify(action: InputAction, description: string): SafetyTier {
    const text = description.toLowerCase();

    // Check blocked patterns
    for (const pattern of this.config.safety.blockedPatterns) {
      if (new RegExp(pattern, 'i').test(text)) {
        return SafetyTier.Confirm; // Will be blocked at confirm stage
      }
    }

    // Check confirm patterns
    for (const pattern of this.config.safety.confirmPatterns) {
      if (new RegExp(pattern, 'i').test(text)) {
        return SafetyTier.Confirm;
      }
    }

    // Typing in a terminal context is Confirm tier — keystrokes could execute
    // shell commands. Typing in other contexts is Preview (user can see output).
    if ('text' in action && action.kind === 'type') {
      const terminalProcesses = ['cmd', 'powershell', 'pwsh', 'bash', 'zsh', 'sh',
        'wt', 'windowsterminal', 'terminal', 'iterm2', 'alacritty', 'hyper', 'conhost',
        'mintty', 'git bash', 'wsl'];
      const descLower = description.toLowerCase();
      const isTerminalContext = terminalProcesses.some(t => descLower.includes(t));
      return isTerminalContext ? SafetyTier.Confirm : SafetyTier.Preview;
    }

    // Everything else is auto
    return SafetyTier.Auto;
  }

  /**
   * Check if action is blocked entirely.
   */
  isBlocked(description: string): boolean {
    const text = description.toLowerCase();
    return this.config.safety.blockedPatterns.some(
      pattern => new RegExp(pattern, 'i').test(text)
    );
  }

  /**
   * Request confirmation from user for a dangerous action.
   * Returns a promise that resolves when user responds.
   */
  requestConfirmation(action: InputAction, description: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingConfirm = { resolve, action, description };
      console.log(`\n🔴 CONFIRMATION REQUIRED:`);
      console.log(`   Action: ${description}`);
      console.log(`   Approve via API: POST /confirm {"approved": true}`);
    });
  }

  /**
   * Respond to pending confirmation.
   */
  respondToConfirmation(approved: boolean): boolean {
    if (!this.pendingConfirm) return false;
    this.pendingConfirm.resolve(approved);
    this.pendingConfirm = null;
    return true;
  }

  hasPendingConfirmation(): boolean {
    return this.pendingConfirm !== null;
  }

  getPendingAction(): { action: InputAction; description: string } | null {
    if (!this.pendingConfirm) return null;
    return {
      action: this.pendingConfirm.action,
      description: this.pendingConfirm.description,
    };
  }
}

