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
  // Structured logging fields:
  layer?: 'browser' | 'router' | 'smart' | 'ocr' | 'a11y' | 'unified' | 'computer-use' | 'deterministic';
  method?: string;           // 'a11y_invoke' | 'ocr_click' | 'keyboard' | 'mouse' | 'cdp'
  coordinates?: [number, number];
  elementName?: string;
  elementType?: string;      // 'Button', 'Edit', etc.
  verified?: boolean;        // post-action verification result
  latencyMs?: number;
}

export interface AgentState {
  status: 'idle' | 'thinking' | 'acting' | 'waiting_confirm' | 'paused';
  currentTask?: string;
  currentStep?: string;
  stepsCompleted: number;
  stepsTotal: number;
  /**
   * Result of the most recent `executeTask()` call. Populated when status
   * transitions back to `idle`; cleared at the start of the next task. Lets
   * external pollers (e.g. the `delegate_to_agent` compact tool) read the
   * outcome of a completed task without holding a reference to the
   * `executeTask` promise.
   */
  lastResult?: TaskResult;
}

export interface ClawdConfig {
  /** The daemon binds 127.0.0.1 only; there is no host setting (#293). */
  server: {
    port: number;
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
  browser?: {
    /** Custom browser executable path (overrides auto-detection) */
    executablePath?: string;
    /** Process name for accessibility matching (e.g. 'comet', 'brave') */
    processName?: string;
    /** CDP debugging port (default: 9223) */
    cdpPort?: number;
    /** Additional command-line args for browser launch */
    extraArgs?: string[];
  };
}

export const DEFAULT_CONFIG: ClawdConfig = {
  server: {
    port: 3847,
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
