/** The agent hosts the benchmark can run a task through. Only the installed ones are used. */
import { claudeCode } from './claude-code';
import type { Adapter } from './common';

export const ADAPTERS: Adapter[] = [claudeCode];

export interface ModelRun { adapter: Adapter; model: string; label: string }

/** "claude-code:sonnet,ollama:qwen2.5:7b" -> runs. The adapter id ends at the first colon; a bare id means its default models. */
export function parseModels(spec: string, adapters: Adapter[] = ADAPTERS): ModelRun[] {
  const runs: ModelRun[] = [];
  for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const colon = part.indexOf(':');
    const id = colon < 0 ? part : part.slice(0, colon);
    const adapter = adapters.find(a => a.id === id);
    if (!adapter) throw new Error(`unknown agent "${id}": one of ${adapters.map(a => a.id).join(', ')}`);
    const models = colon < 0 ? adapter.defaultModels : [part.slice(colon + 1)];
    for (const model of models) runs.push({ adapter, model, label: `${adapter.id}:${model}` });
  }
  return runs;
}

/** Every installed adapter with its default models. */
export async function detectModels(adapters: Adapter[] = ADAPTERS): Promise<{ runs: ModelRun[]; found: Array<{ id: string; detail: string | null }> }> {
  const found = await Promise.all(adapters.map(async a => ({ id: a.id, detail: await a.detect().catch(() => null) })));
  const runs = adapters.filter((_, i) => found[i].detail).flatMap(a => a.defaultModels.map(model => ({ adapter: a, model, label: `${a.id}:${model}` })));
  return { runs, found };
}
