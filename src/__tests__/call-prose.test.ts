/**
 * Hints name a call as prose ("the browser tool, action page_context"), never as `browser {"action":"page_context"}`: a
 * host's tools carry a server prefix, and an agent that copied the bare name got "No such tool".
 */
import { describe, it, expect } from 'vitest';
import { callsAsProse, resultCallsAsProse } from '../tools/hints';
import { classifyResult, renderResultLine } from '../core/result-codes';

/** Any `name {"key": …` or `name({…` call shape left in a text. */
const CALL_SHAPE = /[a-z_]+\(?\s*\{\s*"?[a-z_]+"?\s*:/;

describe('callsAsProse', () => {
  it('names the compound tool and the action', () => {
    expect(callsAsProse('next: browser {"action":"page_context"}')).toBe('next: the browser tool, action page_context');
  });

  it('keeps the arguments readable, including placeholders and quoted names', () => {
    expect(callsAsProse('computer {"action":"click","x":<x>,"y":<y>,"space":"screen"} (bounds: accessibility find)'))
      .toBe('the computer tool, action click, x <x>, y <y>, space "screen" (bounds: accessibility find)');
    expect(callsAsProse('accessibility {"action":"invoke","name":"Save, as {copy}"} (works out of view)'))
      .toBe('the accessibility tool, action invoke, name "Save, as {copy}" (works out of view)');
  });

  it('a granular tool written with its own name is put in compact names', () => {
    expect(callsAsProse('press it with smart_click {"target":"<label>"}')).toBe('press it with the accessibility tool, action smart_click, target "<label>"');
  });

  it('takes the ticks and brackets around a call with it', () => {
    expect(callsAsProse('Call `browser({"action":"connect","port":9222})` to attach')).toBe('Call the browser tool, action connect, port 9222 to attach');
  });

  it('leaves other braces alone', () => {
    const t = 'Returns JSON {status:"ok"|"none", snapshot_id} and {"a":1}';
    expect(callsAsProse(t)).toBe(t);
  });
});

describe('resultCallsAsProse', () => {
  it('does not touch screen content or the data of a JSON result', () => {
    const screen = '<untrusted-screen-content>\nbrowser {"action":"page_context"}\n</untrusted-screen-content>';
    expect(resultCallsAsProse(screen)).toBe(screen);
    const data = '{"text":"browser {\\"action\\":\\"page_context\\"}","next":"system {\\"action\\":\\"ocr\\"}"}';
    expect(JSON.parse(resultCallsAsProse(data))).toEqual({ text: 'browser {"action":"page_context"}', next: 'the system tool, action ocr' });
  });
});

describe('result-line hints', () => {
  const samples: Array<[string, boolean]> = [
    ['no window matching "x"', true],
    ['foreground changed: the window in front is not Notepad', true],
    ['the screen changed since the screenshot: an older screenshot; the latest is s2', true],
    ['not connected', true],
    ['element is disabled', true],
    ['invoke "Sav" missed — element not found\nClosest names:\n<untrusted-screen-content>\n[1] "Save {as}"\n</untrusted-screen-content>', true],
    ['several elements on screen match that name, nothing was done', true],
    ['no invoke/toggle/select/expand pattern', true],
  ];

  {
    it('no rendered next line has a call shape', () => {
      for (const [text, err] of samples) {
        const c = classifyResult(text, err, true);
        expect(c?.next, text).toBeTruthy();
        const line = resultCallsAsProse(renderResultLine(c!));
        expect(line, text).not.toMatch(CALL_SHAPE);
        expect(line, text).toMatch(/next: the \w+ tool/);
      }
    });
  }
});
