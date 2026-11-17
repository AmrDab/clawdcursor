/**
 * Production-path perf smoke (#117) — times the CPU-bound hot paths every
 * daemon boot and every MCP client pays, with generous budgets that only trip
 * on PATHOLOGICAL regressions (accidental sync I/O in the registry, schema
 * explosion, an O(n²) in catalog construction). This is a regression tripwire,
 * not a micro-benchmark: runner variance is absorbed by the wide budgets.
 *
 * Run: npx tsx scripts/perf-smoke.ts   (CI runs it on the ubuntu/22 cell)
 */

const BUDGETS_MS: Record<string, number> = {
  'registry: getAllTools() cold': 3000,
  'registry: getCompactSurface() cold': 3000,
  'agent loop: buildUnifiedTools() x10': 2000,
  'mcp: schema canonicalize (98 tools)': 3000,
};

async function main(): Promise<void> {
  const results: Array<{ name: string; ms: number; budget: number; ok: boolean }> = [];
  const time = async (name: string, fn: () => Promise<unknown> | unknown) => {
    const t0 = performance.now();
    await fn();
    const ms = Math.round(performance.now() - t0);
    const budget = BUDGETS_MS[name];
    results.push({ name, ms, budget, ok: ms <= budget });
  };

  await time('registry: getAllTools() cold', async () => {
    const { getAllTools } = await import('../src/tools/registry');
    const tools = getAllTools();
    if (tools.length < 50) throw new Error(`registry suspiciously small: ${tools.length}`);
  });

  await time('registry: getCompactSurface() cold', async () => {
    const { getCompactSurface } = await import('../src/tools/registry');
    const compact = getCompactSurface();
    if (compact.length < 5) throw new Error(`compact surface suspiciously small: ${compact.length}`);
  });

  await time('agent loop: buildUnifiedTools() x10', async () => {
    const { buildUnifiedTools } = await import('../src/tools/projected/tools');
    for (let i = 0; i < 10; i++) buildUnifiedTools();
  });

  await time('mcp: schema canonicalize (98 tools)', async () => {
    const { getAllTools } = await import('../src/tools/registry');
    const { toJsonSchema } = await import('../src/tools/types');
    for (const t of getAllTools()) toJsonSchema(t.parameters);
  });

  let failed = false;
  for (const r of results) {
    const mark = r.ok ? 'OK  ' : 'SLOW';
    console.log(`${mark} ${r.name}: ${r.ms}ms (budget ${r.budget}ms)`);
    if (!r.ok) failed = true;
  }
  if (failed) {
    console.error('\nperf-smoke: a production path exceeded its budget — investigate before merging.');
    process.exit(1);
  }
  console.log('\nperf-smoke: all production paths within budget.');
}

main().catch(err => { console.error(err); process.exit(1); });
