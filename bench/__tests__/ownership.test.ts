import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ownsFocus, parseFocus } from '../lib/ownership';
import { parseImagePids } from '../lib/live-fixtures';

describe('whose window has the focus', () => {
  it('reads the probe: the focused process with its ancestors, and a Store app frame', () => {
    expect(parseFocus('chain 4120 900 4\r\n')).toEqual({ chain: [4120, 900, 4] });
    expect(parseFocus('chain 7000 880\nframe 7000 5150\ntitle Calculator\n'))
      .toEqual({ chain: [7000, 880], frame: { hosted: [7000, 5150], title: 'Calculator' } });
    expect(parseFocus('')).toBeNull();
    expect(parseFocus('chain \n')).toBeNull();
    expect(parseFocus('error: access denied')).toBeNull();
  });

  it('is ours when the focused process, or an ancestor of it, is one the benchmark started', () => {
    expect(ownsFocus({ chain: [4120, 900] }, [4120])).toBe(true);
    expect(ownsFocus({ chain: [5555, 4120, 900] }, [4120])).toBe(true);   // a child of the fixture
    expect(ownsFocus({ chain: [900, 4] }, [4120])).toBe(false);          // the fixture's parent is not the fixture
    expect(ownsFocus({ chain: [3000, 900] }, [4120])).toBe(false);
  });

  it('fails closed: no probe answer, or nothing started, is never ours', () => {
    expect(ownsFocus(null, [4120])).toBe(false);
    expect(ownsFocus({ chain: [4120] }, [])).toBe(false);
  });

  describe('a Store app (its window belongs to ApplicationFrameHost)', () => {
    const frame = (hosted: number[], title = 'Calculator') => ({ chain: [7000, 880], frame: { hosted, title } });

    it('is ours only when the frame hosts a process the benchmark started and has the exact title', () => {
      expect(ownsFocus(frame([7000, 5150]), [5150], 'Calculator')).toBe(true);
    });
    it('is not ours when the frame hosts another Store app', () => {
      expect(ownsFocus(frame([7000, 6200]), [5150], 'Calculator')).toBe(false);
    });
    it('is not ours on another title, or when this fixture is not a Store app', () => {
      expect(ownsFocus(frame([7000, 5150], 'Calculator - Settings'), [5150], 'Calculator')).toBe(false);
      expect(ownsFocus(frame([7000, 5150]), [5150])).toBe(false);
    });
    it('ApplicationFrameHost itself is never a fixture process', () => {
      expect(ownsFocus(frame([7000]), [5150], 'Calculator')).toBe(false);
    });
  });
});

describe('the processes of a launched app', () => {
  it('reads tasklist CSV and pgrep output', () => {
    expect(parseImagePids('"CalculatorApp.exe","5150","Console","1","61,204 K"\r\n"CalculatorApp.exe","5160","Console","1","9 K"\r\n', 'win32')).toEqual([5150, 5160]);
    expect(parseImagePids('INFO: No tasks are running which match the specified criteria.\r\n', 'win32')).toEqual([]);
    expect(parseImagePids('812\n944\n', 'darwin')).toEqual([812, 944]);
  });
});

describe('the allowlists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'live-fixtures.ts'), 'utf8');
  const lists = [...src.matchAll(/apps: \[([^\]]*)\]/g)].map(m => m[1]);

  it('name fixtures only: no generic host that other apps share', () => {
    expect(lists.length).toBeGreaterThanOrEqual(5);
    for (const l of lists) expect(l).not.toMatch(/ApplicationFrameHost|CalculatorApp|python|msedge|ugraf|'NX'/i);
  });

  it('every fixture says which processes are its own', () => {
    // One `roots` per fixture kind: native, Designcenter, Calculator, TextEdit, web.
    expect(src.match(/roots: \(\) =>/g)!.length).toBe(5);
  });
});
