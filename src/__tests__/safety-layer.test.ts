/**
 * SafetyLayer tests — tier assignment, blocked keys, destructive labels,
 * sensitive apps.
 */

import { describe, it, expect } from 'vitest';
import { evaluate, isAllowed, evaluateInput } from '../core/safety';

describe('SafetyLayer.evaluate', () => {
  describe('read tier', () => {
    it.each(['read_screen', 'desktop_screenshot', 'get_windows', 'read_clipboard', 'cdp_read_text'])(
      '%s always allows',
      (tool) => {
        const d = evaluate({ tool, args: {} });
        expect(d.decision).toBe('allow');
        expect(d.tier).toBe('read');
      },
    );
  });

  describe('blocked keys (two-tier: HARD block vs CONFIRM)', () => {
    it('HARD-blocks ctrl+alt+delete (secure attention sequence)', () => {
      const d = evaluate({ tool: 'key_press', args: { key: 'Ctrl+Alt+Delete' } });
      expect(d.decision).toBe('block');
    });
    it('HARD-blocks win+l (lock)', () => {
      expect(evaluate({ tool: 'key_press', args: { key: 'win+l' } }).decision).toBe('block');
    });
    it('CONFIRMS (not hard-blocks) alt+F4 — closing a window is a legit, approvable action', () => {
      const d = evaluate({ tool: 'key_press', args: { key: 'alt+f4' } });
      expect(d.decision).toBe('confirm');
    });
    it('CONFIRMS cmd+Q via press (pipeline-internal alias)', () => {
      expect(evaluate({ tool: 'press', args: { combo: 'cmd+q' } }).decision).toBe('confirm');
    });
    it('CONFIRMS win+d (show desktop) — was a dead-end hard block before v1.6.0', () => {
      expect(evaluate({ tool: 'key_press', args: { key: 'win+d' } }).decision).toBe('confirm');
    });
    it('CONFIRMS ctrl+w (close tab)', () => {
      expect(evaluate({ tool: 'key_press', args: { key: 'ctrl+w' } }).decision).toBe('confirm');
    });
    it('allows safe combos', () => {
      expect(evaluate({ tool: 'key_press', args: { key: 'mod+s' } }).decision).toBe('allow');
      expect(evaluate({ tool: 'press', args: { combo: 'Return' } }).decision).toBe('allow');
    });
  });

  // GHSA-35pc-g74h-p476. Two independent bypasses of this same gate:
  //   1. the gate keyed on four tool NAMES, and the autonomous agent loop
  //      registers its keyboard tool as `key` — none of the four — so every
  //      blocked combo fell through to the default allow on the agent path.
  //   2. normalizeCombo collapses whitespace, so the documented sequence form
  //      "esc win+l" became "escwin+l", matched nothing, and the executor then
  //      split that same string and pressed win+l.
  // These cases pin the tool name the agent loop actually uses; the pre-existing
  // cases above only ever passed key_press, which is why neither was caught.
  describe('keyboard gate is tool-name agnostic (GHSA-35pc-g74h-p476)', () => {
    const COMBOS: Array<[string, 'block' | 'confirm']> = [
      ['win+l', 'block'], ['cmd+ctrl+q', 'block'], ['cmd+shift+q', 'block'],
      ['cmd+opt+esc', 'block'], ['ctrl+shift+esc', 'block'],
      ['cmd+q', 'confirm'], ['cmd+w', 'confirm'],
      ['win+r', 'confirm'], ['cmd+space', 'confirm'],
    ];

    it.each(COMBOS)('%s resolves to %s on the agent loop\'s tool name "key"', (combo, tier) => {
      // agent.ts gates with `tool: call.name`, and tools.ts registers `name: 'key'`.
      expect(evaluate({ tool: 'key', args: { combo } }).decision).toBe(tier);
    });

    it.each(COMBOS)('%s resolves identically on "key" and "key_press"', (combo) => {
      expect(evaluate({ tool: 'key', args: { combo } }).decision)
        .toBe(evaluate({ tool: 'key_press', args: { key: combo } }).decision);
    });

    it('gates an unknown/renamed keyboard tool by arg shape', () => {
      expect(evaluate({ tool: 'some_future_key_tool', args: { combo: 'win+l' } }).decision).toBe('block');
    });

    it('does not over-block — a safe combo still passes under the bare name', () => {
      expect(evaluate({ tool: 'key', args: { combo: 'Tab' } }).decision).toBe('allow');
      expect(evaluate({ tool: 'key', args: { combo: 'mod+s' } }).decision).toBe('allow');
    });

    it('blocks a blocked combo hiding in a whitespace-separated SEQUENCE', () => {
      // The executor splits on whitespace and presses each element, so the gate
      // must classify each element too.
      expect(evaluate({ tool: 'key_press', args: { key: 'esc win+l' } }).decision).toBe('block');
      expect(evaluate({ tool: 'key', args: { combo: 'Down Down win+l' } }).decision).toBe('block');
      expect(evaluate({ tool: 'key', args: { combo: 'a ctrl+w' } }).decision).toBe('confirm');
    });

    it('still matches a chord carrying a stray space ("alt +f4")', () => {
      // The collapsed view is retained alongside the per-element view, so the
      // sequence fix does not regress this documented case.
      expect(evaluate({ tool: 'key_press', args: { key: 'alt +f4' } }).decision).toBe('confirm');
    });

    it('takes the STRONGEST tier when a sequence mixes tiers', () => {
      expect(evaluate({ tool: 'key', args: { combo: 'ctrl+w win+l' } }).decision).toBe('block');
    });

    it('leaves an ordinary sequence alone', () => {
      expect(evaluate({ tool: 'key', args: { combo: 'Down Down End' } }).decision).toBe('allow');
      expect(evaluate({ tool: 'key', args: { combo: 'ctrl+a Delete' } }).decision).toBe('allow');
    });
  });

  describe('minimize tier parity (granular == compound)', () => {
    it('minimize is allowed (tier 1) on BOTH the granular tools and the window compound', () => {
      // Was a divergence: granular minimize_window declared tier 2 (confirm)
      // while the compound window{minimize} used TOOL_TIER=input (allow).
      expect(evaluate({ tool: 'minimize_window', args: {} }).decision).toBe('allow');
      expect(evaluate({ tool: 'minimize_window_to_taskbar', args: {} }).decision).toBe('allow');
      expect(evaluate({ tool: 'window', args: { action: 'minimize' } }).decision).toBe('allow');
    });
  });

  describe('cdp_evaluate', () => {
    it('requires confirm even without args inspection', () => {
      expect(evaluate({ tool: 'cdp_evaluate', args: {} }).decision).toBe('confirm');
    });
  });

  describe('destructive target labels', () => {
    it.each(['Send', 'Delete', 'Confirm', 'Remove', 'Checkout', 'Pay', 'Publish', 'Log Out'])(
      'elevates click with target=%j to confirm',
      (label) => {
        const d = evaluate({ tool: 'mouse_click', args: {}, targetLabel: label });
        expect(d.decision).toBe('confirm');
        expect(d.tier).toBe('destructive');
      },
    );

    it('allows click on benign target', () => {
      expect(evaluate({ tool: 'mouse_click', args: {}, targetLabel: 'New' }).decision).toBe('allow');
    });
  });

  // #124: destructive-label patterns must NOT fire on the CONTENT typed by a
  // typing tool. The `targetLabel` for type_text/cdp_type is the text payload,
  // not a control label — typing a sentence containing "confirm"/"send" is
  // benign and must stay at input tier.
  describe('typed text is not a destructive label (#124)', () => {
    const prose = 'This is part of the v0.9.5 verification to confirm reliable desktop automation.';

    it('allows type_text whose content contains "confirm"', () => {
      const d = evaluate({ tool: 'type_text', args: { text: prose }, targetLabel: prose });
      expect(d.decision).toBe('allow');
    });

    it('allows type_text whose content contains "send"', () => {
      const d = evaluate({ tool: 'type_text', args: { text: 'please send the report' }, targetLabel: 'please send the report' });
      expect(d.decision).toBe('allow');
    });

    it('allows the compound computer.type action with "confirm" in the text', () => {
      // unpacks to canonical type_text
      const d = evaluate({ tool: 'computer', args: { action: 'type', text: prose }, targetLabel: prose });
      expect(d.decision).toBe('allow');
    });

    it('allows cdp_type (browser.type) prose containing "delete"', () => {
      const d = evaluate({ tool: 'browser', args: { action: 'type', text: 'delete this line of the draft' }, targetLabel: 'delete this line of the draft' });
      expect(d.decision).toBe('allow');
    });

    // Coverage that MUST be preserved: activating a control whose label is
    // destructive still confirms, including cdp_click by visible text.
    it('still confirms cdp_click on visible text "Send"', () => {
      const d = evaluate({ tool: 'cdp_click', args: { text: 'Send' }, targetLabel: 'Send' });
      expect(d.decision).toBe('confirm');
      expect(d.tier).toBe('destructive');
    });

    it('still confirms invoke_element name="Delete"', () => {
      const d = evaluate({ tool: 'invoke_element', args: { name: 'Delete' }, targetLabel: 'Delete' });
      expect(d.decision).toBe('confirm');
    });

    it('still confirms the compound browser.click on visible text "Pay"', () => {
      const d = evaluate({ tool: 'browser', args: { action: 'click', text: 'Pay' }, targetLabel: 'Pay' });
      expect(d.decision).toBe('confirm');
    });
  });

  describe('input tier default', () => {
    it.each(['mouse_click', 'type_text', 'smart_click', 'smart_type', 'a11y_click'])(
      '%s with no target defaults to allow',
      (tool) => {
        expect(evaluate({ tool, args: {} }).decision).toBe('allow');
      },
    );
  });

  describe('isAllowed helper', () => {
    it('is true for allow', () => {
      expect(isAllowed({ decision: 'allow', tier: 'read' })).toBe(true);
    });
    it('is false for confirm and block', () => {
      expect(isAllowed({ decision: 'confirm', tier: 'input', reason: 'x' })).toBe(false);
      expect(isAllowed({ decision: 'block', tier: 'destructive', reason: 'x' })).toBe(false);
    });
  });

  describe('unknown tools default to input tier', () => {
    it('treats a made-up tool name as input tier + allow-by-default', () => {
      const d = evaluate({ tool: 'future_tool_xyz', args: {} });
      expect(d.decision).toBe('allow');
      expect(d.tier).toBe('input');
    });
  });
});

