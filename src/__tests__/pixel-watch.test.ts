import { describe, it, expect, vi, afterEach } from 'vitest';
import sharp from 'sharp';
import { withPixelEffect, startPixelEffect, startRegionWatch, grabGrey } from '../tools/pixel-watch';
import { parseAssertions, checkAssertions } from '../core/verify/assertions';
import type { ToolContext } from '../tools/types';

/** A PNG of a w×h grey screen with `ink` rectangles painted black. */
async function png(w: number, h: number, ink: Array<[number, number, number, number]> = []): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3, 220);
  for (const [x, y, iw, ih] of ink) for (let j = y; j < y + ih; j++) for (let i = x; i < x + iw; i++) raw.fill(0, (j * w + i) * 3, (j * w + i) * 3 + 3);
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** A context whose screen shows the next buffer in `frames` on each capture (the last one stays). */
function ctxShowing(frames: Buffer[], size = { w: 400, h: 300 }): ToolContext {
  let n = 0;
  return {
    platform: { screenshot: vi.fn(async () => ({ buffer: frames[Math.min(n++, frames.length - 1)], width: size.w, height: size.h, scaleFactor: 1 })) },
    getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1, ensureInitialized: async () => {},
  } as unknown as ToolContext;
}

afterEach(() => { delete process.env.CLAWD_PIXEL_EFFECT; });

describe('withPixelEffect', () => {
  const box = { x: 412, y: 300, width: 180, height: 95 };
  it('joins the effect line the act already carries, then says what to look at', () => {
    const out = withPixelEffect('Clicked left x1\neffect: window same\nmore', { text: 'pixels changed in (412,300 180x95)', box }, { compact: true, batch: false });
    expect(out).toBe('Clicked left x1\neffect: window same · pixels changed in (412,300 180x95)\n' +
      'look: computer {"action":"screenshot_region","x":412,"y":300,"width":180,"height":95,"space":"screen","max_edge":512}\nmore');
  });
  it('starts a line when there is none; a batch says so, and the granular surface names its own tool', () => {
    expect(withPixelEffect('Done', { text: 'pixels same' }, { compact: false, batch: true })).toBe('Done\neffect (whole batch): pixels same');
    expect(withPixelEffect('Done', { text: 'pixels changed in (1,2 3x4)', box: { x: 1, y: 2, width: 3, height: 4 } }, { compact: false, batch: false }))
      .toContain('look: desktop_screenshot_region {"x":1,"y":2,"width":3,"height":4,"space":"screen","max_edge":512}');
  });
  it('adds nothing when the pixels could not be read', () => {
    expect(withPixelEffect('Done', { text: '' }, { compact: true, batch: false })).toBe('Done');
  });
});

