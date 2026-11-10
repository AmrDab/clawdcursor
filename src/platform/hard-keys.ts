/**
 * The hard key list: the few OS-level key combinations clawdcursor never sends, whoever asks.
 *
 * They lock the machine, end the session or are reserved by the OS — after one of them the agent has no desktop left to
 * work on, and the user comes back to a locked or logged-out machine. Everything else is allowed: which shortcut to press
 * is the agent's decision (and its MCP host's permission prompt), not clawdcursor's.
 *
 * Only the list of the OS clawdcursor is running on applies. The one call site is `guardInputMethods`
 * (pointer-guard.ts), which every synthetic key press goes through in both input layers — so a tool name, a batch step,
 * a named shortcut or a sequence cannot route around it (GHSA-35pc-g74h-p476, GHSA-3v3f-5rwv-whc9).
 */
import { normalizeKey } from './keys';

type Os = NodeJS.Platform;

/** A combo is refused when ALL of its keys are down together: extra keys or modifiers beside them change nothing. */
const HARD_KEYS: Record<'win32' | 'darwin' | 'linux', ReadonlyArray<{ keys: string[]; why: string }>> = {
  win32: [
    { keys: ['super', 'l'], why: 'locks the screen' },
    { keys: ['ctrl', 'alt', 'delete'], why: 'is the secure attention sequence' },
  ],
  darwin: [
    { keys: ['ctrl', 'super', 'q'], why: 'locks the screen' },
    { keys: ['super', 'shift', 'q'], why: 'logs the user out' },   // also cmd+opt+shift+q (log out at once)
    { keys: ['power'], why: 'sleeps, restarts or shuts down the Mac' },
    { keys: ['eject'], why: 'sleeps, restarts or shuts down the Mac' },
  ],
  linux: [
    { keys: ['super', 'l'], why: 'locks the screen' },
    { keys: ['ctrl', 'alt', 'l'], why: 'locks the screen' },
    { keys: ['ctrl', 'alt', 'delete'], why: 'logs out or reboots' },
    { keys: ['ctrl', 'alt', 'backspace'], why: 'kills the display server' },
    ...Array.from({ length: 12 }, (_, i) => ({ keys: ['ctrl', 'alt', `f${i + 1}`], why: 'switches away from the desktop session to a console' })),
    { keys: ['sysrq'], why: 'is the kernel SysRq key' },
    { keys: ['power'], why: 'sleeps or shuts down the machine' },
  ],
};

const listFor = (os: Os) => HARD_KEYS[os === 'win32' || os === 'darwin' ? os : 'linux'];

const SIDE = '(left|right|l|r)?_?';
const SUFFIX = '(_?(l|r))?';
/** Every spelling of the Super / Windows / Command key, with left/right and `_l`/`_r` variants (`LeftWin`, `super_l`). */
const SUPER = new RegExp(`^${SIDE}(super|win|windows|meta|cmd|command)${SUFFIX}$`);
const FAMILIES: ReadonlyArray<[RegExp, string]> = [
  [new RegExp(`^${SIDE}(ctrl|control)${SUFFIX}$`), 'ctrl'],
  [new RegExp(`^${SIDE}(alt|option|opt)${SUFFIX}$|^altgr$`), 'alt'],
  [new RegExp(`^${SIDE}shift${SUFFIX}$`), 'shift'],
  [/^(del|delete|forwarddelete|kp_delete)$/, 'delete'],
  [/^(backspace|bksp|back_space)$/, 'backspace'],
  [/^(xf86)?(power|poweroff|power_off)$/, 'power'],
  [/^(sysrq|sys_req|sysreq)$/, 'sysrq'],
];
/** What keys.ts resolves an alias to, as a family name — so an alias added there is known here too. */
const NORMALIZED: ReadonlyMap<unknown, string> = new Map([['Super', 'super'], ['Control', 'ctrl'], ['Alt', 'alt'], ['Shift', 'shift'], ['Delete', 'delete'], ['Backspace', 'backspace']]);

/**
 * One name per key, whatever the spelling or case. The whole Super family is one key, with one exception that is not a
 * bypass: on Windows both executors press `cmd` / `command` as Ctrl (keys.ts, windows.ts), so `cmd+l` there is Ctrl+L.
 * `meta` is NOT in that exception: the Windows adapter's keyDown holds the Windows key for it.
 */
function canon(token: string, os: Os): string {
  const t = token.trim().toLowerCase();
  if (t === 'mod') return os === 'darwin' ? 'super' : 'ctrl';
  if (os === 'win32' && (t === 'cmd' || t === 'command')) return 'ctrl';
  if (SUPER.test(t)) return 'super';
  const family = FAMILIES.find(([re]) => re.test(t))?.[1];
  if (family) return family;
  return NORMALIZED.get(normalizeKey(t)) ?? t;
}

/** The keys of one chord. `+` joins a chord; `sep` also breaks on `-` and `_` (`ctrl-alt-del`, `super_l+l`). */
function chordKeys(chord: string, os: Os, sep: RegExp): string[] {
  return chord.split(sep).map(k => k.trim()).filter(Boolean).map(k => canon(k, os));
}

/** The canonical keys a combo names — what `guardInputMethods` records as held between key_down and key_up. */
export function keysOf(combo: unknown, os: Os = process.platform): string[] {
  return chordKeys(String(combo ?? ''), os, /\+/);
}

/**
 * Why this key input is refused, or null when it may be sent.
 *
 * `combo` is one chord ("win+l") or a whitespace-separated sequence ("esc win+l"); `held` are keys already down from
 * key_down. Every reading an executor could give the string is checked — each element of a sequence, the whole string
 * with its whitespace dropped ("win + l"), split on `+` alone and on `+`/`-`/`_` — each together with the held keys.
 * Case, modifier order, repeated keys and aliases make no difference.
 */
export function hardKeyRefusal(combo: unknown, held: Iterable<string> = [], os: Os = process.platform): string | null {
  const input = String(combo ?? '');
  const heldKeys = [...held];
  const chords = [...input.trim().split(/\s+/), input.replace(/\s+/g, '')];
  for (const chord of chords) {
    for (const sep of [/\+/, /[+_-]+/]) {
      const down = new Set([...heldKeys, ...chordKeys(chord, os, sep)]);
      const hit = listFor(os).find(h => h.keys.every(k => down.has(k)));
      if (hit) {
        const withHeld = heldKeys.length ? ` together with the held ${heldKeys.join('+')} (release it with key_up first)` : '';
        return `Refused: "${input.trim()}"${withHeld} is a dangerous key combo — ${hit.keys.join('+')} ${hit.why}, ` +
          'so clawdcursor never sends it. Every other shortcut is allowed. If the task needs this step, ask the user to do it with pause_for_user.';
      }
    }
  }
  return null;
}
