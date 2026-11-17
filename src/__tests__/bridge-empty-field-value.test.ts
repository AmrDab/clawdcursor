/**
 * get-value read an EMPTY text box as its own name: an empty "First name" field read back as "First name" (live Windows
 * VM, 2026-10-16). An element that can hold text reads "" when empty; Name is the value only for elements that hold no
 * text (labels, buttons). The Windows bridge is run for real in bridge-empty-field-value.system.test.ts. ax-helper has
 * no entry point that runs without a live AX tree (every command reads one), so its side stays a check of the source.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const swift = fs.readFileSync(path.join(__dirname, '../../scripts/mac/ax-helper.swift'), 'utf8');
const swiftGet = swift.slice(swift.indexOf('case "get-value":'), swift.indexOf('case "expand", "collapse":'));

describe('ax-helper get-value says whether the value was read (readable)', () => {
  it('a text field reads its AXValue ("" when empty) and never its title or description', () => {
    expect(swiftGet).toMatch(/let holdsText = \["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXIncrementor"\]\.contains\(h\.role\)/);
    expect(swiftGet).toMatch(/if let v = str\(a\["AXValue"\]\), holdsText \|\| !v\.isEmpty \{\s*\n\s*return \[[^\]]*"method": "AXValue", "readable": true\]/);
    // the name is read only for an element that holds no text, and is labelled as the name
    expect(swiftGet).toMatch(/if !holdsText \{\s*\n\s*for key in \["AXTitle", "AXDescription"\]/);
    expect(swiftGet).toMatch(/"method": "name", "readable": false\]/);
    expect(swiftGet).toMatch(/"value": "", "method": "empty", "readable": false\]/);
  });

  it('a stepper (a web number box) is a value target and is set as a number', () => {
    expect(swift).toMatch(/"set-value": \["textfield", "textarea", "combobox", "searchfield", "incrementor"\]/);
    expect(swift).toMatch(/if h\.role == "AXIncrementor", let n = Double\(v\) \{ newValue = NSNumber\(value: n\) \}/);
  });
});
