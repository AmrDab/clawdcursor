/**
 * Every result code a tool result can carry. One copy, used by the client (result-codes.ts) and by the telemetry Worker
 * that checks each event (telemetry-worker/src/index.ts, which wrangler bundles with this file): so no imports here.
 */
export const RESULT_CODES = [
  'CONSENT_REQUIRED', 'KEYBOARD_OWNED', 'SECURE_INPUT', 'SCREEN_LOCKED', 'CAPTURE_DENIED', 'VISION_DISABLED', 'OWN_UI', 'PAUSED', 'NOT_CONFIRMED', 'DANGEROUS_KEY',
  'STOPPED', 'FOREGROUND_CHANGED', 'FENCED', 'CROSS_ORIGIN_FRAME',
  'INVALID_ARGS', 'READBACK_MISMATCH', 'REPEATED', 'STALE_SCREENSHOT', 'DEVIATION', 'STALE_REF', 'TIMEOUT', 'NOT_FOUND', 'UNSUPPORTED_ACTION', 'ELEMENT_HIDDEN', 'AMBIGUOUS', 'ACTION_FAILED', 'NOT_CONNECTED', 'UNKNOWN',
] as const;

export type ResultCode = typeof RESULT_CODES[number];
