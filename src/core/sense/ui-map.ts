/**
 * UI State Compiler (Layer A). Fuses a11y + OCR + (lazy) vision + window/display
 * metadata into one UIMap. Pure orchestration over injected sources so it is
 * unit-testable with no real UIA/OCR. See the design spec
 * docs/superpowers/specs/2026-06-07-ui-state-compiler-design.md.
 */
import type { PlatformAdapter, ScreenshotResult } from '../../platform/types';
import type { Snapshot } from './types';
import type { OcrResult } from '../../platform/ocr-engine';
import type { UIMap, UIElement, Bounds, Source, CompileHints } from './ui-map-types';
import { a11yToUI, ocrToUI } from './ui-map-elements';
import { fuse } from './ui-map-fuse';
import { computeAnchors } from './ui-map-anchors';
import { normalizeRole, normText } from './ui-map-normalize';
import { iou } from './ui-map-geom';
import { captureSnapshot } from './snapshot';
import { OcrEngine } from '../../platform/ocr-engine';
import { ocrPointToClickPoint } from '../../tools/smart';
import { windowOcrRegion } from '../../tools/ocr';

const SPARSE_A11Y_MAX = 0;          // ≤ this many named a11y elements ⇒ "sparse"
const LOW_CONFIDENCE = 0.5;         // below this on a needed element ⇒ vision-worthy

export interface CompileDeps {
  /** a11y spine — defaults to captureSnapshot(adapter) in production. */
  captureSnapshot: () => Promise<Snapshot>;
  /** OCR puller — defaults to () => new OcrEngine().recognizeScreen(). */
  ocr: () => Promise<OcrResult>;
  /** Vision puller — defaults to adapter.screenshot(). */
  vision: () => Promise<ScreenshotResult>;
  getScreenSize: PlatformAdapter['getScreenSize'];
  getFocusedElement: PlatformAdapter['getFocusedElement'];
  /** Previous turn's anchors, for cross-turn continuity (optional). */
  prevAnchors?: UIMap['anchors'];
  /** Caller-passed clock + id (pure: no Date.now in this module). */
  now: number;
  snapshotId: string;
}

function namedCount(snap: Snapshot): number {
  return snap.elements.filter(e => (e.name ?? '').trim().length > 0).length;
}

