/**
 * Layer B — pure, deterministic semantic finders over a compiled UIMap.
 * Turn an intent/purpose into the best el_NN. No LLM, no platform calls,
 * no process.platform branching. See the Layer B design spec.
 *
 * BOUNDARY: ranks only elements the UIMap marks clickable/editable (a11y-exposed
 * interactive elements, where the Part-2 ref-act chain is valid). OCR text is a
 * label SOURCE only (Task 3), not an independent actionable candidate.
 */
import type { UIElement, Role } from './ui-map-types';
import { normText } from './ui-map-normalize';

export const MATCH_THRESHOLD = 0.4;   // min score×confidence to count as a match
export const AMBIGUITY_MARGIN = 0.05; // top-two closeness that forces 'ambiguous'
export const MAX_CANDIDATES = 5;

export interface FindCandidate { element_id: string; label: string; role: Role; score: number; confidence: number; }
export type FindResult =
  | { status: 'ok'; snapshot_id: string; best: FindCandidate; candidates: FindCandidate[] }
  | { status: 'ambiguous'; snapshot_id: string; reason: string; candidates: FindCandidate[] }
  | { status: 'none'; snapshot_id: string; reason: string; candidates: FindCandidate[] };

/** Curated intent → synonym sets. Unknown intents fall back to literal/token match. */
const ACTION_SYNONYMS: Record<string, string[]> = {
  submit: ['submit', 'send', 'ok', 'confirm', 'save', 'continue', 'next', 'post', 'publish', 'apply', 'done', 'go'],
  cancel: ['cancel', 'close', 'dismiss', 'back', 'no'],
  delete: ['delete', 'remove', 'trash', 'discard'],
  search: ['search', 'find', 'go', 'query'],
  login: ['login', 'log in', 'sign in', 'signin'],
  open: ['open', 'launch', 'view'],
  add: ['add', 'new', 'create', 'plus'],
};

export interface ExpandedTerms {
  /** The normalized intent literal and its tokens — exact match → score 1.0. */
  literals: Set<string>;
  /** Synonyms drawn from the table — synonym match → score 0.9. */
  synonyms: Set<string>;
}

/** Expand an intent into literal + synonym sets. Keeps exact vs synonym distinct
 *  so that scoreLabel can assign different raw scores to each tier. */
export function expandTerms(intent: string, table: Record<string, string[]>): ExpandedTerms {
  const lit = normText(intent);
  const literals = new Set<string>([lit]);
  lit.split(' ').filter(Boolean).forEach(t => literals.add(t));
  literals.delete('');

  const synonyms = new Set<string>();
  for (const [key, syns] of Object.entries(table)) {
    if (key === lit || syns.includes(lit)) {
      syns.forEach(s => {
        if (!literals.has(s)) synonyms.add(s);
      });
    }
  }
  return { literals, synonyms };
}

/** Raw 0..1 match of a label against the term sets (no confidence yet).
 *  Literal exact → 1.0; synonym exact / literal substring → 0.9; token overlap → ≤0.5. */
export function scoreLabel(label: string, { literals, synonyms }: ExpandedTerms, intentTokens: string[]): number {
  // Field labels often end in a colon ("File name:"): compare without it.
  const L = normText(label).replace(/\s*[:：]$/, '');
  if (!L) return 0;
  const phrase = intentTokens.join(' ');
  if (L === phrase) return 1.0;
  const lTokens = L.split(' ').filter(Boolean);
  const lSet = new Set(lTokens);
  if (intentTokens.length > 1) {
    // Multi-word intent ("file name"): the whole phrase beats any single word of
    // it — a "Name" column must not outrank the "File name:" box.
    if (` ${L} `.includes(` ${phrase} `)) return 0.95;
    for (const t of synonyms) {
      if (lSet.has(t) || (t.length > 2 && L.includes(t))) return 0.9;
    }
    const overlap = intentTokens.filter(t => lSet.has(t)).length;
    return overlap > 0 ? 0.5 + 0.4 * (overlap / intentTokens.length) : 0;
  }
  // Exact literal match (highest tier)
  if (literals.has(L)) return 1.0;
  // Synonym exact match or literal term as whole word / substring in label
  for (const t of synonyms) {
    if (lSet.has(t)) return 0.9;
    if (t.length > 2 && L.includes(t)) return 0.9;
  }
  for (const t of literals) {
    if (lSet.has(t)) return 0.9;                          // intent token is a whole word in the label
    if (t.length > 2 && L.includes(t)) return 0.9;        // intent token is a substring of the label
  }
  const overlap = intentTokens.filter(t => lSet.has(t)).length;
  return intentTokens.length > 0 ? 0.5 * (overlap / intentTokens.length) : 0;
}