describe('open_uri — scheme-aware tier', () => {
  const ev = (uri: string) => evaluate({ tool: 'open_uri', args: { uri }, activeApp: 'olk', userTaskText: 'send an email' });
  it('allows benign compose/navigate schemes', () => {
    for (const u of ['mailto:a@b.com?subject=hi&body=x', 'tel:+15551234', 'sms:+15551234', 'webcal://h/c.ics', 'https://example.com', 'http://example.com']) {
      expect(ev(u).decision).toBe('allow');
    }
  });
  it('confirms file: (can execute) and unknown schemes', () => {
    expect(ev('file:///C:/Windows/System32/calc.exe').decision).toBe('confirm');
    expect(ev('weirdcustomscheme:do-something').decision).toBe('confirm');
    expect(ev('not-a-uri').decision).toBe('confirm');
  });
  it('confirms execution-surface / auto-action schemes (security-audit trim)', () => {
    // vscode:// → Remote SSH/tasks/git-clone; obsidian:// → plugin/shell cmds;
    // zoommtg/msteams → auto-join a call. NOT mere navigation → must confirm.
    for (const u of ['vscode://file/Users/me/x.ts', 'vscode-insiders://file/x', 'obsidian://advanced-uri?commandid=x', 'zoommtg://zoom.us/join?confno=1', 'msteams://l/meetup-join/x']) {
      expect(ev(u).decision).toBe('confirm');
    }
  });
  it('applies scheme tiering through the compound system({action:"open_uri"}) surface too', () => {
    const evc = (uri: string) => evaluate({ tool: 'system', args: { action: 'open_uri', uri }, activeApp: 'olk', userTaskText: 'send an email' });
    expect(evc('mailto:a@b.com').decision).toBe('allow');
    expect(evc('file:///etc/passwd').decision).toBe('confirm');
  });
});

describe('evaluateInput (canonical safety gate)', () => {
  it('returns allow:true for a read-tier tool', () => {
    const d = evaluateInput({ toolName: 'desktop_screenshot', args: {} });
    expect(d.allow).toBe(true);
    expect(d.tier).toBe(0);
  });

  it('safetyTier:3 injected via ToolDefinition overrides name-based lookup', () => {
    // 'wait' is normally tier 0 (read), but declaring it as tier 3 should elevate it
    const d = evaluateInput({ toolName: 'wait', args: {}, safetyTier: 3 });
    // tier 3 maps to 'destructive' — which means decision is 'confirm', so allow === false
    expect(d.allow).toBe(false);
    expect(d.tier).toBe(3);
  });
});
