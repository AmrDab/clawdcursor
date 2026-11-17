/** Tests that write the user's clipboard, or whose answer depends on the apps this machine has, run only with
 *  CLAWD_LIVE_TESTS=1 (CI sets it). They live in the `system` project (vitest.config.ts). */
export const LIVE = process.env.CLAWD_LIVE_TESTS === '1';
