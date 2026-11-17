/**
 * Rung 0 acts by name (UIA SetValue, Invoke) can take the foreground: Notepad, Edge and Calculator did in the own-window
 * probe (2026-11-16). When the target is not the window the user is in, an act that pulled the foreground to it puts the
 * user's window back.
 */
import type { WindowInfo } from './types';

interface Front { getActiveWindow(): Promise<WindowInfo | null>; restoreForeground(handle: number): Promise<boolean> }

const isTarget = (w: WindowInfo, pid: number) => w.processId === pid || w.hostedProcessId === pid;

/** Runs `act`; `gaveBack` is true only when the foreground went to `pid` during it and the user's window is verified back in front. */
export async function withGiveBack<T>(front: Front, pid: number | undefined, act: () => Promise<T>): Promise<{ result: T; gaveBack: boolean }> {
  const before = pid === undefined ? null : await front.getActiveWindow().catch(() => null);
  const userHandle = typeof before?.handle === 'number' && before.handle > 0 ? before.handle : undefined;
  if (!before || userHandle === undefined || isTarget(before, pid!)) return { result: await act(), gaveBack: false };
  const result = await act();
  const after = await front.getActiveWindow().catch(() => null);
  const gaveBack = !!after && isTarget(after, pid!) && await front.restoreForeground(userHandle).catch(() => false);
  return { result, gaveBack };
}
