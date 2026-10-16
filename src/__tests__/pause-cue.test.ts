/**
 * #237: the pause prompt was silent (a user not looking at the screen never
 * knew it was their turn), and its state was readable only from the pill
 * process's environment. Now: a short system sound from each OS's drawer
 * (opt out with CLAWD_PAUSE_SOUND=0), the mode in argv as well, and
 * agent_status reports the overlay's mode with the pause message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { controlBanner, overlayEnv, pillArgs } from '../core/banner';
import { pauseGate } from '../core/pause-gate';
import { getAgentTools } from '../tools/agent';
import type { ToolContext } from '../tools/types';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  kill(): boolean { this.emit('exit', 0); return true; }
}

const agentStatus = getAgentTools().find(t => t.name === 'agent_status')!;
const info = { id: 1, message: 'Sign in to GitHub, then click Resume', since: 1000 };
const script = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '../../scripts', ...p), 'utf8');

beforeEach(() => {
  delete process.env.CLAWD_NO_PAUSE;
  pauseGate.__resetForTests();
  controlBanner.__resetForTests();
  controlBanner.__setPlatformEnabledForTests(true);
  controlBanner.__setSpawnerForTests(() => new FakeChild() as unknown as ChildProcess);
  controlBanner.__setGlowSpawnerForTests(() => new FakeChild() as unknown as ChildProcess);
});

afterEach(() => {
  vi.unstubAllEnvs();
  pauseGate.__resetForTests();
  controlBanner.__resetForTests();
  process.env.CLAWD_NO_PAUSE = '1';
});

describe('pause sound switch', () => {
  it('the paused pill is told to play its sound by default', () => {
    expect(overlayEnv({ paused: info }).CLAWD_PAUSE_SOUND).toBe('1');
  });

  it('CLAWD_PAUSE_SOUND=0 reaches the drawer as 0', () => {
    vi.stubEnv('CLAWD_PAUSE_SOUND', '0');
    expect(overlayEnv({ paused: info }).CLAWD_PAUSE_SOUND).toBe('0');
  });

  it('every drawer plays a system sound in paused mode, unless CLAWD_PAUSE_SOUND=0', () => {
    const ps = script('banner.ps1');
    expect(ps).toMatch(/\[System\.Media\.SystemSounds\]::Asterisk\.Play\(\)/);
    expect(ps).toMatch(/CLAWD_PAUSE_SOUND -ne '0'/);
    const swift = script('mac', 'overlay.swift');
    expect(swift).toMatch(/NSSound\(named: "Glass"\)/);
    expect(swift).toMatch(/NSSound\.beep\(\)/);
    expect(swift).toMatch(/CLAWD_PAUSE_SOUND"\] != "0"/);
    const py = script('linux', 'overlay.py');
    expect(py).toMatch(/canberra-gtk-play/);
    expect(py).toMatch(/dialog-information/);
    expect(py).toMatch(/\.beep\(\)/);
    expect(py).toMatch(/CLAWD_PAUSE_SOUND'\) == '0'/);
  });
});

describe('the overlay mode is machine-readable', () => {
  it('the paused pill carries --paused in argv; the running one does not', () => {
    expect(pillArgs({ paused: info })).toEqual(['--paused']);
    expect(pillArgs({})).toEqual([]);
  });

  it('controlBanner.state(): hidden → running → paused (with the message) → running', () => {
    expect(controlBanner.state()).toEqual({ mode: 'hidden' });
    controlBanner.pin();
    expect(controlBanner.state()).toEqual({ mode: 'running' });
    controlBanner.showPaused(info, () => {});
    expect(controlBanner.state()).toEqual({ mode: 'paused', message: info.message, since: info.since });
    controlBanner.showRunning();
    expect(controlBanner.state()).toEqual({ mode: 'running' });
  });

  it('agent_status reports the pause and the overlay mode while the prompt is up', async () => {
    const pending = pauseGate.request({ message: 'Enter the 2FA code' });
    const body = JSON.parse((await agentStatus.handler({}, {} as ToolContext)).text);
    expect(body.pause.message).toBe('Enter the 2FA code');
    expect(body.overlay).toMatchObject({ mode: 'paused', message: 'Enter the 2FA code' });
    pauseGate.answer('resume');
    await pending;
    const after = JSON.parse((await agentStatus.handler({}, {} as ToolContext)).text);
    expect(after.pause).toBeUndefined();
    expect(after.overlay.mode).not.toBe('paused');
  });

  it('agent_status documents pause and overlay', () => {
    expect(agentStatus.description).toMatch(/pause/);
    expect(agentStatus.description).toMatch(/overlay/);
  });
});
