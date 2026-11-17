/** Wait `ms` on the global timer: tests drive it with vi.useFakeTimers() instead of waiting for real time. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
