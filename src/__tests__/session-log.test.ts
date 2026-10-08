/**
 * MCP session log + report: measure whether agents perceive "blind first"
 * (a11y / text) before screenshots, and let a user report a session in one
 * step — without ever recording typed text, clipboard, names or paths.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionLog, classifyCall, outcomeOf, readSession, listSessions } from '../surface/session-log';
import { buildSessionReport, issueUrl, reportMarkdown } from '../surface/report';

beforeEach(() => {
  process.env.CLAWDCURSOR_SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sess-'));
  delete process.env.CLAWDCURSOR_SESSION_LOG;
});

describe('classifyCall', () => {
  it('compact surface', () => {
    expect(classifyCall('computer', 'screenshot')).toBe('vision');
    expect(classifyCall('computer', 'zoom')).toBe('vision');
    expect(classifyCall('computer', 'click')).toBe('act-coords');
    expect(classifyCall('computer', 'type')).toBe('act-other');
    expect(classifyCall('accessibility', 'find')).toBe('blind');
    expect(classifyCall('accessibility', 'invoke')).toBe('act-name');
    expect(classifyCall('accessibility', 'smart_click')).toBe('act-name');
    expect(classifyCall('system', 'copy_all_text')).toBe('blind');
    expect(classifyCall('system', 'ocr')).toBe('blind');
    expect(classifyCall('browser', 'page_context')).toBe('blind');
  });
  it('granular surface', () => {
    expect(classifyCall('desktop_screenshot')).toBe('vision');
    expect(classifyCall('mouse_click')).toBe('act-coords');
    expect(classifyCall('read_screen')).toBe('blind');
    expect(classifyCall('smart_click')).toBe('act-name');
  });
});

describe('outcomeOf', () => {
  it('flags the results that make agents give up on blind reads', () => {
    expect(outcomeOf(false, '(no elements found)')).toBe('empty');
    expect(outcomeOf(true, 'PSRunner timeout: find-element')).toBe('timeout');
    expect(outcomeOf(false, 'FOCUSED WINDOW UI TREE (PARTIAL — …)')).toBe('partial');
    expect(outcomeOf(false, 'Session report — blind reads that came back empty / timed out: 1')).toBe('ok');
    expect(outcomeOf(false, 'Invoked "Save" via a11y.')).toBe('ok');
    expect(outcomeOf(true, 'boom')).toBe('error');
  });
});

describe('SessionLog', () => {
  it('tallies blind-first behaviour and writes no content', () => {
    const log = new SessionLog({ version: '9.9.9', surface: 'compact' });
    log.record('accessibility', 'find', true, 12, undefined, { name: 'claude-code', version: '2.1' }, { outcome: 'empty' });
    log.record('computer', 'screenshot', true, 300);
    log.record('computer', 'screenshot', true, 300);
    log.record('computer', 'click', true, 80, undefined, undefined, { space: 'image' });
    log.record('system', 'copy_all_text', true, 400);
    log.record('computer', 'screenshot', true, 300);
    log.record('accessibility', 'invoke', false, 50, 'no element named "Pay alice@example.com" in C:\\Users\\bob\\x');
    const t = log.summary;
    expect(t).toMatchObject({ calls: 7, blind: 2, vision: 3, actName: 1, actCoords: 1, errors: 1, firstPerception: 'blind',
      visionAfterBlind: 2, blindEmpty: 1, visionAfterBlindMiss: 1 });

    const raw = fs.readFileSync(log.file!, 'utf8');
    expect(raw).toContain('"client":"claude-code 2.1"');
    expect(raw).toContain('"space":"image"');
    expect(raw).not.toContain('alice@example.com');
    expect(raw).not.toContain('bob');
    const back = readSession(log.file!);
    expect(back.tally).toMatchObject({ calls: 7, vision: 3, blindEmpty: 1, visionAfterBlindMiss: 1 });
  });

  it('tracks the screenshot-only streak the nudge keys on', () => {
    const log = new SessionLog({ version: 'x', surface: 'compact' });
    for (let i = 0; i < 3; i++) log.record('computer', 'screenshot', true, 1);
    expect(log.visionOnlyStreak).toBe(3);
    log.record('accessibility', 'read_tree', true, 1);
    expect(log.visionOnlyStreak).toBe(0);
  });

  it('CLAWDCURSOR_SESSION_LOG=0 writes nothing', () => {
    process.env.CLAWDCURSOR_SESSION_LOG = '0';
    const log = new SessionLog({ version: 'x', surface: 'compact' });
    log.record('computer', 'screenshot', true, 1);
    expect(log.file).toBeNull();
    expect(listSessions()).toEqual([]);
  });
});

describe('session report', () => {
  it('builds a GitHub-issue-ready summary of the newest session', () => {
    const log = new SessionLog({ version: '9.9.9', surface: 'compact' });
    log.record('accessibility', 'find', true, 10, undefined, { name: 'cursor' }, { outcome: 'empty' });
    for (let i = 0; i < 4; i++) log.record('computer', 'screenshot', true, 200);
    log.record('computer', 'click', true, 50);
    const r = buildSessionReport(undefined, 'clicks missed the Save button');
    expect(r.session?.client).toBe('cursor');
    expect(r.session?.sequence).toBe('blind vision×4 act-coords');
    const md = reportMarkdown(r);
    expect(md).toMatch(/1 blind .* vs 4 screenshots/);
    expect(md).toMatch(/screenshots right after one: 1/);
    const url = issueUrl(r);
    expect(url.startsWith('https://github.com/AmrDab/clawdcursor/issues/new?')).toBe(true);
    expect(url.length).toBeLessThan(8000);
    expect(new URL(url).searchParams.get('title')).toBe('Report: clicks missed the Save button');
  });
});
