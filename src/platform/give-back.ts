/**
 * Rung 0 acts by name (UIA SetValue, Invoke) can take the foreground: Notepad, Edge and Calculator did in the own-window
 * probe (2026-11-16). When the target is not the window the user is in, an act that pulled the foreground to it puts the
 * user's window back.
 */
import type { WindowInfo } from './types';

interface Front { getActiveWindow(): Promise<WindowInfo | null>; restoreForeground(handle: number): Promise<boolean> }

const isTarget = (w: WindowInfo, pid: number) => w.processId === pid || w.hostedProcessId === pid;

/**
 * Runs `act`. `focus`: what happened to the user's window, when it could be told (the target was not in front before):
 * 'kept' (it stayed in front), 'gave-back' (the act took the foreground and the user's window is verified back in front), 'lost'
 * (the act took it and it could not be given back). `gaveBack` is the second.
 */
export async function withGiveBack<T>(front: Front, pid: number | undefined, act: () => Promise<T>): Promise<{ result: T; gaveBack: boolean; focus?: 'kept' | 'gave-back' | 'lost' }> {
  const before = pid === undefined ? null : await front.getActiveWindow().catch(() => null);
  const userHandle = typeof before?.handle === 'number' && before.handle > 0 ? before.handle : undefined;
  if (!before || userHandle === undefined || isTarget(before, pid!)) return { result: await act(), gaveBack: false };
  const result = await act();
  const after = await front.getActiveWindow().catch(() => null);
  if (!after) return { result, gaveBack: false };
  if (!isTarget(after, pid!)) return { result, gaveBack: false, focus: 'kept' };
  const gaveBack = await front.restoreForeground(userHandle).catch(() => false);
  return { result, gaveBack, focus: gaveBack ? 'gave-back' : 'lost' };
}
