/**
 * Sense-layer shared types — Snapshot, SnapshotElement, Platform.
 *
 * These types are used by the snapshot builder, fingerprint, rank, and the
 * agent-loop prompt renderer. Extracted here so they survive pipeline deletion.
 */

export type Platform = 'windows' | 'macos' | 'linux';

/**
 * A single element in the merged perception snapshot.
 * Coordinates are in real screen pixels (after DPI scaling).
 */
export interface SnapshotElement {
  /** Human-readable label (a11y name or OCR text). */
  name: string;
  /** Accessibility role / control type when known. */
  role?: string;
  /** Top-left screen coords (after DPI scaling). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Source of this element — preserved so agents can prefer a11y when available. */
  source: 'a11y' | 'ocr' | 'cdp';
  /** A11y-specific automation ID, if present. */
  automationId?: string;
  /** Whether the element accepts input (button, link, input). */
  interactive?: boolean;
  /** Whether the field is a password/secure field — redacted in `value`. */
  secure?: boolean;
  /** Current text value for inputs (redacted if `secure`). */
  value?: string;
  /** Process ID of the owning window. */
  processId?: number;
}

/**
 * A merged perception snapshot — one call, parallel OCR + a11y + optional CDP.
 * Modeled on the per-turn perception snapshot; extended with fingerprint for
 * stagnation detection.
 */
export interface Snapshot {
  /** Source platform. */
  platform: Platform;
  /** Active window when the snapshot was taken. */
  activeWindow?: {
    processId: number;
    processName: string;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
  };
  /** All elements merged from a11y + OCR + CDP, de-duped by spatial overlap. */
  elements: SnapshotElement[];
  /**
   * Stable fingerprint of the snapshot — same UI produces same string, used by
   * the agent loop to detect "nothing changed, stop retrying the same action".
   */
  fingerprint: string;
  /** Timestamp for staleness checks. */
  capturedAt: number;
  /** Which sources successfully contributed; empty sources fell back silently. */
  sources: Array<'a11y' | 'ocr' | 'cdp'>;
  /**
   * Named a11y elements scrolled out of view (empty bounds), kept OUT of
   * `elements` (nothing to click, no geometry) but readable by name/value.
   */
  offscreen?: SnapshotElement[];
}
