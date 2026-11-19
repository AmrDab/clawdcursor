/**
 * What the pixel effect (CLAWD_PIXEL_EFFECT=1) costs one acting call on this machine (#357): the time to capture the
 * screen as the greyscale frame the effect line compares, and to diff two such frames. Captures only: no click, no key,
 * nothing on screen changes. Each acting call pays two captures and one diff.
 *
 * Run: npx tsx scripts/measure-pixel-effect.ts [runs=15]
 * Needs the same grants as a screenshot (macOS: Screen Recording for the app that runs it).
 */
import { getPlatform } from '../src/platform';
import { grabGrey } from '../src/tools/pixel-watch';
import { diffFrames } from '../src/core/sense/frame-diff';

const runs = Math.max(3, Number(process.argv[2]) || 15);
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const p90 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * 0.9))];

async function main(): Promise<void> {
  const adapter = await getPlatform();
  const size = await adapter.getScreenSize();
  console.log(`${process.platform} ${process.arch}, screen ${size.physicalWidth}x${size.physicalHeight} (dpi x${size.dpiRatio}), node ${process.version}, ${runs} runs`);
  const capture: number[] = [], diff: number[] = [];
  await grabGrey(adapter, { maxEdge: 640 });   // the first capture warms the native helper: not counted
  let prev = await grabGrey(adapter, { maxEdge: 640 });
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const next = await grabGrey(adapter, { maxEdge: 640 });
    const t1 = performance.now();
    const d = diffFrames(prev, next);
    const t2 = performance.now();
    capture.push(t1 - t0); diff.push(t2 - t1);
    prev = next;
    if (i === 0) console.log(`frame ${next.width}x${next.height} (x${next.scale.toFixed(2)}); ${d.count} px differ between the first two frames`);
  }
  const row = (name: string, v: number[]) => `${name.padEnd(8)} median ${median(v).toFixed(0)} ms, p90 ${p90(v).toFixed(0)} ms, max ${Math.max(...v).toFixed(0)} ms`;
  console.log(row('capture', capture));
  console.log(row('diff', diff));
  console.log(`added to one acting call (two captures + one diff): about ${(2 * median(capture) + median(diff)).toFixed(0)} ms`);
  process.exit(0);
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
