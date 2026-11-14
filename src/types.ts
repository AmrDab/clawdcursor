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

export interface ClawdConfig {
  /** The daemon binds 127.0.0.1 only; there is no host setting (#293). */
  server: {
    port: number;
  };
  capture: {
    format: 'png' | 'jpeg';
    quality: number;
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
