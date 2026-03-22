/**
 * Task Classifier — zero LLM cost, regex-based.
 *
 * Classifies subtasks into categories to route them to the optimal pipeline layer.
 * Mechanical tasks skip the Unified Reasoner entirely. Spatial tasks skip straight
 * to Vision. This REDUCES total LLM calls, not increases them.
 */

export type TaskCategory = 'mechanical' | 'navigation' | 'reasoning' | 'spatial';

export interface TaskClassification {
  category: TaskCategory;
  confidence: number;           // 0–1
  suggestedLayers: number[];    // [1]=Router, [2]=Unified, [3]=Vision
  needsVision: boolean;         // true → skip text-only layers
  timeoutMs: number;            // adaptive timeout for this category
}

// ── Patterns ────────────────────────────────────────────────────────────────

const MECHANICAL_START = /^(open|close|press|click|tap|type|save\s+(the\s+file\s+)?as|minimize|maximize|focus|switch to)\b/i;
const MECHANICAL_FULL  = /^(select all|undo|redo|copy|paste|cut|delete|scroll (up|down)|go back|go forward|refresh)\b/i;

// "click in/on the middle/center/area" → needs LLM to calculate position from screen data
const POSITIONAL_CLICK = /\b(click|tap)\s+(in|on|at)\s+(the\s+)?(middle|center|top|bottom|left|right|corner|area|canvas|screen|background|workspace)\b/i;

const NAVIGATION = /\b(go to|navigate to|visit|open\s+https?:|browse to|search for|find on page)\b/i;
const NAVIGATION_URL = /\b(https?:\/\/|www\.|\.com|\.org|\.io|\.dev|\.net)\b/i;

const SPATIAL = /\b(draw|sketch|paint|design|arrange|drag\s.*\bto\b|resize|move\s+(the\s+)?element|color|shade|fill\s+(with|in)|illustrate|diagram|annotate)\b/i;

const REASONING = /\b(compose|write|draft|fill\s+(out|in)\b|log\s*in|sign\s*in|register|check|compare|review|analyze|read|summarize|reply|respond|forward)\b/i;
const EMAIL = /\b(email|send\s+(an?\s+)?email|compose\s+mail|send\s+to\s+\S+@)\b/i;

/**
 * Classify a subtask — pure regex, zero LLM cost.
 */
export function classifyTask(task: string): TaskClassification {
  const t = task.trim();

  // ── Spatial — OCR Reasoner has drag support and is 2x faster than vision.
  // Let Unified Reasoner (OCR+A11y) handle spatial tasks with its drag action.
  // Vision is fallback only if OCR fails.
  if (SPATIAL.test(t)) {
    return {
      category: 'spatial',
      confidence: 0.9,
      suggestedLayers: [2, 3],
      needsVision: false,    // OCR Reasoner handles drags — no vision needed upfront
      timeoutMs: 90000,
    };
  }

  // ── Positional clicks — "click in the middle/center of [area]" ──
  // These need the Unified Reasoner to calculate coordinates from OCR/A11y data.
  // Router can't handle spatial position references like "middle of canvas".
  if (POSITIONAL_CLICK.test(t)) {
    return {
      category: 'reasoning',
      confidence: 0.85,
      suggestedLayers: [2, 3],
      needsVision: false,
      timeoutMs: 45000,
    };
  }

  // ── Mechanical — router can handle, no LLM needed ──
  if (MECHANICAL_START.test(t) || MECHANICAL_FULL.test(t)) {
    return {
      category: 'mechanical',
      confidence: 0.85,
      suggestedLayers: [1, 2],
      needsVision: false,
      timeoutMs: 30000,
    };
  }

  // ── Email — check BEFORE navigation (email addresses contain .com) ──
  if (EMAIL.test(t)) {
    return {
      category: 'reasoning',
      confidence: 0.9,
      suggestedLayers: [2, 3],
      needsVision: false,
      timeoutMs: 90000,
    };
  }

  // ── Navigation — router opens URL, unified verifies ──
  if (NAVIGATION.test(t) || NAVIGATION_URL.test(t)) {
    return {
      category: 'navigation',
      confidence: 0.85,
      suggestedLayers: [1, 2],
      needsVision: false,
      timeoutMs: 45000,
    };
  }

  // ── Reasoning — unified reasoner primary ──
  if (REASONING.test(t)) {
    return {
      category: 'reasoning',
      confidence: 0.7,
      suggestedLayers: [2, 3],
      needsVision: false,
      timeoutMs: 90000,
    };
  }

  // ── Default — try all layers, standard timeout ──
  return {
    category: 'reasoning',
    confidence: 0.5,
    suggestedLayers: [1, 2, 3],
    needsVision: false,
    timeoutMs: 55000,
  };
}
