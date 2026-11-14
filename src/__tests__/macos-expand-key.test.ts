/**
 * The key step of expand / collapse on macOS (review of #335). A web <summary> opens on Return and a list that will not close
 * takes Escape; the accessibility helper never presses a key on its own: it answers `data.needsKey`, and MacOSAdapter.invokeElement
 *   - checks that the element's own app is the one in front (else a miss that says "window focus"),
 *   - runs the key through the same input guard as every other key (stop, clawdcursor's own control, the window the agent works in)
 *     and the keyboard guard (a system dialog owning the keyboard refuses),
 *   - and only then calls the helper again with the key allowed.
 * The helper is a fake here; what it does with the key is covered live (mac-ax-live.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  Button: { LEFT: 0 },
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('child_process', () => ({
  execFile: (_c: string, _a: string[], _o: unknown, cb: (e: unknown, r?: unknown) => void) => cb(null, { stdout: '{}', stderr: '' }),
  spawn: vi.fn(),
}));

import { MacOSAdapter } from '../platform/macos';
import { setInputGuard } from '../platform/pointer-guard';
import type { MacAx, FrontmostInfo } from '../platform/mac-ax';
import type { WindowInfo } from '../platform/types';

const RECT = { x: 0, y: 0, width: 600, height: 400 };
const WIN = (over: Partial<WindowInfo> = {}): WindowInfo =>
  ({ title: 'Page', processName: 'Safari', processId: 4242, bounds: RECT, isMinimized: false, handle: 4242, ...over });
const FRONT = (over: Partial<NonNullable<FrontmostInfo['app']>> = {}): FrontmostInfo =>
  ({ locked: false, app: { name: 'Safari', processId: 4242, activationPolicy: 'regular', windows: [], ...over } });

const ASKS = (key: 'Return' | 'Escape') => ({
  success: false,
  error: `it needs the ${key} key to finish; the caller sends it through the input guard`,
  data: { needsKey: key },
});

/** A fake accessibility client: `invoke` answers from the list (the last answer repeats) and notes what it was asked, in order. */
function fakeAx(answers: Array<Record<string, unknown>>, over: Partial<MacAx> = {}, order: string[] = []) {
  let i = 0;
  const ax = {
    activeWindow: vi.fn(async () => WIN()),
    frontmost: vi.fn(async () => FRONT()),
    invoke: vi.fn(async (q: Record<string, unknown>) => {
      order.push(`invoke${q.allowKey ? `:${q.allowKey}` : ''}`);
      return answers[Math.min(i++, answers.length - 1)];
    }),
    prepare: vi.fn(),
    ...over,
  };
  return ax as unknown as MacAx & { invoke: ReturnType<typeof vi.fn>; activeWindow: ReturnType<typeof vi.fn> };
}

/** An input guard that notes its calls in `order`; `before` can be made to refuse. */
function installGuard(order: string[], refuse?: Error) {
  setInputGuard({
    stopCheck: () => { order.push('stop'); },
    before: async () => { order.push('before'); if (refuse) throw refuse; },
    done: (movesFocus: boolean) => { order.push(`done:${movesFocus}`); },
    focused: async () => {},
    launched: async () => {},
    byName: async () => {},
  });
}
// (the test setup turns the helper off; the keyboard guard only looks at the app in front when it is on)
beforeEach(() => { process.env.CLAWD_NO_MAC_AX = '0'; });
afterEach(() => { setInputGuard(null); process.env.CLAWD_NO_MAC_AX = '1'; });

const DONE = { success: true, data: { expandState: 'Expanded' } };

