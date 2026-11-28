import { describe, it, expect } from 'vitest';
import { buildCoreTools } from '../tools/core-tools';

describe('coordinate tools surface the space:"image" guidance', () => {
  const tools = buildCoreTools();
  const desc = (n: string) => tools.find(t => t.name === n)!.description;
  for (const n of ['mouse_click', 'mouse_drag', 'mouse_scroll']) {
    it(`${n} description mentions space:"image" for screenshot coords`, () => {
      expect(desc(n).toLowerCase()).toMatch(/space:"image"|space: ?"image"|space.*image/);
      expect(desc(n).toLowerCase()).toMatch(/screenshot/);
    });
  }
});
