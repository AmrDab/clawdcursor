import { describe, it, expect } from 'vitest';
import { buildUnifiedTools } from '../tools/projected/tools';

describe('coordinate tools surface the space:"image" guidance', () => {
  const tools = buildUnifiedTools();
  const desc = (n: string) => tools.find(t => t.name === n)!.description;
  for (const n of ['click', 'drag', 'scroll']) {
    it(`${n} description mentions space:"image" for screenshot coords`, () => {
      expect(desc(n).toLowerCase()).toMatch(/space:"image"|space: ?"image"|space.*image/);
      expect(desc(n).toLowerCase()).toMatch(/screenshot/);
    });
  }
});
