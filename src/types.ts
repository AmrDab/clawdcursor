// ============================================
// Clawd Cursor — Core Types
// ============================================

export enum SafetyTier {
  Auto = 'auto',
  Preview = 'preview',
  Confirm = 'confirm',
}

export interface ScreenFrame {
  width: number;
  height: number;
  buffer: Buffer;
  timestamp: number;
  format: 'png' | 'jpeg' | 'raw';
}

export interface MouseAction {
  kind: 'click' | 'double_click' | 'right_click' | 'move' | 'drag' | 'scroll';
  x: number;
  y: number;
  endX?: number;
  endY?: number;
  scrollDelta?: number;
}

export interface KeyboardAction {
  kind: 'type' | 'key_press';
  text?: string;
  key?: string;
}

export interface A11yAction {
  kind: 'a11y_click' | 'a11y_set_value' | 'a11y_focus' | 'a11y_get_value';
  name?: string;
  automationId?: string;
  controlType?: string;
  value?: string;
}

export type InputAction = MouseAction | KeyboardAction | A11yAction;

// A sequence of actions to execute without re-screenshotting
export interface ActionSequence {
  kind: 'sequence';
  steps: Array<InputAction & { description: string }>;
  description: string;
}

export interface TaskRequest {
  task: string;
  app?: string;            // pre-parsed app to open (skill mode)
  navigate?: string;       // pre-parsed URL to navigate to (skill mode)
  context?: string;        // current screen state description (skill mode)
  contextHints?: string[]; // site/platform hints for shortcut matching
  safetyOverride?: SafetyTier;
}

export interface TaskResult {
  success: boolean;
  steps: StepResult[];
  error?: string;
  duration: number;
}

export interface StepResult {
  action: string;
  description: string;
  success: boolean;
  screenshot?: string;
  error?: string;
  timestamp: number;
}

export interface AgentState {
  status: 'idle' | 'thinking' | 'acting' | 'waiting_confirm' | 'paused';
  currentTask?: string;
  currentStep?: string;
  stepsCompleted: number;
  stepsTotal: number;
}

export interface ClawdConfig {
  server: {
    port: number;
    host: string;
  };
  ai: {
    provider: string;
    apiKey?: string;
    /** Optional OpenAI-compatible endpoint override (skill-host supplied). */
    baseUrl?: string;
    /** Optional text-only endpoint/key for decomposition (can differ from vision). */
    textBaseUrl?: string;
    textApiKey?: string;
    /** Optional vision endpoint/key for screenshot reasoning (can differ from text). */
    visionBaseUrl?: string;
    visionApiKey?: string;
    model: string;
    visionModel: string;
  };
  safety: {
    defaultTier: SafetyTier;
    confirmPatterns: string[];
    blockedPatterns: string[];
  };
  capture: {
    format: 'png' | 'jpeg';
    quality: number;
  };
  /** Save screenshots to debug/ folder. Off by default for security. */
  debug?: boolean;
}

export const DEFAULT_CONFIG: ClawdConfig = {
  server: {
    port: 3847,
    host: '127.0.0.1',
  },
  ai: {
    provider: 'auto',
    model: '',
    visionModel: '',
  },
  safety: {
    defaultTier: SafetyTier.Preview,
    confirmPatterns: [
      'send', 'delete', 'remove', 'purchase', 'buy', 'pay', 'submit',
      'terminal', 'console', 'cmd\\.exe', 'powershell', 'bash', 'shell',
      'sudo', 'del /[fq]', 'reboot', 'password', 'credential', 'secret',
      'sign.?in', 'log.?in', 'authorize', 'transfer', 'wire',
    ],
    blockedPatterns: [
      'format.*disk', 'format c:', 'rm -rf /', 'shutdown', 'shutdown /s',
      'reboot', 'mkfs', 'dd if=', 'diskpart', ':(){:|:&};:',
    ],
  },
  capture: {
    format: 'jpeg',
    quality: 50,
  },
};