export async function compileUIMap(deps: CompileDeps, hints: CompileHints): Promise<UIMap> {
  const maxCost = hints.max_cost ?? 'ocr_ok';
  const sourcesUsed: Source[] = ['window'];

  const snap = await deps.captureSnapshot();
  if (snap.sources.includes('a11y')) sourcesUsed.push('a11y');

  let elements: UIElement[] = snap.elements.map((se, i) => a11yToUI(se, `el_${i}`));

  // Lazy OCR: only when a11y is sparse OR a requested target_text isn't present.
  const sparse = namedCount(snap) <= SPARSE_A11Y_MAX;
  const wantText = hints.target_text ? hints.target_text.trim().toLowerCase() : '';
  const a11yHasTarget = wantText
    ? elements.some(e => (e.normalized_text ?? '').includes(wantText))
    : true;
  const ocrAllowed = maxCost === 'ocr_ok' || maxCost === 'vision_ok';
  if (ocrAllowed && (sparse || !a11yHasTarget)) {
    const ocrRes = await Promise.resolve(deps.ocr()).catch(() => null);
    if (ocrRes && ocrRes.elements.length > 0) {
      sourcesUsed.push('ocr');
      const base = elements.length;
      elements = fuse([...elements, ...ocrRes.elements.map((oe, i) => ocrToUI(oe, `el_${base + i}`))]);
    }
  }

  // Lazy vision: only when allowed AND nothing usable surfaced from a11y+OCR.
  const visionAllowed = maxCost === 'vision_ok';
  const nothingActionable = !elements.some(e => e.actionable && e.confidence >= LOW_CONFIDENCE);
  if (visionAllowed && nothingActionable) {
    const shot = await Promise.resolve(deps.vision()).catch(() => null);
    if (shot) sourcesUsed.push('vision');
  }

  // Re-id ids contiguously after fusion so el_NN is dense within this snapshot.
  elements = elements.map((e, i) => ({ ...e, id: `el_${i}` }));

  // Mark the focused element so the focused anchor resolves. The platform's
  // focused element carries name, role AND bounds — match it into the fused map
  // by name+role, disambiguating ties (and empty-name canvas/editor surfaces)
  // via nearest bounds (spec §5: role + normalized_text + nearest bounds).
  const focused = await deps.getFocusedElement().catch(() => null);
  if (focused) {
    const fname = normText(focused.name);
    const frole = normalizeRole(focused.controlType);
    const fb = focused.bounds;
    const fbounds: Bounds | null =
      fb && fb.width > 0 && fb.height > 0 ? [fb.x, fb.y, fb.width, fb.height] : null;
    const named = fname !== ''
      ? elements.filter(e => e.normalized_text === fname && e.role === frole)
      : [];
    const bestByIou = (els: UIElement[], b: Bounds): UIElement | undefined =>
      els.length === 0 ? undefined
        : els.reduce((best, e) => (iou(e.bounds, b) > iou(best.bounds, b) ? e : best), els[0]);
    let hit: UIElement | undefined;
    if (named.length === 1) {
      hit = named[0];
    } else if (named.length > 1) {
      hit = fbounds ? bestByIou(named, fbounds) : named[0];
    } else if (fbounds) {
      // No name match (or empty name) — fall back to the nearest overlapping
      // element, but only accept a real overlap to avoid false positives.
      const cand = bestByIou(elements, fbounds);
      if (cand && iou(cand.bounds, fbounds) > 0) hit = cand;
    }
    if (hit) hit.state = { ...hit.state, focused: true };
  }

  const screen = await deps.getScreenSize();
  const aw = snap.activeWindow;
  return {
    snapshot_id: deps.snapshotId,
    platform: snap.platform,
    active_app: aw?.processName ?? '',
    process_id: aw ? String(aw.processId) : undefined,
    window_title: aw?.title ?? '',
    window_bounds: aw ? [aw.bounds.x, aw.bounds.y, aw.bounds.width, aw.bounds.height] : [0, 0, 0, 0],
    coordinate_space: 'screen',
    scale_factor: screen.dpiRatio,
    compiled_at: String(deps.now),
    sources_used: sourcesUsed,
    elements,
    // Scrolled out of view: text only — no bounds to click, so never ranked,
    // anchored or addressable by element_id.
    ...(snap.offscreen?.length
      ? { offscreen: snap.offscreen.map((se, i) => ({ ...a11yToUI(se, `off_${i}`), clickable: false, editable: false, actionable: false })) }
      : {}),
    anchors: computeAnchors(elements, deps.prevAnchors),
    truncation: { total_elements: elements.length, returned_elements: elements.length },
  };
}

let _ocr: OcrEngine | null = null;
function ocrEngine(): OcrEngine { return (_ocr ??= new OcrEngine()); }

/** Production deps wired to a real adapter. now/snapshotId are caller-passed
 *  (the agent loop owns the clock + the obs_N counter). `processId` scopes the
 *  map to that app's window: its a11y tree, and OCR of its window only. */
export function defaultCompileDeps(
  adapter: PlatformAdapter, now: number, snapshotId: string, prevAnchors?: UIMap['anchors'], processId?: number,
): CompileDeps {
  let scopedWindow: Snapshot['activeWindow'];
  return {
    captureSnapshot: async () => {
      const snap = await captureSnapshot(adapter, processId);
      scopedWindow = snap.activeWindow;
      return snap;
    },
    // OCR reads physical pixels; the map is in screen coordinates (points on
    // macOS — live: a word at x=3874 on a 2240-pt screen).
    ocr: async () => {
      const ratio = (await adapter.getScreenSize().catch(() => null))?.dpiRatio || 1;
      let res: OcrResult;
      if (processId) {
        const region = windowOcrRegion(scopedWindow?.processId === processId ? scopedWindow.bounds : undefined, ratio, adapter.platform);
        // Never the whole screen for a scoped map: that is other apps' text.
        if (!region) return { elements: [], fullText: '', durationMs: 0 };
        res = await ocrEngine().recognizeRegion(region.x, region.y, region.width, region.height);
      } else {
        res = await ocrEngine().recognizeScreen();
      }
      return {
        ...res,
        elements: res.elements.map(el => {
          const p = ocrPointToClickPoint(el.x, el.y, ratio, adapter.platform);
          const size = ocrPointToClickPoint(el.width, el.height, ratio, adapter.platform);
          return { ...el, x: p.x, y: p.y, width: size.x, height: size.y };
        }),
      };
    },
    vision: () => adapter.screenshot({ maxWidth: 1280 }),
    getScreenSize: () => adapter.getScreenSize(),
    getFocusedElement: () => adapter.getFocusedElement(),
    now, snapshotId, prevAnchors,
  };
}
