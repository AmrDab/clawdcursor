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

const swift = fs.readFileSync(path.join(__dirname, '../../scripts/mac/ax-helper.swift'), 'utf8');
const swiftGet = swift.slice(swift.indexOf('case "get-value":'), swift.indexOf('case "expand", "collapse":'));
const setValue = bridge.slice(bridge.indexOf('"set-value" {'), bridge.indexOf('"get-value" {'));
const resolve = bridge.slice(bridge.indexOf('function Resolve-EditableTarget'), bridge.indexOf('if ($LabeledOnly) { return $null }'));

describe('get-value says whether the value was read (readable), on every bridge', () => {
  it('ps-bridge: readable is false only for the Name; a password box is withheld, not empty', () => {
    expect(getValue).toMatch(/\$val = \$element\.Current\.Name; \$method = "Name"; \$readable = \$false/);
    expect(getValue).toMatch(/value=\$val; method=\$method; readable=\$readable/);
    expect(getValue).toMatch(/if \(\$isPassword\) \{ return @\{ success=\$true; action="get-value"; value=""; method="Password"; readable=\$false; secure=\$true \} \}/);
    expect(getValue.indexOf('$isPassword) { return')).toBeLessThan(getValue.indexOf('$holdsText = $true'));
  });

  it('ax-helper: a text field reads its AXValue ("" when empty) and never its title or description', () => {
    expect(swiftGet).toMatch(/let holdsText = \["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXIncrementor"\]\.contains\(h\.role\)/);
    expect(swiftGet).toMatch(/if let v = str\(a\["AXValue"\]\), holdsText \|\| !v\.isEmpty \{\s*\n\s*return \[[^\]]*"method": "AXValue", "readable": true\]/);
    // the name is read only for an element that holds no text, and is labelled as the name
    expect(swiftGet).toMatch(/if !holdsText \{\s*\n\s*for key in \["AXTitle", "AXDescription"\]/);
    expect(swiftGet).toMatch(/"method": "name", "readable": false\]/);
    expect(swiftGet).toMatch(/"value": "", "method": "empty", "readable": false\]/);
  });
});

// Live (Windows 11, Edge): <input type="number"> is a UIA Spinner. get-value answered its name, set-value found nothing settable.
describe('a Spinner (a web number box) is a field with a value', () => {
  it('ps-bridge: a by-name value action and Resolve-EditableTarget treat a Spinner as editable', () => {
    expect(bridge).toMatch(/\$EDITABLE = @\([^\n]*ControlType\]::ComboBox, \[System\.Windows\.Automation\.ControlType\]::Spinner\)/);
    expect(resolve).toMatch(/if \(\$ct -eq \$EDIT -or \$ct -eq \$DOC -or \$ct -eq \$SPIN\) \{ return \$el \}/);
    expect(resolve).toMatch(/ControlTypeProperty, \$SPIN\)\)\)/);
  });

  it('ps-bridge: get-value reads RangeValuePattern before any Name, and a Spinner never answers its name', () => {
    const range = getValue.indexOf('RangeValuePattern]::Pattern)');
    const name = getValue.indexOf('$val = $element.Current.Name');
    expect(range).toBeGreaterThan(-1);
    expect(range).toBeLessThan(name);
    const spinner = getValue.indexOf('ControlType]::Spinner) {');
    expect(spinner).toBeGreaterThan(-1);
    expect(spinner).toBeLessThan(name);
  });

  it('ps-bridge: set-value sets a number through RangeValuePattern when ValuePattern did not take it, verified', () => {
    const rangeSet = setValue.indexOf('$rv.SetValue($num)');
    expect(rangeSet).toBeGreaterThan(setValue.indexOf('$vp.SetValue($value)'));
    expect(rangeSet).toBeLessThan(setValue.indexOf('# 2) Keyboard fallback'));
    expect(setValue).toMatch(/if \(\[double\]\$rv\.Current\.Value -eq \$num\) \{ return @\{ success=\$true; action="set-value"; value=\$value; method="RangeValuePattern" \} \}/);
    // the read-back after the keys reads a Spinner too
    expect(setValue).toMatch(/\$readVal = \{ param\(\$el\)[\s\S]*?RangeValuePattern\]::Pattern\)\.Current\.Value/);
  });

  it('ax-helper: a stepper is a value target and is set as a number', () => {
    expect(swift).toMatch(/"set-value": \["textfield", "textarea", "combobox", "searchfield", "incrementor"\]/);
    expect(swift).toMatch(/if h\.role == "AXIncrementor", let n = Double\(v\) \{ newValue = NSNumber\(value: n\) \}/);
  });
});

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
