/**
 * Every result says what it means: confirmed / unverified / refused / failed, and a failure carries a stable code, a
 * hint and a safe next call. The inputs below are the texts the tools really produce today.
 */
import { describe, it, expect } from 'vitest';
import { classifyResult, renderResultLine, isJsonText } from '../core/result-codes';

describe('classifyResult — errors get a code from the text the tools already write', () => {
  const cases: Array<[string, string, string]> = [
    ['clawdcursor needs one-time consent before it can control the desktop. Run `clawdcursor consent --accept`', 'CONSENT_REQUIRED', 'refused'],
    ['A system dialog owns the keyboard: "UserNotificationCenter" (pid 311) is frontmost per NSWorkspace.', 'KEYBOARD_OWNED', 'refused'],
    ['secure input is on (held by 1Password, pid 412): macOS sends keys and focus only to it. Close or leave the password field in 1Password, then try again. (focus went to Google Chrome (pid 935), not to Notes (pid 77))', 'SECURE_INPUT', 'refused'],
    ['smart_click failed: the screen is locked — unlock it first', 'SCREEN_LOCKED', 'refused'],
    ['key_press: Refused: "win+l" is a dangerous key combo — super+l locks the screen, so clawdcursor never sends it.', 'DANGEROUS_KEY', 'refused'],
    ['Clicked "Save" at (10,20)\nDEVIATION: 1/1 expected check(s) failed (still failing after a 2s settle window)', 'DEVIATION', 'failed'],
    ['invoke_element ref rejected: unknown snapshot s_12 — call compile_ui first', 'STALE_REF', 'failed'],
    ['computer: unknown action "clik"', 'INVALID_ARGS', 'failed'],
    ['computer zoom: missing required field(s): x, y, width, height.', 'INVALID_ARGS', 'failed'],
    ['expect rejected (nothing executed): unknown assertion type "foo"', 'INVALID_ARGS', 'failed'],
    ['wait_for_element: timed out after 5000ms', 'TIMEOUT', 'failed'],
    ['browser_navigate: not connected — call browser navigate first', 'NOT_CONNECTED', 'failed'],
    ['a11y invoke "Authorize" missed — element not found or not actionable.', 'NOT_FOUND', 'failed'],
    ['(no elements found)\nsearched: pid 21972', 'NOT_FOUND', 'failed'],
    ['something odd happened', 'UNKNOWN', 'failed'],
  ];
  for (const [text, code, outcome] of cases) {
    it(`${code}: ${text.slice(0, 50)}`, () => {
      expect(classifyResult(text, true, true)).toMatchObject({ code, outcome });
    });
  }

  it('a refusal is never "failed", and every failure but INVALID_ARGS offers a next call', () => {
    for (const [text, code] of cases) {
      const c = classifyResult(text, true, true)!;
      expect(c.hint).toBeTruthy();
      if (!['INVALID_ARGS', 'CONSENT_REQUIRED'].includes(code)) expect(c.next).toBeTruthy();
    }
  });

  it('error words deep inside a long body do not decide the code (only the head is read)', () => {
    const page = 'x'.repeat(600) + ' timed out ';
    expect(classifyResult(page, true, true)?.code).toBe('UNKNOWN');
  });
});

describe('classifyResult — successes', () => {
  it('an action checked by expect is confirmed', () => {
    expect(classifyResult('Clicked "Save" — verified 1 check(s)', false, true)).toEqual({ outcome: 'confirmed' });
    expect(classifyResult('VERIFIED:\n✓ window_title_contains("Saved")', false, true)).toEqual({ outcome: 'confirmed' });
  });

  it('an action nothing checked is plain [unverified] — no hint: not every tool takes expect', () => {
    expect(classifyResult('Pressed Return', false, true)).toEqual({ outcome: 'unverified' });
  });

  it('a successful read gets no line at all — even when its content says "not found" or "timed out"', () => {
    expect(classifyResult('Page text: 404 not found, the request timed out', false, false)).toBeNull();
  });

  it('a successful action whose text happens to contain error words is still just unverified', () => {
    expect(classifyResult('Typed "not found" into the search box', false, true)?.outcome).toBe('unverified');
  });
});

