/**
 * Safety Layer tests.
 * Mocks native-desktop so nut-js is never loaded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock nut-js before any module that imports it
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), scrollDown: vi.fn(), scrollUp: vi.fn(), drag: vi.fn() },
  keyboard: { config: {}, type: vi.fn(), pressKey: vi.fn(), releaseKey: vi.fn() },
  screen: { grab: vi.fn(), grabRegion: vi.fn(), width: vi.fn(), height: vi.fn() },
  Button: { LEFT: 0, RIGHT: 1 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));

vi.mock('sharp', () => ({ default: vi.fn(() => ({ resize: vi.fn().mockReturnThis(), png: vi.fn().mockReturnThis(), jpeg: vi.fn().mockReturnThis(), toBuffer: vi.fn().mockResolvedValue(Buffer.from('')) })) }));

import { SafetyLayer } from '../safety';
import { SafetyTier } from '../types';

function makeConfig(overrides?: { blockedPatterns?: string[]; confirmPatterns?: string[] }) {
  return {
    safety: {
      blockedPatterns: overrides?.blockedPatterns ?? [
        'format disk', 'rm -rf', 'shutdown', 'reboot', 'mkfs', 'dd if=', 'diskpart', ':(){:|:&};:',
        'reg delete', 'net user', 'Remove-Item -Recurse -Force C:',
      ],
      confirmPatterns: overrides?.confirmPatterns ?? ['delete all', 'wipe'],
      requireConfirm: false,
    },
    ai: { model: 'test', provider: 'test' },
    server: { port: 3847, host: '127.0.0.1' },
    capture: { format: 'png', quality: 80 },
    debug: false,
  } as any;
}

function typeAction() {
  return { kind: 'type' as const, text: 'hello world' };
}
function clickAction() {
  return { kind: 'click' as const, x: 100, y: 200 };
}

describe('SafetyLayer — terminal type actions', () => {
  let safety: SafetyLayer;
  beforeEach(() => { safety = new SafetyLayer(makeConfig()); });

  it('type in powershell description → Confirm', () => {
    expect(safety.classify(typeAction(), 'type command in powershell')).toBe(SafetyTier.Confirm);
  });

  it('type in cmd description → Confirm', () => {
    expect(safety.classify(typeAction(), 'enter text in cmd window')).toBe(SafetyTier.Confirm);
  });

  it('type in bash description → Confirm', () => {
    expect(safety.classify(typeAction(), 'type ls -la in bash terminal')).toBe(SafetyTier.Confirm);
  });

  it('type in Windows Terminal (wt) → Confirm', () => {
    expect(safety.classify(typeAction(), 'type command in wt')).toBe(SafetyTier.Confirm);
  });

  it('type in Notepad (non-terminal) → Preview', () => {
    expect(safety.classify(typeAction(), 'type text in Notepad')).toBe(SafetyTier.Preview);
  });

  it('type in Word (non-terminal) → Preview', () => {
    expect(safety.classify(typeAction(), 'type document content in Word')).toBe(SafetyTier.Preview);
  });

  it('type in browser address bar (non-terminal) → Preview', () => {
    expect(safety.classify(typeAction(), 'type URL in Chrome address bar')).toBe(SafetyTier.Preview);
  });
});

describe('SafetyLayer — blocked patterns', () => {
  let safety: SafetyLayer;
  beforeEach(() => { safety = new SafetyLayer(makeConfig()); });

  it('format disk → Confirm', () => {
    expect(safety.classify(clickAction(), 'format disk C:')).toBe(SafetyTier.Confirm);
  });

  it('rm -rf → Confirm', () => {
    expect(safety.classify(typeAction(), 'rm -rf /')).toBe(SafetyTier.Confirm);
  });

  it('shutdown → Confirm', () => {
    expect(safety.classify(clickAction(), 'shutdown now')).toBe(SafetyTier.Confirm);
  });

  it('reboot → Confirm', () => {
    expect(safety.classify(clickAction(), 'reboot the system')).toBe(SafetyTier.Confirm);
  });
});

describe('SafetyLayer — confirm patterns', () => {
  let safety: SafetyLayer;
  beforeEach(() => { safety = new SafetyLayer(makeConfig()); });

  it('delete all → Confirm', () => {
    expect(safety.classify(clickAction(), 'delete all files')).toBe(SafetyTier.Confirm);
  });
});

describe('SafetyLayer — auto tier', () => {
  let safety: SafetyLayer;
  beforeEach(() => { safety = new SafetyLayer(makeConfig()); });

  it('normal click → Auto', () => {
    expect(safety.classify(clickAction(), 'click OK button')).toBe(SafetyTier.Auto);
  });

  it('mouse move → Auto', () => {
    expect(safety.classify({ kind: 'move' as any, x: 0, y: 0 }, 'move mouse to top-left')).toBe(SafetyTier.Auto);
  });
});

describe('SafetyLayer — isBlocked()', () => {
  let safety: SafetyLayer;
  beforeEach(() => { safety = new SafetyLayer(makeConfig()); });

  it('rm -rf is blocked', () => {
    expect(safety.isBlocked('rm -rf /')).toBe(true);
  });

  it('ordinary task is not blocked', () => {
    expect(safety.isBlocked('open Chrome and go to github.com')).toBe(false);
  });
});
