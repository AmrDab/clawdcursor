/**
 * Pixels around an act (#357, #358): the capture side of core/sense/frame-diff.ts. Two uses:
 *   - the effect line's `pixels changed in (x,y WxH)`: a downscaled whole-screen frame before and after an acting call.
 *     It costs two captures per call, so it is OFF unless CLAWD_PIXEL_EFFECT=1;
 *   - `expect` region_changed / region_unchanged: a baseline of the asked region taken before the act (asked for, so on).
 * Frames come from the platform adapter's own screenshot (every OS has one), never from a new capture path.
 */
import sharp from 'sharp';
import type { PlatformAdapter } from '../platform/types';
import type { ToolContext } from './types';
import { screenToPhysical } from './types';
import { getLastFrame, mapImagePoint, mapImageLength } from '../platform/coord-scale';
import { parseAssertions, type RegionAssertion, type RegionProbe } from '../core/verify/assertions';
import { diffFrames, judgeRegion, REGION_MIN_PIXELS, SCREEN_MIN_PIXELS, type Grey, type Box } from '../core/sense/frame-diff';

/** Long edge of the whole-screen frame the effect line compares. */
const EFFECT_EDGE = 640;
/** Long edge of a region frame. Larger than the effect frame: a pen stroke must stay above the minimum area. */
const REGION_EDGE = 512;
/** Gap between the two baseline frames: long enough for video or an animation to move, short enough to delay the act little. */
const BASELINE_GAP_MS = 120;
/** region_unchanged waits this long after the act before it looks, so a render that lags the input is not missed. */
const UNCHANGED_SETTLE_MS = 300;
/** The effect line looks again this long after a first frame that showed no change, before it says `pixels same`. */
const SAME_RECHECK_MS = 250;

export const pixelEffectOn = (): boolean => /^(1|true|on|yes)$/i.test(process.env.CLAWD_PIXEL_EFFECT ?? '');

export interface GreyShot extends Grey { /** physical pixels per frame pixel */ scale: number }

/** A greyscale frame of the screen (or of `region`, in physical pixels), at most `maxEdge` on its long edge. */
export async function grabGrey(adapter: PlatformAdapter, opts: { maxEdge: number; region?: Box }): Promise<GreyShot> {
  const shot = await adapter.screenshot({ maxWidth: opts.maxEdge, ...(opts.region ? { region: opts.region } : {}) });
  const { data, info } = await sharp(shot.buffer).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height, scale: shot.scaleFactor || 1 };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export interface PixelEffect { text: string; box?: Box }

/**
 * Before an acting call: the frame to compare against. Returns what to call after the act for the pixel part of the effect
 * line (`pixels changed in (x,y WxH)` / `pixels same`; '' when it cannot be told), or null when the effect is off, vision is
 * disabled (no screen read at all), or the first capture failed.
 */
export async function startPixelEffect(ctx: ToolContext): Promise<null | (() => Promise<PixelEffect>)> {
  if (!pixelEffectOn() || ctx.disableVision || !ctx.platform) return null;
  const adapter = ctx.platform;
  const before = await grabGrey(adapter, { maxEdge: EFFECT_EDGE }).catch(() => null);
  if (!before) return null;
  return async () => {
    try {
      let after = await grabGrey(adapter, { maxEdge: EFFECT_EDGE });
      let d = diffFrames(before, after);
      if (!d.box || d.count < SCREEN_MIN_PIXELS) {
        // A redraw can lag the input: look once more before saying nothing changed (a "same" invites a second send).
        await sleep(SAME_RECHECK_MS);
        after = await grabGrey(adapter, { maxEdge: EFFECT_EDGE });
        d = diffFrames(before, after);
      }
      if (!d.box || d.count < SCREEN_MIN_PIXELS) return { text: 'pixels same' };
      // Frame pixels → physical → screen units (what a11y reports and space:"screen" takes: points on macOS).
      const k = after.scale / screenToPhysical(ctx);
      const box = { x: Math.round(d.box.x * k), y: Math.round(d.box.y * k), width: Math.max(1, Math.round(d.box.width * k)), height: Math.max(1, Math.round(d.box.height * k)) };
      return { text: `pixels changed in (${box.x},${box.y} ${box.width}x${box.height})`, box };
    } catch { return { text: '' }; }
  };
}

/**
 * The effect line with its pixel part: joins the line the act already carries (window / focus, or the batch's) with " · ",
 * else starts one. A changed box adds the one cheap look to take next: a zoom on just that box.
 */