describe('surfaces and rendering', () => {
  it('next calls use the caller\'s own tool names', () => {
    const t = 'a11y invoke "X" missed — element not found';
    expect(classifyResult(t, true, true, 'mcp')?.next).toMatch(/^accessibility \{"action":"smart_click"/);
    const other = 'accessibility find: nothing matched';
    expect(classifyResult(other, true, true, 'mcp')?.next).toMatch(/^accessibility \{"action":"compile_ui"\}/);
  });

  it('renders one bracketed line', () => {
    expect(renderResultLine({ outcome: 'failed', code: 'TIMEOUT', hint: 'h', next: 'n' })).toBe('[failed · TIMEOUT · hint: h · next: n]');
    expect(renderResultLine({ outcome: 'confirmed' })).toBe('[confirmed]');
  });

  it('JSON results are recognised so nothing is appended to them', () => {
    expect(isJsonText('{"status":"waiting"}')).toBe(true);
    expect(isJsonText('  [{"a":1}]')).toBe(true);
    expect(isJsonText('Pressed Return')).toBe(false);
  });

  // The policy gate is gone in 1.6: its texts are no longer a refusal vocabulary, and its codes no longer exist.
  it('the removed gate codes are never produced', () => {
    for (const t of ['mouse_click: safety block - destructive label "Delete"', 'a11y_invoke: safety confirm - "Send" (requires user confirmation)', '[confirm] click "Pay"']) {
      expect(['SAFETY_BLOCKED', 'NEEDS_CONFIRMATION']).not.toContain(classifyResult(t, true, true)?.code);
    }
  });

  it('no vendor or model names in any hint or next call (model-agnostic)', () => {
    const all = [true, false].flatMap(e => ['x', 'is a dangerous key combo', 'not found', 'timed out', 'screen is locked']
      .map(t => JSON.stringify(classifyResult(t, e, true, 'mcp'))));
    expect(all.join(' ')).not.toMatch(/claude|anthropic|openai|gpt|gemini/i);
  });
});

describe('review fixes', () => {
  it('value-returning and read calls are not "acting", so nothing is appended to what they return', async () => {
    const { isActingAction } = await import('../core/result-codes');
    for (const [c, a] of [['system', 'build_uri'], ['browser', 'evaluate'], ['computer', 'wait'], ['system', 'report'],
      ['system', 'pause_for_user'], ['browser', 'wait_for'], ['accessibility', 'get_value'], ['computer', 'screenshot'],
      ['computer', 'hover'], ['window', 'list']] as const) {
      expect(isActingAction(c, a)).toBe(false);
    }
    for (const [c, a] of [['computer', 'click'], ['accessibility', 'focus'], ['window', 'focus'], ['system', 'clipboard_write'],
      ['browser', 'navigate'], ['accessibility', 'set_value']] as const) {
      expect(isActingAction(c, a)).toBe(true);
    }
    expect(isActingAction('computer', undefined)).toBe(false);
  });

  it('JSON is detected by parsing: arrays of primitives, numbers, strings in quotes', () => {
    for (const t of ['["a","b"]', '42', '"hello"', ' {"a":1} ', 'true', 'null']) expect(isJsonText(t)).toBe(true);
    for (const t of ['[failed]', '{not json', 'mailto:a@b.com', 'Clicked']) expect(isJsonText(t)).toBe(false);
  });

  it('a Screen Recording denial is a refusal that says what fixes it — never "read the screen" (#276)', () => {
    const c = classifyResult('Screen Recording permission denied — grant it to the app running clawdcursor in System Settings', true, true);
    expect(c).toMatchObject({ code: 'CAPTURE_DENIED', outcome: 'refused' });
    // the helper-missing failure (#244) is not a denial
    expect(classifyResult('Screen capture unavailable on macOS (helper missing). Grant Screen Recording to the app running clawdcursor', true, true)?.code).not.toBe('CAPTURE_DENIED');
  });

  it('install problems are not NOT_FOUND ("helper not found" is not a missing element)', () => {
    for (const t of ['screenshot-helper not found at /x — it was not built', 'native helper not found; run ./build.sh',
      'Model not found (404)', 'tesseract not found']) {
      expect(classifyResult(t, true, true)?.code).not.toBe('NOT_FOUND');
    }
    for (const t of ['Element not found: name=\'Save\'', 'Window not found', 'a11y invoke "X" missed — element not found',
      'No window or running app matches "Finderr".', 'No open window belongs to a process matching "x".',
      'No open window matches the given process or title.', 'No window has a title containing "x".']) {
      expect(classifyResult(t, true, true)?.code).toBe('NOT_FOUND');
    }
  });

  it('an element that was found but does not take the verb is UNSUPPORTED_ACTION, not NOT_FOUND', () => {
    for (const t of ['a11y invoke "More options" missed — TogglePattern not supported.',
      'a11y invoke "X" missed — SelectionItemPattern not supported.',
      'a11y_toggle failed for "Z": ExpandCollapsePattern not supported.',
      'a11y invoke "W" missed — element cannot expand or collapse.']) {
      const c = classifyResult(t, true, true);
      expect(c?.code, t).toBe('UNSUPPORTED_ACTION');
      expect(c?.hint).toMatch(/found it/);
      expect(c?.next).toMatch(/state/);
    }
    // a real miss stays a miss, even when its reason is worded close by
    for (const t of ["a11y invoke \"X\" missed — Element not found: name='X' id='' ct=''.", 'a11y invoke "X" missed — No window for pid 12.']) {
      expect(classifyResult(t, true, true)?.code).toBe('NOT_FOUND');
    }
  });

  it('the repeat guard is REPEATED, not "fix the arguments"', () => {
    expect(classifyResult('NOT EXECUTED (repeat guard). Do not repeat this exact call.', true, true)?.code).toBe('REPEATED');
    expect(classifyResult('NOT EXECUTED: arguments were not valid JSON', true, true)?.code).toBe('INVALID_ARGS');
  });

  it('a blocked submit is READBACK_MISMATCH (both the suggestion and the different-text wording)', () => {
    for (const t of ['Typed 9 chars (keys): "github.c", but the field shows the typed text with more after it (an autocomplete suggestion: Delete drops it) — Return not pressed.',
      'Typed 9 chars (keys): "x", but the field shows different text (a suggestion took over, or the field reformatted it) — Return not pressed.']) {
      expect(classifyResult(t, true, true)?.code).toBe('READBACK_MISMATCH');
    }
  });

  it('confirmation markers count only where the checks write them — content cannot pose as one', () => {
    expect(classifyResult('Typed 5 chars (keys, read back ✓): "hello"', false, true)?.outcome).toBe('confirmed');
    // typed text, a window title or a page that contains the marker words
    expect(classifyResult('Typed 30 chars (keys): "x (keys, read back ✓) y"', false, true)?.outcome).toBe('unverified');
    expect(classifyResult('Clicked in [app] "Order — verified 1 check(s) — Shop"', false, true)?.outcome).toBe('unverified');
    expect(classifyResult('Clicked "Save" — verified 2 check(s)', false, true)?.outcome).toBe('confirmed');
  });

  it('"VERIFIED" inside a body is not a confirmation', () => {
    expect(classifyResult('result:\nVERIFIED by the page', false, true)?.outcome).toBe('unverified');
    expect(classifyResult('VERIFIED:\n✓ x', false, true)?.outcome).toBe('confirmed');
  });
});
