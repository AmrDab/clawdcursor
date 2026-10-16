import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../core/agent-loop/prompt';

describe('buildSystemPrompt — substrate is the default', () => {
  const p = buildSystemPrompt();
  it('names the substrate tools', () => {
    for (const t of ['compile_ui', 'find_input_field', 'find_action_button', 'element_id', 'snapshot_id']) {
      expect(p).toContain(t);
    }
  });
  it('has a FORM/FIELD workflow rule', () => {
    expect(p).toMatch(/FORM|FIELD/);
    expect(p).toMatch(/find_input_field[\s\S]*set_field_value|set_field_value[\s\S]*element_id/);
  });
  it('describes the UI map (el_NN), not only the legacy a11y snapshot, in the header', () => {
    expect(p).toMatch(/UI map|el_NN|element id/i);
  });
});

describe('buildSystemPrompt — chip flow, numbering, browser pivot', () => {
  const p = buildSystemPrompt();
  it('has no duplicate rule "5b" label', () => {
    const count = (p.match(/^\s*5b\./gm) || []).length;
    expect(count).toBeLessThanOrEqual(1);
  });
  it('chip rule gives the finder+expect worked example', () => {
    expect(p).toMatch(/tokeniz|chip/i);
    expect(p).toMatch(/key\([\s\S]*Return[\s\S]*expect|expect[\s\S]*element_exists/);
  });
  it('forbids re-hosting a native app in the browser', () => {
    expect(p).toMatch(/web version|browser version|re-?host/i);
  });
});

describe('buildSystemPrompt — email goes through the mailto URI handler', () => {
  const p = buildSystemPrompt();
  it('tells the model to pre-fill email via build_uri/open_uri (mailto), not hand-drive the compose UI', () => {
    expect(p).toMatch(/EMAIL[\s\S]*mailto/i);
    expect(p).toMatch(/build_uri\("mailto"[\s\S]*open_uri/);
  });
});

describe('buildSystemPrompt — batchability judgment + verify', () => {
  const p = buildSystemPrompt();
  it('teaches that batchability is a judgment (deterministic vs dynamic) and to verify after', () => {
    expect(p).toMatch(/batchab|DETERMINED IN ADVANCE|determined in advance/i);
    expect(p).toMatch(/do NOT batch|don't batch/i);
    expect(p).toMatch(/AFTER any batch|verify the outcome/i);
  });
});

describe('buildSystemPrompt — plan limits are a roadblock (#239)', () => {
  const p = buildSystemPrompt();
  it('treats an upgrade wall as a roadblock: ask_user, never click Upgrade / Subscribe', () => {
    const rule = p.slice(p.indexOf('ROADBLOCKS'), p.indexOf('COORDINATES'));
    expect(rule).toMatch(/plan limit|upgrade wall/i);
    expect(rule).toMatch(/ask_user/);
    expect(rule).toMatch(/never click Upgrade \/ Subscribe/i);
  });
});