export function withPixelEffect(text: string, px: PixelEffect, o: { compact: boolean; batch: boolean }): string {
  if (!px.text) return text;
  const lines = text.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^effect\b/.test(lines[i])) { at = i; break; }
  if (at >= 0) lines[at] += ` · ${px.text}`;
  else lines.push(`${o.batch ? 'effect (whole batch)' : 'effect'}: ${px.text}`);
  if (px.box) {
    const b = px.box;
    const args = `"x":${b.x},"y":${b.y},"width":${b.width},"height":${b.height},"space":"screen","max_edge":512`;
    lines.splice(at >= 0 ? at + 1 : lines.length, 0,
      `look: ${o.compact ? `computer {"action":"screenshot_region",${args}}` : `desktop_screenshot_region {${args}}`}`);
  }
  return lines.join('\n');
}

// ── expect: region_changed / region_unchanged ─────────────────────────────

/** The region in physical capture pixels, by the rules `screenshot_region` uses: image space by default, "screen" as a11y reports. */
function physicalRegion(ctx: ToolContext, a: RegionAssertion): Box {
  const screen = a.space === 'screen';
  const mapping = screen ? null : getLastFrame();
  const sf = screen ? screenToPhysical(ctx) : ctx.getScreenshotScaleFactor();
  if (mapping) {
    const p = mapImagePoint(a.x, a.y, sf, mapping);
    return { x: p.x, y: p.y, width: mapImageLength(a.width, sf, mapping), height: mapImageLength(a.height, sf, mapping) };
  }
  return { x: Math.round(a.x * sf), y: Math.round(a.y * sf), width: Math.max(1, Math.round(a.width * sf)), height: Math.max(1, Math.round(a.height * sf)) };
}

const keyOf = (a: RegionAssertion) => `${a.x},${a.y},${a.width},${a.height},${a.space ?? 'image'}`;

/**
 * Before the act: two frames of each region the `expect` asks about, BASELINE_GAP_MS apart (the second is what the act is
 * compared with; the first shows motion that needs no act). Null when `expect` has no region check.
 */
export async function startRegionWatch(expect: unknown, ctx: ToolContext): Promise<RegionProbe | null> {
  const parsed = expect === undefined || expect === null ? null : parseAssertions(expect);
  if (!parsed || 'error' in parsed || !ctx.platform || ctx.disableVision) return null;
  const regions = new Map<string, RegionAssertion>();
  for (const a of parsed.assertions) if (a.type === 'region_changed' || a.type === 'region_unchanged') regions.set(keyOf(a), a);
  if (!regions.size) return null;
  const adapter = ctx.platform;
  const frames = new Map<string, { before: GreyShot; baseline: GreyShot } | string>();
  for (const [k, a] of regions) {
    try {
      const rect = physicalRegion(ctx, a);
      const baseline = await grabGrey(adapter, { maxEdge: REGION_EDGE, region: rect });
      await sleep(BASELINE_GAP_MS);
      frames.set(k, { before: await grabGrey(adapter, { maxEdge: REGION_EDGE, region: rect }), baseline });
    } catch (e) { frames.set(k, e instanceof Error ? e.message : String(e)); }
  }
  return {
    async check(a) {
      const f = frames.get(keyOf(a));
      if (!f) return { ok: false, detail: 'no baseline was taken for this region' };
      if (typeof f === 'string') return { ok: false, detail: `no baseline before the action (${f})` };
      if (a.type === 'region_unchanged') await sleep(UNCHANGED_SETTLE_MS);
      const after = await grabGrey(adapter, { maxEdge: REGION_EDGE, region: physicalRegion(ctx, a) });
      const v = judgeRegion(f.before, after, f.baseline);
      if (v.inconclusive) return { ok: false, detail: `cannot tell: ${v.inconclusive}` };
      const share = `${(100 * v.count / (after.width * after.height)).toFixed(1)}% of the region`;
      if (a.type === 'region_changed') {
        return v.changed ? { ok: true, detail: `pixels changed (${share})` }
          : { ok: false, detail: `no pixel change in the region (${v.count} px differ, under the minimum of ${REGION_MIN_PIXELS})` };
      }
      return v.changed ? { ok: false, detail: `pixels changed in the region (${share})` }
        : { ok: true, detail: `no pixel change (${v.count} px differ, under the minimum of ${REGION_MIN_PIXELS})` };
    },
  };
}
