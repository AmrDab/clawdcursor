/**
 * The bridge's get-value read an EMPTY text box as its own name: every source
 * (Value, Text, Selection) was empty, so it fell through to Name, and an empty
 * "First name" field read back as "First name" (live Windows VM, 2026-10-16).
 * An element that can hold text reads "" when empty; Name is the value only
 * for elements that hold no text (labels, buttons).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const bridge = fs.readFileSync(path.join(__dirname, '../../scripts/ps-bridge.ps1'), 'utf8');
const getValue = bridge.slice(bridge.indexOf('"get-value" {'), bridge.indexOf('"focus" {', bridge.indexOf('"get-value" {')));

describe('ps-bridge get-value on an empty field', () => {
  it('marks Value/Text-pattern elements as holding text and returns "" for them before the Name fallback', () => {
    expect(getValue).toMatch(/ValuePattern\]::Pattern\)\s*\n\s*\$holdsText = \$true/);
    expect(getValue).toMatch(/TextPattern\]::Pattern\)\s*\n\s*\$holdsText = \$true/);
    const empty = getValue.indexOf('if ($null -eq $val -and $holdsText) { $val = ""');
    const name = getValue.indexOf('$val = $element.Current.Name');
    expect(empty).toBeGreaterThan(-1);
    expect(empty).toBeLessThan(name);
  });
});
