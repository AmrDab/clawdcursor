/**
 * The versatile pause card: `pause_for_user` with `choices` (buttons) and/or `input` (a text box).
 * Contract under test:
 *   - validation: 2-6 distinct one-line options of at most 40 chars, `input` {placeholder?, multiline?}; bad values
 *     are rejected with a message that names the limit
 *   - a click on the pill prints BANNER_CHOICE <index>; the TEXT comes from the gate, never from the pill
 *   - a choice settles as {status:"replied", choice:"<exact text>"}; typed text stays {status:"replied", reply}
 *   - only the user can choose: an agent's answer never carries a choice, and its resume stays unverified
 *   - a choice cannot lift a guard: the input layer (Stop, the hard key list, the AI-host guard) never reads the pause gate
 *   - no choices / input = the plain prompt (same info, same env, same results as before)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'child_process';
import { controlBanner, overlayEnv, parseChoiceLine, type OverlayMode } from '../core/banner';
import { pauseGate, parsePauseCard } from '../core/pause-gate';
import { getAgentTools } from '../tools/agent';
import { getCompactSurface } from '../tools/registry';
import type { ToolContext } from '../tools/types';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  killed = false;
  kill(): boolean { this.killed = true; this.emit('exit', 0); return true; }
}

let pills: Array<{ child: FakeChild; mode: OverlayMode }>;
const livePill = () => pills.filter(p => !p.child.killed);
const say = (line: string) => livePill().slice(-1)[0].child.stdout.write(line + '\n');
const flush = () => new Promise(r => setImmediate(r));
const pauseForUser = getAgentTools().find(t => t.name === 'pause_for_user')!;
const noCtx = {} as ToolContext;
const body = async (args: Record<string, unknown>) => JSON.parse((await pauseForUser.handler({ timeout: 5, ...args }, noCtx)).text);

beforeEach(() => {
  pills = [];
  delete process.env.CLAWD_NO_PAUSE;
  pauseGate.__resetForTests();
  controlBanner.__resetForTests();
  controlBanner.__setPlatformEnabledForTests(true);
  controlBanner.__setSpawnerForTests(mode => { const c = new FakeChild(); pills.push({ child: c, mode }); return c as unknown as ChildProcess; });
  controlBanner.__setOutlineSpawnerForTests(() => new FakeChild() as unknown as ChildProcess);
});

afterEach(() => {
  pauseGate.__resetForTests();
  controlBanner.__resetForTests();
  process.env.CLAWD_NO_PAUSE = '1';
});

describe('parsePauseCard: validation', () => {
  it('accepts 2-6 options and an input object', () => {
    expect(parsePauseCard(['Yes', 'No'], undefined)).toEqual({ choices: ['Yes', 'No'] });
    expect(parsePauseCard(['a', 'b', 'c', 'd', 'e', 'f'], undefined)).toEqual({ choices: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(parsePauseCard(undefined, { placeholder: 'Your answer', multiline: true })).toEqual({ input: { placeholder: 'Your answer', multiline: true } });
    expect(parsePauseCard(undefined, {})).toEqual({ input: {} });
    expect(parsePauseCard(['Yes', 'No'], { multiline: false })).toEqual({ choices: ['Yes', 'No'], input: {} });
    expect(parsePauseCard(undefined, undefined)).toEqual({});
    expect(parsePauseCard(null, null)).toEqual({});
  });

  it('takes the JSON text of an array / object too (the MCP convention here)', () => {
    expect(parsePauseCard('["Yes","No"]', '{"multiline":true}')).toEqual({ choices: ['Yes', 'No'], input: { multiline: true } });
  });

  it('trims, collapses spaces and de-duplicates (case-insensitively, first wins)', () => {
    expect(parsePauseCard(['  Yes ', 'No', 'yes', 'NO', 'Not  sure'], undefined)).toEqual({ choices: ['Yes', 'No', 'Not sure'] });
  });

  it('rejects the wrong count, counted after de-duplication', () => {
    expect(parsePauseCard(['Only one'], undefined)).toMatchObject({ error: expect.stringMatching(/2-6 distinct options \(got 1\)/) });
    expect(parsePauseCard(['Yes', 'yes'], undefined)).toMatchObject({ error: expect.stringMatching(/2-6 distinct options \(got 1\)/) });
    expect(parsePauseCard([], undefined)).toMatchObject({ error: expect.stringMatching(/got 0/) });
    expect(parsePauseCard(['a', 'b', 'c', 'd', 'e', 'f', 'g'], undefined)).toMatchObject({ error: expect.stringMatching(/got 7/) });
  });

  it('rejects an option longer than 40 characters (never cuts it)', () => {
    expect(parsePauseCard(['x'.repeat(40), 'No'], undefined)).toEqual({ choices: ['x'.repeat(40), 'No'] });
    expect(parsePauseCard(['x'.repeat(41), 'No'], undefined)).toMatchObject({ error: expect.stringMatching(/41 characters.*40 or fewer/) });
  });

  it('rejects non-strings, empty, multi-line and non-array choices', () => {
    expect(parsePauseCard(['Yes', 3], undefined)).toMatchObject({ error: expect.stringMatching(/must be a string/) });
    expect(parsePauseCard(['Yes', '  '], undefined)).toMatchObject({ error: expect.stringMatching(/empty/) });
    expect(parsePauseCard(['Yes', 'No\nMaybe'], undefined)).toMatchObject({ error: expect.stringMatching(/one line/) });
    expect(parsePauseCard('Yes, No', undefined)).toMatchObject({ error: expect.stringMatching(/must be an array/) });
    expect(parsePauseCard({ a: 1 }, undefined)).toMatchObject({ error: expect.stringMatching(/must be an array/) });
  });

  it('rejects an option posing as one of the card\'s own buttons, punctuation and emoji aside', () => {
    for (const label of ['Resume', 'end task', 'Something else', 'Send', 'Type an answer', 'Resume!', '  RESUME. ', 'Resume now', '✅ Resume',
      'End-task', 'End task now', '🛑 End Task!', 'Or something else...', 'Send!', '"Send"']) {
      expect(parsePauseCard(['Yes', label], undefined), label).toMatchObject({ error: expect.stringMatching(/card's own buttons/) });
    }
  });

  it('keeps real answers that merely mention those words', () => {
    expect(parsePauseCard(['Yes, send', 'Do not send', 'Send it later', 'Not ready to resume', 'Stop the task'], undefined))
      .toEqual({ choices: ['Yes, send', 'Do not send', 'Send it later', 'Not ready to resume', 'Stop the task'] });
  });

  it('treats null (what some hosts send for "not given") as absent', async () => {
    expect(parsePauseCard(null, null)).toEqual({});
    const call = body({ message: 'Sign in to Glama', choices: null, input: null });
    await flush();
    expect(pauseGate.current()).not.toHaveProperty('choices');
    say('BANNER_RESUME');
    expect((await call).status).toBe('resumed');
  });

  it('rejects a malformed input', () => {
    expect(parsePauseCard(undefined, 'free text')).toMatchObject({ error: expect.stringMatching(/must be an object/) });
    expect(parsePauseCard(undefined, true)).toMatchObject({ error: expect.stringMatching(/must be an object/) });
    expect(parsePauseCard(undefined, ['a'])).toMatchObject({ error: expect.stringMatching(/must be an object/) });
    expect(parsePauseCard(undefined, { multi_line: true })).toMatchObject({ error: expect.stringMatching(/unknown field.*multi_line.*placeholder, multiline/) });
    expect(parsePauseCard(undefined, { multiline: 'yes' })).toMatchObject({ error: expect.stringMatching(/true or false/) });
    expect(parsePauseCard(undefined, { placeholder: 5 })).toMatchObject({ error: expect.stringMatching(/must be a string/) });
    expect(parsePauseCard(undefined, { placeholder: 'a\nb' })).toMatchObject({ error: expect.stringMatching(/one line/) });
    expect(parsePauseCard(undefined, { placeholder: 'p'.repeat(81) })).toMatchObject({ error: expect.stringMatching(/81 characters.*80 or fewer/) });
  });
});

describe('pause_for_user tool: arguments', () => {
  it('rejects bad choices / input with the reason, and shows nothing', async () => {
    for (const args of [{ choices: ['Only one'] }, { choices: ['a', 'b'], input: { nope: 1 } }, { choices: ['x'.repeat(41), 'b'] }]) {
      const r = await pauseForUser.handler({ message: 'Which one?', ...args }, noCtx);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text).toMatch(/^pause_for_user: /);
    }
    expect(pauseGate.current()).toBeNull();
  });

  it('rejects done_when together with a question (a screen state is never a user\'s answer)', async () => {
    const r = await pauseForUser.handler({ message: 'Proceed?', choices: ['Yes', 'No'], done_when: [{ type: 'element_exists', name: 'Done' }] }, noCtx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/done_when cannot be combined/);
    expect(pauseGate.current()).toBeNull();
  });

  it('publishes choices (array of strings) and input (object) in its schema', () => {
    expect(pauseForUser.parameters.choices).toMatchObject({ type: 'array', required: false, items: { type: 'string' } });
    expect(pauseForUser.parameters.input).toMatchObject({ type: 'object', required: false, properties: { placeholder: { type: 'string' }, multiline: { type: 'boolean' } } });
    expect(pauseForUser.parameters.message.required).toBe(true);
  });

  it('is reachable as `system {action:"pause_for_user", choices, input}` on the compact surface', () => {
    const system = getCompactSurface().find(t => t.name === 'system')!;
    expect(system.parameters.choices).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(system.parameters.input).toMatchObject({ type: 'object' });
    expect(system.description).toMatch(/not in your own chat/);
  });

  it('tells agents to ask on the card, not in their chat, and before an irreversible action the user did not ask for', () => {
    expect(pauseForUser.description).toMatch(/the user is watching the screen, not your chat: ask them on this prompt \(use `choices` when there are options\), not in your own chat/);
    expect(pauseForUser.description).toMatch(/before an irreversible action the user did not ask for \(sending, deleting, paying, closing unsaved work\): ask, then follow their answer/);
  });
});

describe('choice mapping', () => {
  it('a click on option N settles as {status:"replied", choice: <exact text>}', async () => {
    const call = body({ message: 'Send the application now?', choices: ['Yes, send', 'No, wait', 'Ask me later'] });
    await flush();
    expect(pills[0].mode.paused?.choices).toEqual(['Yes, send', 'No, wait', 'Ask me later']);
    say('BANNER_CHOICE 1');
    const r = await call;
    expect(r.status).toBe('replied');
    expect(r.choice).toBe('No, wait');
    expect(r).not.toHaveProperty('reply');
    expect(r.next).toMatch(/their answer to your question: follow it, and nothing beyond what it covers/);
    expect(pauseGate.current()).toBeNull();
  });

  it('the text comes from the gate: the pill\'s own words, bad or out-of-range indexes are ignored', async () => {
    const p = pauseGate.requestWithReply({ message: 'Pick', choices: ['Yes', 'No'] });
    for (const line of ['BANNER_CHOICE Yes', 'BANNER_CHOICE 2', 'BANNER_CHOICE 99', 'BANNER_CHOICE -1', 'BANNER_CHOICE 1 extra', 'BANNER_CHOICE 001x', 'BANNER_CHOICE ']) say(line);
    await flush();
    expect(pauseGate.current()?.message).toBe('Pick');   // still waiting
    say('BANNER_CHOICE 0');
    expect(await p).toEqual({ outcome: 'replied', choice: 'Yes' });
  });

  it('a choice line with no choices on the card is ignored', async () => {
    const p = pauseGate.requestWithReply({ message: 'Sign in' });
    say('BANNER_CHOICE 0');
    await flush();
    expect(pauseGate.current()?.message).toBe('Sign in');
    say('BANNER_RESUME');
    expect((await p).outcome).toBe('resumed');
  });

  it('only the pill of the pause it was drawn for can choose', async () => {
    const first = pauseGate.requestWithReply({ message: 'One', choices: ['A', 'B'] });
    const stale = pills[0].child;
    pauseGate.answer('end');
    await first;
    const second = pauseGate.requestWithReply({ message: 'Two', choices: ['C', 'D'] });
    stale.stdout.write('BANNER_CHOICE 0\n');
    await flush();
    expect(pauseGate.current()?.message).toBe('Two');
    pauseGate.answer('end');
    await second;
  });

  it('typed text on a card with input stays {status:"replied", reply}', async () => {
    const call = body({ message: 'What is the company name?', input: { placeholder: 'Company', multiline: false } });
    await flush();
    expect(pills[0].mode.paused?.input).toEqual({ placeholder: 'Company' });
    say(`BANNER_REPLY ${Buffer.from('Acme Corp', 'utf8').toString('base64')}`);
    const r = await call;
    expect(r).toMatchObject({ status: 'replied', reply: 'Acme Corp' });
    expect(r).not.toHaveProperty('choice');
  });

  it('keeps the line breaks of a multiline answer', async () => {
    const p = pauseGate.requestWithReply({ message: 'Describe it', input: { multiline: true } });
    say(`BANNER_REPLY ${Buffer.from('line one\r\nline two', 'utf8').toString('base64')}`);
    expect((await p).reply).toBe('line one\nline two');
  });

  it('a card can offer both: a choice or text, whichever the user gives', async () => {
    const p = pauseGate.requestWithReply({ message: 'Which plan?', choices: ['Free', 'Pro'], input: {} });
    say(`BANNER_REPLY ${Buffer.from('Team, billed yearly', 'utf8').toString('base64')}`);
    expect(await p).toEqual({ outcome: 'replied', reply: 'Team, billed yearly' });
  });

  it('Resume and End task still work on a card', async () => {
    const a = pauseGate.requestWithReply({ message: 'Pick', choices: ['A', 'B'] });
    say('BANNER_RESUME');
    expect((await a).outcome).toBe('resumed');
    const b = pauseGate.requestWithReply({ message: 'Pick again', choices: ['A', 'B'] });
    say('BANNER_END');
    expect((await b).outcome).toBe('ended');
  });

  it('a different card is a different question: it does not re-attach to the one on screen', async () => {
    const first = pauseForUser.handler({ message: 'Proceed?', choices: ['Yes', 'No'], timeout: 1 }, noCtx);
    await flush();
    const other = JSON.parse((await pauseForUser.handler({ message: 'Proceed?', choices: ['Go', 'Stop'], timeout: 1 }, noCtx)).text);
    expect(other.status).toBe('busy');
    expect(pauseGate.current()?.choices).toEqual(['Yes', 'No']);
    // …while the same card re-attaches and gets the answer
    const again = pauseForUser.handler({ message: 'Proceed?', choices: ['Yes', 'No'], timeout: 5 }, noCtx);
    await flush();
    say('BANNER_CHOICE 0');
    expect(JSON.parse((await again).text)).toMatchObject({ status: 'replied', choice: 'Yes' });
    await first;
  });

  it('a choice that lands while the caller was told "waiting" is handed to its next call, choice included', async () => {
    const args = { message: 'Proceed?', choices: ['Yes', 'No'], timeout: 1 };
    expect(JSON.parse((await pauseForUser.handler(args, noCtx)).text).status).toBe('waiting');
    say('BANNER_CHOICE 1');
    await flush();
    expect(JSON.parse((await pauseForUser.handler(args, noCtx)).text)).toMatchObject({ status: 'replied', choice: 'No' });
  });
});

describe('who can answer', () => {
  it('an agent cannot choose, and its resume stays unverified', async () => {
    const p = pauseGate.requestWithReply({ message: 'Pick', choices: ['A', 'B'] });
    expect(pauseGate.answer('choice', 'agent', undefined, 0)).toEqual({ ok: false, error: 'a choice can only be made by the user on screen' });
    expect(pauseGate.current()?.message).toBe('Pick');
    expect(pauseGate.answer('resume', 'agent')).toEqual({ ok: true, outcome: 'resumed_unverified' });
    expect(await p).toEqual({ outcome: 'resumed_unverified' });
  });

  it('a user answer must name an existing option', async () => {
    const p = pauseGate.requestWithReply({ message: 'Pick', choices: ['A', 'B'] });
    for (const i of [undefined, -1, 2, 1.5, NaN]) {
      expect(pauseGate.answer('choice', 'user', undefined, i as number), String(i)).toEqual({ ok: false, error: 'no such choice' });
    }
    expect(pauseGate.answer('choice', 'user', undefined, 1)).toEqual({ ok: true, outcome: 'replied' });
    expect(await p).toEqual({ outcome: 'replied', choice: 'B' });
  });

  it('the agent-facing resume_task on a card is an unverified resume, never a choice', async () => {
    const resumeTask = getAgentTools().find(t => t.name === 'resume_task')!;
    const call = body({ message: 'Proceed?', choices: ['Yes', 'No'] });
    await flush();
    await resumeTask.handler({}, noCtx);
    const r = await call;
    expect(r.status).toBe('resumed');
    expect(r.confirmedByUser).toBe(false);
    expect(r).not.toHaveProperty('choice');
  });

  it('POST /resume has no way to name a choice (the HTTP route only knows resume / end / reply)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'surface', 'http-utility.ts'), 'utf8');
    expect(src).toMatch(/\['resume', 'end', 'reply'\]\.includes\(answer\)/);
  });
});

describe('a choice cannot lift a guard', () => {
  it('the input layer and the batch executor never read the pause gate for a go-ahead', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    for (const file of ['platform/hard-keys.ts', 'platform/pointer-guard.ts', 'tools/batch.ts', 'tools/projected/tools.ts']) {
      expect(readFileSync(join(src, file), 'utf8'), file).not.toMatch(/pause-gate|pauseGate/);
    }
  });
});

describe('the overlay protocol', () => {
  it('parseChoiceLine reads only "BANNER_CHOICE <1-2 digit index>"', () => {
    expect(parseChoiceLine('BANNER_CHOICE 0')).toBe(0);
    expect(parseChoiceLine('BANNER_CHOICE 5')).toBe(5);
    expect(parseChoiceLine('BANNER_CHOICE 12')).toBe(12);
    for (const bad of ['BANNER_CHOICE', 'BANNER_CHOICE ', 'BANNER_CHOICE -1', 'BANNER_CHOICE 1.5', 'BANNER_CHOICE 123', 'BANNER_CHOICE Yes',
      'BANNER_CHOICE 1 2', ' BANNER_CHOICE 1', 'banner_choice 1', 'BANNER_CHOICES 1', 'BANNER_REPLY 1', 'BANNER_RESUME']) {
      expect(parseChoiceLine(bad), bad).toBeNull();
    }
  });

  it('hands the card to the overlay as JSON in the environment (any text survives; nothing is quoted into argv)', () => {
    const tricky = ['Fish & chips', 'He said "no"', 'back\\slash', 'ünïcode ✓', "it's"];
    const env = overlayEnv({ paused: { id: 1, message: 'Pick', since: 0, choices: tricky, input: { placeholder: 'Why?', multiline: true } } });
    expect(JSON.parse(env.CLAWD_BANNER_CHOICES!)).toEqual(tricky);
    expect(JSON.parse(env.CLAWD_BANNER_INPUT!)).toEqual({ placeholder: 'Why?', multiline: true });
    expect(env.CLAWD_BANNER_MODE).toBe('paused');
  });

  it('a plain pause carries an EMPTY card, even if the daemon\'s own environment had these variables', () => {
    process.env.CLAWD_BANNER_CHOICES = '["stray"]';
    process.env.CLAWD_BANNER_INPUT = '{}';
    try {
      const env = overlayEnv({ paused: { id: 1, message: 'Sign in', since: 0 } });
      expect(env.CLAWD_BANNER_CHOICES).toBe('');
      expect(env.CLAWD_BANNER_INPUT).toBe('');
    } finally {
      delete process.env.CLAWD_BANNER_CHOICES;
      delete process.env.CLAWD_BANNER_INPUT;
    }
  });

  it('the running (not paused) overlay gets no card variables', () => {
    const env = overlayEnv({});
    expect(env.CLAWD_BANNER_MODE).toBeUndefined();
    expect(env.CLAWD_BANNER_CHOICES).toBeUndefined();
  });
});

describe('backward compatibility: no choices, no input', () => {
  it('is the same pause as before', async () => {
    const p = pauseGate.requestWithReply({ message: 'Sign in to GitHub' });
    const info = pauseGate.current()!;
    expect(Object.keys(info).sort()).toEqual(['id', 'message', 'since']);
    expect(pills[0].mode.paused).toEqual(info);
    pauseGate.answer('resume');
    expect(await p).toEqual({ outcome: 'resumed' });
  });

  it('the tool returns the old results, with no choice field, and keeps the old re-attach key', async () => {
    const call = body({ message: 'Sign in to Glama' });
    await flush();
    expect(pauseGate.continues('mcp:sign in to glama')).toBe(true);
    say('BANNER_RESUME');
    const r = await call;
    expect(r).toMatchObject({ status: 'resumed', confirmedByUser: true });
    expect(r).not.toHaveProperty('choice');

    const typed = body({ message: 'Code?' });
    await flush();
    say(`BANNER_REPLY ${Buffer.from('4821', 'utf8').toString('base64')}`);
    expect(await typed).toMatchObject({ status: 'replied', reply: '4821' });

    const ended = body({ message: 'Anything' });
    await flush();
    say('BANNER_END');
    expect((await ended).status).toBe('ended');
  });

  it('a card the gate is handed that is invalid is dropped, not shown half-formed', async () => {
    const p = pauseGate.requestWithReply({ message: 'x', choices: ['only one'] });
    expect(pauseGate.current()).not.toHaveProperty('choices');
    pauseGate.answer('resume');
    await p;
  });
});