describe('expand: the helper needs Return', () => {
  it('runs the input guard first, then calls the helper again with the key allowed - nothing else presses a key', async () => {
    const order: string[] = [];
    installGuard(order);
    const ax = fakeAx([ASKS('Return'), DONE], {}, order);
    const res = await new MacOSAdapter({ ax }).invokeElement({ name: 'More options', processId: 4242, action: 'expand' });
    expect(res).toMatchObject({ success: true, data: { expandState: 'Expanded' } });
    expect(order).toEqual(['invoke', 'before', 'invoke:Return', 'done:true']);        // the guard sits BETWEEN the two calls
    expect(ax.invoke).toHaveBeenCalledTimes(2);
    expect(ax.invoke.mock.calls[0][0]).not.toHaveProperty('allowKey');
    expect(ax.invoke.mock.calls[1][0]).toMatchObject({ name: 'More options', processId: 4242, action: 'expand', allowKey: 'Return' });
  });

  it('the app that has the element is not in front: no key, no second call, and the miss says to bring the window forward', async () => {
    const order: string[] = [];
    installGuard(order);
    const ax = fakeAx([ASKS('Return'), DONE], { activeWindow: vi.fn(async () => WIN({ processName: 'Mail', processId: 777 })) }, order);
    const res = await new MacOSAdapter({ ax }).invokeElement({ name: 'More options', processId: 4242, action: 'expand' });
    expect(res.success).toBe(false);
    expect(res.data?.error).toMatch(/Return key/);
    expect(res.data?.error).toMatch(/window focus/);
    expect(order).toEqual(['invoke']);                                                // the guard was not even asked: nothing was sent
  });

  it('nothing is known about the app in front: no key either', async () => {
    const ax = fakeAx([ASKS('Return'), DONE], { activeWindow: vi.fn(async () => null) });
    const res = await new MacOSAdapter({ ax }).invokeElement({ name: 'More options', processId: 4242, action: 'expand' });
    expect(res.success).toBe(false);
    expect(ax.invoke).toHaveBeenCalledTimes(1);
  });

  it('the input guard refuses (the user stopped clawdcursor / switched apps): the refusal reaches the caller and no key is allowed', async () => {
    const order: string[] = [];
    installGuard(order, new Error('foreground changed: you were working in Notes (pid 1), but Safari (pid 4242) is in front now'));
    const ax = fakeAx([ASKS('Return'), DONE], {}, order);
    await expect(new MacOSAdapter({ ax }).invokeElement({ name: 'More options', processId: 4242, action: 'expand' }))
      .rejects.toThrow(/foreground changed/);
    expect(order).toEqual(['invoke', 'before']);
    expect(ax.invoke).toHaveBeenCalledTimes(1);
  });

  it('the keyboard guard refuses while a system dialog owns the keyboard (a Return could press "Allow")', async () => {
    const alert = FRONT({ name: 'UserNotificationCenter', processId: 311, activationPolicy: 'accessory', windows: [{ title: 'Foo wants access', subrole: 'AXSystemDialog' }] });
    const ax = fakeAx([ASKS('Return'), DONE], { frontmost: vi.fn(async () => alert) });
    await expect(new MacOSAdapter({ ax }).invokeElement({ name: 'More options', processId: 4242, action: 'expand' }))
      .rejects.toThrow(/system dialog/i);
    expect(ax.invoke).toHaveBeenCalledTimes(1);
  });

  it('the process asked for is the one resolved from the app in front when the caller gave none', async () => {
    const order: string[] = [];
    installGuard(order);
    const ax = fakeAx([ASKS('Return'), DONE], {}, order);
    const res = await new MacOSAdapter({ ax }).invokeElement({ name: 'More options', action: 'expand' });
    expect(res.success).toBe(true);
    expect(ax.invoke.mock.calls[1][0]).toMatchObject({ processId: 4242, allowKey: 'Return' });
  });

  it('a second answer that is still a miss is returned as the miss it is, with its reason', async () => {
    installGuard([]);
    const ax = fakeAx([ASKS('Return'), { success: false, error: 'pressed Return on it, but it did not expand', data: { acted: true } }]);
    const res = await new MacOSAdapter({ ax }).invokeElement({ name: 'More options', processId: 4242, action: 'expand' });
    expect(res).toMatchObject({ success: false, data: { acted: true, error: 'pressed Return on it, but it did not expand' } });
  });
});

describe('collapse: a list that will not close needs Escape', () => {
  it('goes through the same guard, and the helper is called again with Escape allowed', async () => {
    const order: string[] = [];
    installGuard(order);
    const ax = fakeAx([ASKS('Escape'), { success: true, data: { expandState: 'Collapsed' } }], {}, order);
    const res = await new MacOSAdapter({ ax }).invokeElement({ name: 'Favorite color', controlType: 'PopUpButton', processId: 4242, action: 'collapse' });
    expect(res).toMatchObject({ success: true, data: { expandState: 'Collapsed' } });
    expect(order).toEqual(['invoke', 'before', 'invoke:Escape', 'done:true']);
  });

  it('is refused the same way when its app is not in front', async () => {
    const ax = fakeAx([ASKS('Escape'), DONE], { activeWindow: vi.fn(async () => WIN({ processId: 777 })) });
    const res = await new MacOSAdapter({ ax }).invokeElement({ name: 'Favorite color', processId: 4242, action: 'collapse' });
    expect(res.success).toBe(false);
    expect(ax.invoke).toHaveBeenCalledTimes(1);
  });
});

describe('everything else is left alone', () => {
  it('an answer without needsKey is one call', async () => {
    const order: string[] = [];
    installGuard(order);
    const ax = fakeAx([{ success: false, error: 'the element cannot be expanded through accessibility' }], {}, order);
    const res = await new MacOSAdapter({ ax }).invokeElement({ name: 'Save', processId: 4242, action: 'expand' });
    expect(res).toMatchObject({ success: false, data: { error: 'the element cannot be expanded through accessibility' } });
    expect(order).toEqual(['invoke']);
  });

  it('needsKey on any other action is not acted on (only expand / collapse know the handshake)', async () => {
    const order: string[] = [];
    installGuard(order);
    const ax = fakeAx([ASKS('Return'), DONE], {}, order);
    const res = await new MacOSAdapter({ ax }).invokeElement({ name: 'Save', processId: 4242, action: 'click' });
    expect(res.success).toBe(false);
    expect(order).toEqual(['invoke']);
  });

  it('a success the first time presses nothing', async () => {
    const order: string[] = [];
    installGuard(order);
    const ax = fakeAx([DONE], {}, order);
    const res = await new MacOSAdapter({ ax }).invokeElement({ name: 'Favorite color', processId: 4242, action: 'expand' });
    expect(res.success).toBe(true);
    expect(order).toEqual(['invoke']);
  });
});