/** Shared finder core. `labelOf` lets fields override with geometric association. */
export function runFinder(
  elements: UIElement[],
  snapshotId: string,
  intent: string,
  table: Record<string, string[]>,
  isCandidate: (e: UIElement) => boolean,
  labelOf: (e: UIElement, all: UIElement[]) => string,
): FindResult {
  const terms = expandTerms(intent, table);
  const intentTokens = normText(intent).split(' ').filter(Boolean);
  const scored: FindCandidate[] = [];
  for (const e of elements) {
    if (!isCandidate(e)) continue;
    const label = labelOf(e, elements);
    const raw = scoreLabel(label, terms, intentTokens);
    if (raw <= 0) continue;
    scored.push({ element_id: e.id, label, role: e.role, score: raw * e.confidence, confidence: e.confidence });
  }
  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, MAX_CANDIDATES);
  const best = scored[0];
  if (!best || best.score < MATCH_THRESHOLD) {
    return { status: 'none', snapshot_id: snapshotId, reason: 'no candidate cleared the match threshold', candidates };
  }
  const second = scored[1];
  if (second && best.score - second.score < AMBIGUITY_MARGIN) {
    return { status: 'ambiguous', snapshot_id: snapshotId, reason: `top candidates within ${AMBIGUITY_MARGIN} score margin`, candidates };
  }
  return { status: 'ok', snapshot_id: snapshotId, best, candidates };
}

export function findActionButton(elements: UIElement[], snapshotId: string, intent: string): FindResult {
  return runFinder(elements, snapshotId, intent, ACTION_SYNONYMS,
    e => e.clickable === true,
    e => e.normalized_text ?? '');
}

const MAX_LABEL_GAP_X = 240;  // px: a left label's right edge to the field's left edge
const MAX_LABEL_GAP_Y = 64;   // px: an above label's bottom edge to the field's top edge

const LABEL_ROLES = new Set<Role>(['text', 'link', 'unknown']);

/** Find the descriptive label for an (unnamed) field by geometry: nearest text
 *  element to the LEFT (same row) preferred, else ABOVE (same column). a11y OR
 *  OCR sourced. Returns '' when none is within range. Pure geometry. */
export function associateLabel(field: UIElement, all: UIElement[]): string {
  const [fx, fy, fw, fh] = field.bounds;
  let left: { gap: number; label: string } | null = null;
  let above: { gap: number; label: string } | null = null;
  for (const e of all) {
    if (e.id === field.id || !LABEL_ROLES.has(e.role)) continue;
    const label = e.normalized_text ?? '';
    if (!label) continue;
    const [ex, ey, ew, eh] = e.bounds;
    const eRight = ex + ew;
    const eBottom = ey + eh;
    const eCenterY = ey + eh / 2;
    const eCenterX = ex + ew / 2;
    // LEFT, same row: label's vertical center within the field's y-band, right edge just left of the field.
    const sameRow = eCenterY >= fy && eCenterY <= fy + fh;
    if (sameRow && eRight <= fx + 4) {
      const gap = fx - eRight;
      if (gap >= 0 && gap <= MAX_LABEL_GAP_X && (!left || gap < left.gap)) left = { gap, label };
    }
    // ABOVE, same column: label horizontally overlaps the field, bottom just above the field top.
    const sameCol = eCenterX >= fx && eCenterX <= fx + fw;
    if (sameCol && eBottom <= fy + 4) {
      const gap = fy - eBottom;
      if (gap >= 0 && gap <= MAX_LABEL_GAP_Y && (!above || gap < above.gap)) above = { gap, label };
    }
  }
  return (left ?? above)?.label ?? '';
}

/** Curated field-purpose → synonym sets. */
const FIELD_SYNONYMS: Record<string, string[]> = {
  recipient: ['to', 'recipient', 'email', 'address', 'send to'],
  cc: ['cc', 'carbon copy'],
  subject: ['subject', 'title', 're'],
  body: ['body', 'message', 'content', 'compose', 'note'],
  search: ['search', 'query', 'find', 'filter'],
  password: ['password', 'pass', 'pwd'],
  username: ['username', 'user', 'login', 'email'],
  name: ['name', 'full name'],
};

export function findInputField(elements: UIElement[], snapshotId: string, purpose: string): FindResult {
  return runFinder(elements, snapshotId, purpose, FIELD_SYNONYMS,
    e => e.editable === true,
    (e, all) => {
      const own = e.normalized_text ?? '';
      return own !== '' ? own : associateLabel(e, all);
    });
}
