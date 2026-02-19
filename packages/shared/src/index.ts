// ============================================
// Clawd Cursor — Shared Types & Protocols
// ============================================

// --- Safety Tiers ---
export enum SafetyTier {
  /** Read-only, navigation, opening apps — executes immediately */
  Auto = 'auto',
  /** Typing, form filling — shows preview before executing */
  Preview = 'preview',
  /** Sending messages, deleting, purchases — requires explicit confirm */
  Confirm = 'confirm',
}

// --- Action Types ---
export type ActionKind =
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'type'
  | 'key_press'
  | 'scroll'
  | 'drag'
  | 'focus_window'
  | 'launch_app'
  | 'read_screen';

export interface Action {
  id: string;
  kind: ActionKind;
  target?: UIElement;
  params?: Record<string, unknown>;
  safetyTier: SafetyTier;
  description: string;
  timestamp: number;
}

export interface ActionResult {
  actionId: string;
  success: boolean;
  error?: string;
  screenshot?: string; // base64 if vision was used
  duration: number;
}

// --- UI Elements (from accessibility tree) ---
export interface UIElement {
  id: string;
  role: string;          // button, textbox, menuitem, etc.
  name: string;          // accessible name
  value?: string;
  bounds: Rect;
  children?: UIElement[];
  automationId?: string;
  className?: string;
  processId?: number;
  windowHandle?: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// --- Window Info ---
export interface WindowInfo {
  handle: number;
  title: string;
  className: string;
  processId: number;
  processName: string;
  bounds: Rect;
  isVisible: boolean;
  isFocused: boolean;
}

// --- Cursor State ---
export interface CursorState {
  x: number;
  y: number;
  visible: boolean;
  animation?: 'idle' | 'moving' | 'clicking' | 'typing';
  trail?: Array<{ x: number; y: number; t: number }>;
}

// --- WebSocket Messages ---
export type WSMessage =
  | { type: 'cursor_update'; data: CursorState }
  | { type: 'action_preview'; data: Action }
  | { type: 'action_execute'; data: Action }
  | { type: 'action_result'; data: ActionResult }
  | { type: 'action_confirm'; data: { actionId: string; approved: boolean } }
  | { type: 'status_update'; data: AgentStatus }
  | { type: 'kill'; data: {} };

// --- Agent Status ---
export interface AgentStatus {
  state: 'idle' | 'thinking' | 'acting' | 'waiting_confirm' | 'paused';
  currentTask?: string;
  actionQueue: number;
  uptime: number;
}

// --- Config ---
export interface ClawdConfig {
  overlay: {
    cursorColor: string;
    cursorSize: number;
    showTrail: boolean;
    showStatusBar: boolean;
    hotkey: string; // e.g. "Ctrl+Shift+G"
  };
  safety: {
    defaultTier: SafetyTier;
    confirmApps: string[];    // apps that always require confirm
    blockedApps: string[];    // apps the AI cannot touch
  };
  ai: {
    provider: 'openclaw' | 'direct';
    model?: string;
    visionModel?: string;
  };
  server: {
    port: number;
    host: string;
  };
}

export const DEFAULT_CONFIG: ClawdConfig = {
  overlay: {
    cursorColor: '#7c3aed',
    cursorSize: 24,
    showTrail: true,
    showStatusBar: true,
    hotkey: 'Ctrl+Shift+G',
  },
  safety: {
    defaultTier: SafetyTier.Preview,
    confirmApps: ['outlook', 'thunderbird', 'slack', 'teams', 'discord'],
    blockedApps: [],
  },
  ai: {
    provider: 'openclaw',
  },
  server: {
    port: 3847,
    host: '127.0.0.1',
  },
};
