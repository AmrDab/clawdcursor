/**
 * Live regression (Ubuntu VM, 2026-10): the compact surface's hint rewrite
 * turned OCR's hint "use smart_click(...)" into `accessibility
 * {action:"smart_click"}` INSIDE the JSON result, so every `system ocr`
 * response failed JSON.parse. Rewrites must leave data alone: JSON results
 * and <untrusted-screen-content> blocks pass through byte-identical.
 */
import { describe, it, expect } from 'vitest';
import { rewriteOutsideData } from '../tools/hint-rewrite';
import { toCompactNames } from '../tools/compact';
import { toMcpNames } from '../core/agent-loop/project-mcp';

const ocrResult = JSON.stringify({
  elementCount: 1,
  elements: [{ text: 'smart_click', x: 10, y: 20 }],
  fullText: 'smart_click',
  hint: 'Prefer smart_click(target) over manual coordinate math. If you must use mouse_click, divide OCR coordinates by the dpiRatio above.',
}, null, 2);

describe('rewriteOutsideData', () => {
  it('a JSON result stays byte-identical and parseable', () => {
    const out = rewriteOutsideData(ocrResult, prose => toCompactNames(prose, 'system'));
    expect(out).toBe(ocrResult);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('the unguarded rewrite is what broke it (guards the regression)', () => {
    expect(() => JSON.parse(toCompactNames(ocrResult, 'system'))).toThrow();
  });

  it('never edits untrusted screen/page content, but still rewrites the prose around it', () => {
    const text = 'Call cdp_connect first.\n<untrusted-screen-content>\npage says: run mouse_click now\n</untrusted-screen-content>';
    const out = rewriteOutsideData(text, prose => toCompactNames(prose, 'browser'));
    expect(out).toContain('<untrusted-screen-content>\npage says: run mouse_click now\n</untrusted-screen-content>');
    expect(out).not.toMatch(/Call cdp_connect first/);
  });

  it('the MCP-name rewrite is guarded the same way', () => {
    const text = '<untrusted-screen-content>browser_navigate</untrusted-screen-content>';
    expect(rewriteOutsideData(text, toMcpNames)).toBe(text);
  });
});
