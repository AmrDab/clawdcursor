import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runLogs } from '../src/logs';
import { actedLine, findSession } from '../src/runlog';

// "How it acted" (2026-11-16): a CAD run was 7 accessibility calls, 58 screenshots, 73 coordinate clicks. The tally reads the classes the
// session log wrote; a batch counts by its steps, like bench/lib/scorer.ts.
describe('how a run acted', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-acted-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const lines = (rows: object[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  const call = (tool: string, action: string, cls: string) => ({ t: '2026-11-16T01:04:00.000Z', tool, action, cls, ok: true, ms: 5, outcome: 'ok' });
  const SID = 'session-2026-11-16T01-03-20-000Z-200-1';
  const rows = [
    { type: 'session', started: '2026-11-16T01:03:20.000Z', pid: 200 },
    call('accessibility', 'read_tree', 'blind'),
    call('accessibility', 'smart_click', 'act-name'),
    call('accessibility', 'invoke', 'act-name'),
    call('computer', 'screenshot', 'vision'),
    call('computer', 'click', 'act-coords'),
    // a batch counts by its steps, not as one call
    { ...call('batch', '', 'act-other'), steps: [call('computer', 'click', 'act-coords'), call('computer', 'click', 'act-coords'), call('computer', 'screenshot', 'vision')] },
  ];

  it('counts name, coordinates and screenshots; a batch by its steps', () => {
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), lines(rows));
    const s = findSession(dir, SID)!;
    expect(s.calls).toBe(6);
    expect(s.acted).toEqual({ name: 2, coords: 3, shots: 2 });
  });

  it('the line', () => {
    expect(actedLine({ name: 7, coords: 73, shots: 58 })).toBe('how it acted: 7 by name or label · 73 by coordinates · 58 screenshots');
  });

  it('logs --run shows the line once, from the run\'s session', async () => {
    for (const d of ['logs', 'sessions', 'runs']) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, 'sessions', `${SID}.jsonl`), lines(rows));
    fs.writeFileSync(path.join(dir, 'runs', 'R1.jsonl'), lines([
      { type: 'run', id: 'R1', t: '2026-11-16T01:03:18.000Z', runner: 'claude' },
      { type: 'end', t: '2026-11-16T01:10:49.000Z', verdict: 'PASS', exitCode: 0, session: SID },
    ]));
    const saved = process.env.CLAWDCURSOR_SESSION_DIR;
    delete process.env.CLAWDCURSOR_SESSION_DIR;
    try {
      const out: string[] = [];
      await runLogs({ run: 'R1' } as any, { coreVersion: '2.1.0', coreEntry: '', node: process.execPath, dataDir: dir }, { out: l => out.push(l), color: false });
      expect(out.filter(l => l.includes('how it acted'))).toEqual(['how it acted: 2 by name or label · 3 by coordinates · 2 screenshots']);
    } finally { if (saved !== undefined) process.env.CLAWDCURSOR_SESSION_DIR = saved; }
  });
});
