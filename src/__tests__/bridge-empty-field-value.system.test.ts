/**
 * The bridge's get-value read an EMPTY text box as its own name: every source (Value, Text, Selection) was empty, so it
 * fell through to Name, and an empty "First name" field read back as "First name" (live Windows VM, 2026-10-16). An
 * element that can hold text reads "" when empty; Name is the value only for elements that hold no text (labels,
 * buttons). A web number box is a UIA Spinner: its value is a number (RangeValuePattern), never its name. A password
 * box is never read. Run for real (fake elements) through Cmd-InvokeElement; the macOS side is in
 * bridge-empty-field-value.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { INVOKE_FUNCTIONS, INVOKE_SETUP, runPsJson } from './helpers/ps-bridge-harness';

type Reply = { success: boolean; value?: string; method?: string; readable?: boolean; secure?: boolean; error?: string };

describe.runIf(process.platform === 'win32')('ps-bridge get-value / set-value (run for real, fake elements)', () => {
  const CASES = {
    emptyField: `Invoke-Fake @(New-FakeEl -Name 'First name' -Patterns @{ Value = (New-ValuePattern '') }) @{ name = 'First name'; action = 'get-value' }`,
    filledField: `Invoke-Fake @(New-FakeEl -Name 'First name' -Patterns @{ Value = (New-ValuePattern 'Ada') }) @{ name = 'First name'; action = 'get-value' }`,
    button: `Invoke-Fake @(New-FakeEl -Name 'Send' -Type Button) @{ name = 'Send'; action = 'get-value' }`,
    password: `Invoke-Fake @(New-FakeEl -Name 'Password' -Password -Patterns @{ Value = (New-ValuePattern 'hunter2'); Text = (New-TextPattern 'hunter2') }) @{ name = 'Password'; action = 'get-value' }`,
    textOnlyEmpty: `Invoke-Fake @(New-FakeEl -Name 'Notes' -Type Document -Patterns @{ Text = (New-TextPattern '') }) @{ name = 'Notes'; action = 'get-value' }`,
    textOnly: `Invoke-Fake @(New-FakeEl -Name 'Notes' -Type Document -Patterns @{ Value = (New-ValuePattern ''); Text = (New-TextPattern 'hello') }) @{ name = 'Notes'; action = 'get-value' }`,
    spinner: `Invoke-Fake @(New-FakeEl -Name 'Quantity' -Type Spinner -Patterns @{ RangeValue = (New-RangePattern 30) }) @{ name = 'Quantity'; action = 'get-value' }`,
    spinnerEmptyValue: `Invoke-Fake @(New-FakeEl -Name 'Quantity' -Type Spinner -Patterns @{ Value = (New-ValuePattern ''); RangeValue = (New-RangePattern 0) }) @{ name = 'Quantity'; action = 'get-value' }`,
    spinnerNoPattern: `Invoke-Fake @(New-FakeEl -Name 'Quantity' -Type Spinner) @{ name = 'Quantity'; action = 'get-value' }`,
    labelThenSpinner: `Invoke-Fake @((New-FakeEl -Name 'Quantity' -Type Text), (New-FakeEl -Name 'Quantity' -Type Spinner -Patterns @{ RangeValue = (New-RangePattern 5) })) @{ name = 'Quantity'; action = 'get-value' }`,
    setValue: `Invoke-Fake @(New-FakeEl -Name 'First name' -Patterns @{ Value = (New-ValuePattern '') }) @{ name = 'First name'; action = 'set-value'; value = 'Ada' }`,
    setNumber: `Invoke-Fake @(New-FakeEl -Name 'Quantity' -Type Spinner -Patterns @{ Value = (New-ValuePattern '' -Ignores); RangeValue = (New-RangePattern 1) }) @{ name = 'Quantity'; action = 'set-value'; value = '42' }`,
  };
  const keys = Object.keys(CASES) as Array<keyof typeof CASES>;
  let r: Record<keyof typeof CASES, Reply>;
  beforeAll(() => {
    const out = runPsJson(INVOKE_FUNCTIONS, INVOKE_SETUP, keys.map(k => CASES[k])) as Reply[];
    r = Object.fromEntries(keys.map((k, i) => [k, out[i]])) as typeof r;
  }, 120_000);

  it('an empty field reads "" (readable), not its name; a filled one its value', () => {
    expect(r.emptyField).toMatchObject({ success: true, value: '', method: 'ValuePattern', readable: true });
    expect(r.filledField).toMatchObject({ success: true, value: 'Ada', method: 'ValuePattern', readable: true });
  });

  it('an element that holds no text reads its name, marked not readable', () => {
    expect(r.button).toMatchObject({ success: true, value: 'Send', method: 'Name', readable: false });
  });

  it('a password box is withheld: "" with secure, not readable, and its value is never read', () => {
    expect(r.password).toMatchObject({ success: true, value: '', method: 'Password', readable: false, secure: true });
    expect(JSON.stringify(r.password)).not.toContain('hunter2');
  });

  it('a text-pattern field reads its text, and "" when empty (not its name)', () => {
    expect(r.textOnlyEmpty).toMatchObject({ value: '', readable: true });
    expect(r.textOnly).toMatchObject({ value: 'hello', method: 'TextPattern', readable: true });
  });

  it('a Spinner reads its number; with an empty ValuePattern "" (not the range\'s 0); with no pattern "" unreadable, never its name', () => {
    expect(r.spinner).toMatchObject({ value: '30', method: 'RangeValuePattern', readable: true });
    expect(r.spinnerEmptyValue).toMatchObject({ value: '', method: 'ValuePattern', readable: true });
    expect(r.spinnerNoPattern).toMatchObject({ value: '', method: 'None', readable: false });
  });

  it('a by-name value read takes the Spinner over the label of the same name', () => {
    expect(r.labelThenSpinner).toMatchObject({ value: '5', method: 'RangeValuePattern' });
  });

  it('set-value: through ValuePattern, verified; a number the ValuePattern ignores goes through RangeValuePattern', () => {
    expect(r.setValue).toMatchObject({ success: true, method: 'ValuePattern', value: 'Ada' });
    expect(r.setNumber).toMatchObject({ success: true, method: 'RangeValuePattern', value: '42' });
  });
});
