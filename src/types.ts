// ============================================
// Clawd Cursor — Core Types
// ============================================

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

export interface ClawdConfig {
  /** The daemon binds 127.0.0.1 only; there is no host setting (#293). */
  server: {
    port: number;
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
  capture: {
    format: 'jpeg',
    quality: 50,
  },
};
