/**
 * UI State Compiler (Layer A) data model. See
 * docs/superpowers/specs/2026-06-07-ui-state-compiler-design.md.
 */
import type { Platform } from './types';

/** Perception sources, ordered cheap → expensive. Array (not enum) for runtime checks. */
export const SOURCES = ['window', 'a11y', 'ocr', 'vision', 'dom', 'cursor'] as const;
export type Source = typeof SOURCES[number];

/** Normalized UI roles. Array (not enum) for runtime validation via ROLES.includes(). */
export const ROLES = [
  'button', 'input', 'text', 'link', 'checkbox',
  'list', 'listitem', 'tab', 'image', 'unknown',
] as const;
export type Role = typeof ROLES[number];

export type Bounds = [number, number, number, number]; // [x, y, w, h] — top-left origin, full width/height, screen pixels

export interface ElementRef {
  id: string;
  role: Role;
  normalized_text?: string;
}

export interface UIElement {
  id: string;
  role: Role;
  text?: string;
  normalized_text?: string;
  bounds: Bounds;
  confidence: number;
  sources: Source[];
  actionable?: boolean;
  clickable?: boolean;
  editable?: boolean;
  state?: {
    focused?: boolean;
    enabled?: boolean;
    selected?: boolean;
    expanded?: boolean;
    value?: string; // current field value (e.g. typed text); distinct from `text` (the label)
  };
}

export interface UIMap {
  snapshot_id: string;
  platform: Platform;
  active_app: string;
  process_id?: string;
  window_id?: string;
  window_title: string;
  window_bounds: Bounds;
  display_id?: string;
  coordinate_space: 'screen';
  scale_factor?: number;
  compiled_at: string;
  sources_used: Source[];
  elements: UIElement[];
  /** Named elements scrolled out of view: read-only (no bounds), never ranked or actionable by id. */
  offscreen?: UIElement[];
  anchors: { focused?: ElementRef; primary_action_candidate?: ElementRef };
  truncation?: { total_elements: number; returned_elements: number };
}

export type MaxCost = 'cheap' | 'ocr_ok' | 'vision_ok';
/** Caller knobs for compileUIMap. */
export interface CompileHints {
  purpose?: 'general' | 'find_text' | 'act'; // what the compile is for
  target_text?: string; // if set & absent from a11y, pull OCR to find it
  max_cost?: MaxCost; // hard ceiling on perception cost
}
