/**
 * Sense-layer shared types — Snapshot, SnapshotElement, Platform.
 *
 * Used by the snapshot builder (snapshot.ts) and the UI-map compiler (ui-map*.ts).
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
 * A perception snapshot. captureSnapshot fills it from the a11y tree only;
 * OCR is fused on top later, by compileUIMap.
 */
export interface Snapshot {
  platform: Platform;
  /** Active window when the snapshot was taken. */
  activeWindow?: {
    processId: number;
    processName: string;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
  };
  /** Elements with on-screen bounds. */
  elements: SnapshotElement[];
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