describe('startPixelEffect', () => {
  it('is off by default: no capture at all', async () => {
    const ctx = ctxShowing([await png(400, 300)]);
    expect(await startPixelEffect(ctx)).toBeNull();
    expect(ctx.platform!.screenshot).not.toHaveBeenCalled();
  });
  it('with CLAWD_PIXEL_EFFECT=1 reports where pixels changed, in screen units', async () => {
    process.env.CLAWD_PIXEL_EFFECT = '1';
    const ctx = ctxShowing([await png(400, 300), await png(400, 300, [[100, 50, 40, 20]])]);
    const done = await startPixelEffect(ctx);
    expect(await done!()).toMatchObject({ text: 'pixels changed in (100,50 40x20)' });
  });
  it('says pixels same when only a caret-sized spot changed', async () => {
    process.env.CLAWD_PIXEL_EFFECT = '1';
    const ctx = ctxShowing([await png(400, 300), await png(400, 300, [[100, 50, 2, 4]])]);
    expect(await (await startPixelEffect(ctx))!()).toEqual({ text: 'pixels same' });
  });
  it('a redraw that lags the input is still seen: the second after-frame differs', async () => {
    process.env.CLAWD_PIXEL_EFFECT = '1';
    const blank = await png(400, 300);
    const ctx = ctxShowing([blank, blank, await png(400, 300, [[100, 50, 40, 20]])]);
    const done = await startPixelEffect(ctx);
    expect(await done!()).toMatchObject({ text: 'pixels changed in (100,50 40x20)' });
    expect(ctx.platform!.screenshot).toHaveBeenCalledTimes(3);
  });
  it('says pixels same only after exactly two after-frames; a change on the first returns at once', async () => {
    process.env.CLAWD_PIXEL_EFFECT = '1';
    const blank = await png(400, 300);
    const same = ctxShowing([blank]);
    const done = await startPixelEffect(same);
    expect(await done!()).toEqual({ text: 'pixels same' });
    expect(same.platform!.screenshot).toHaveBeenCalledTimes(3);   // before + two after
    const quick = ctxShowing([blank, await png(400, 300, [[100, 50, 40, 20]])]);
    await (await startPixelEffect(quick))!();
    expect(quick.platform!.screenshot).toHaveBeenCalledTimes(2);  // before + one after
  });
  it('reads nothing when vision is disabled', async () => {
    process.env.CLAWD_PIXEL_EFFECT = '1';
    const ctx = { ...ctxShowing([await png(400, 300)]), disableVision: true } as ToolContext;
    expect(await startPixelEffect(ctx)).toBeNull();
  });
});

describe('expect region_changed / region_unchanged', () => {
  const region = { x: 0, y: 0, width: 200, height: 100 };
  it('is parsed with numbers and an optional space; bad boxes are refused', () => {
    expect('assertions' in parseAssertions([{ type: 'region_changed', ...region, space: 'screen' }])).toBe(true);
    expect(parseAssertions([{ type: 'region_changed', x: 1, y: 2, width: 0, height: 5 }])).toHaveProperty('error');
    expect(parseAssertions([{ type: 'region_changed', x: '1', y: 2, width: 3, height: 5 }])).toHaveProperty('error');
    expect(parseAssertions([{ type: 'region_unchanged', ...region, space: 'px' }])).toHaveProperty('error');
  });
  it('has no baseline outside an acting call: it fails and says why', async () => {
    const parsed = parseAssertions([{ type: 'region_changed', ...region }]);
    const r = await checkAssertions((parsed as { assertions: never[] }).assertions, { adapter: {} as never });
    expect(r.ok).toBe(false);
    expect(r.outcomes[0].detail).toMatch(/expect/);
  });
  const run = async (frames: Buffer[], type: string) => {
    const expectArg = [{ type, ...region }];
    const probe = await startRegionWatch(expectArg, ctxShowing(frames));
    const parsed = parseAssertions(expectArg) as { assertions: never[] };
    return checkAssertions(parsed.assertions, { adapter: {} as never, regions: probe! });
  };
  it('region_changed passes when a stroke lands', async () => {
    const blank = await png(200, 100);
    const r = await run([blank, blank, await png(200, 100, [[20, 40, 80, 3]])], 'region_changed');
    expect(r.ok).toBe(true);
  });
  it('region_changed fails when nothing was drawn', async () => {
    const blank = await png(200, 100);
    const r = await run([blank, blank, blank], 'region_changed');
    expect(r.ok).toBe(false);
    expect(r.outcomes[0].detail).toMatch(/no pixel change/);
  });
  it('region_unchanged passes with a blinking caret and fails on a stroke', async () => {
    const blank = await png(200, 100);
    expect((await run([blank, blank, await png(200, 100, [[50, 30, 2, 20]])], 'region_unchanged')).ok).toBe(true);
    expect((await run([blank, blank, await png(200, 100, [[20, 40, 80, 3]])], 'region_unchanged')).ok).toBe(false);
  });
});

describe('grabGrey', () => {
  it('returns one byte per pixel', async () => {
    const g = await grabGrey(ctxShowing([await png(40, 30)]).platform!, { maxEdge: 640 });
    expect(g.width * g.height).toBe(g.data.length);
    expect(g.data[0]).toBeGreaterThan(200);
  });
});
