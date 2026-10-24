/**
 * macOS accessibility client — one place that knows how to ask the OS about
 * windows and UI elements, shared by `MacOSAdapter` and the legacy
 * `AccessibilityBridge`.
 *
 * Two engines behind one API:
 *   1. scripts/mac/ax-helper.swift, compiled once into ~/.clawdcursor/bin (same
 *      content-addressed cache as the OCR and overlay helpers). It talks to the
 *      AX C API directly: a window list or a window's tree in tens of
 *      milliseconds, where System Events took 8–25 s.
 *   2. The original osascript/JXA scripts, used until the helper is built (or
 *      when `swiftc` is missing / the helper misbehaves).
 *
 * The rule both engines follow: a failure is an ERROR, never an empty answer.
 * A timeout used to be swallowed into `[]` and showed up to agents as
 * "Windows (0)" / "empty a11y tree — custom-canvas app" — a lie that sent them
 * down the wrong path (live blind test, 2026-10-15).
 *
 * Helper protocol (one JSON object on stdout, exit 0 even for logical failures):
 *   {"ok":false,"kind":"timeout|locked|permission|unavailable|failed","error":"…"}
 *   windows   {"ok":true,"windows":[{title,processName,processId,bounds,isMinimized}],
 *              "unresponsive":[{processId,processName}],   // answered nothing for a whole AX timeout: hung
 *              "skipped":[{processId,processName}],        // the time budget never reached them (or cut them short)
 *              "truncated":bool}                           // = skipped is not empty
 *
 * Text the caller typed or searches for (name / id / value) goes to the helper as one JSON object on STDIN
 * (`--args-stdin 1`), not argv: argv is readable by every process on the Mac while the helper runs.
 */
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getPackageRoot } from '../paths';
import { macAxBinary } from './mac-ocr-binary';
import type { InvokeAction, UiElement, WindowInfo } from './types';
import { isOwnUiPid } from './pointer-guard';

const execFileAsync = promisify(execFile);

export type MacAxErrorKind = 'timeout' | 'locked' | 'permission' | 'unavailable' | 'failed' | 'partial';

/** A failed AX read — thrown instead of returning an empty result. */
export class MacAxError extends Error {
  constructor(readonly kind: MacAxErrorKind, message: string) {
    super(message);
    this.name = 'MacAxError';
  }
}

export interface MacAxDeps {
  /**
   * Run an executable and resolve its stdout. Rejects like `execFile` (a timeout sets `killed`).
   * `input` is written to the process's stdin, which is then closed.
   */
  exec(file: string, args: string[], opts: { timeoutMs: number; input?: string }): Promise<{ stdout: string }>;
  /** The compiled helper if it is built, else null (the JXA scripts are used meanwhile). */
  helper(): string | null;
  /**
   * Start (or join) the one-time build of the helper. Resolves its path, or null when it
   * cannot be built. Safe to call on every use; concurrent callers share one build.
   */
  ensureHelper(): Promise<string | null> | void;
  /** Directory holding the JXA fallback scripts. */
  scriptsDir: string;
  /**
   * Whether the screen is locked. System Events does not fail behind the lock screen — it answers with empty
   * shells — so the osascript path asks first. Optional: a probe that is absent or fails never blocks a read.
   */
  screenLocked?(): Promise<boolean>;
  /**
   * Why the fast helper is not available, in words an agent or user can act on (the Command Line Tools are not
   * installed), or null when there is nothing to say. Appended to errors from the slower osascript path.
   */
  helperUnavailableHint?(): string | null;
}

// ─── Budgets ────────────────────────────────────────────────────────────────
/** The helper stops itself at this deadline and reports a timeout… */
const HELPER_LIST_DEADLINE_MS = 4_000;
/** …and we only kill it if it is stuck well past that. */
const HELPER_GRACE_MS = 3_000;
/** Typing: the helper's deadline is this plus a little per character. */
const HELPER_TYPE_BASE_MS = 3_000;
const HELPER_TYPE_PER_CHAR_MS = 20;
/**
 * osascript has no deadline of its own. The window list measured 9.4 s with 15
 * windows open on an M1 iMac, so the old 8 s limit turned a working call into a
 * silent "no windows".
 */
const JXA_LIST_TIMEOUT_MS = 25_000;
/** A tree walk gets longer than a list; the helper stops itself, then we allow the same grace. */
const HELPER_TREE_DEADLINE_MS = 8_000;
const TREE_MAX_DEPTH = 12;
const TREE_MAX_NODES = 3_000;
/** Calculator measured 24.8 s through System Events; the old 12 s limit threw that away. */
const JXA_TREE_TIMEOUT_MS = 30_000;
/** Depth the original get-screen-context.jxa walk always used. */
const JXA_TREE_DEPTH = 8;
const HELPER_FIND_DEADLINE_MS = 6_000;
const HELPER_FOCUS_DEADLINE_MS = 5_000;
/** An unfiltered find returns the whole tree for the caller to filter (find {automationId} used to); keep it generous. */
const FIND_MAX_RESULTS = 500;
const JXA_FIND_TIMEOUT_MS = 12_000;
const JXA_INVOKE_TIMEOUT_MS = 8_000;
const LSAPPINFO_TIMEOUT_MS = 3_000;
/** How long the osascript path answers after the helper itself failed, before the helper is tried again. */
const HELPER_RETRY_MS = 60_000;
/**
 * The helper compiles in a few seconds; the osascript walk it replaces takes 10–25 s. So the
 * first call waits for the build — but not forever (swiftc can hang); the build carries on.
 */
const BUILD_WAIT_MS = 20_000;

const NOT_EMPTY = 'This is NOT an empty result — not "no windows", not a custom-canvas app. Retry, or fall back to a screenshot / OCR.';
/** After a timed-out ACTION a blind retry could do it twice (a second click): look first. */
const ACTION_TIMED_OUT = 'Look at the screen before retrying — the action may already have happened.';
/** A timeout while an action was still SEARCHING for its target (or checking the aim): nothing was pressed, retrying is safe. */
const NOTHING_DONE = 'Nothing was pressed or changed — retry, or fall back to a screenshot / OCR.';

interface HelperFailure {
  ok: false;
  kind?: string;
  error?: string;
  /** The action may have been (partly) performed: an app froze while it ran, or a `type` ran out of time with some of its text typed. Absent for every other timeout. */
  acted?: boolean;
}

const isTimeout = (err: unknown): boolean =>
  (err as { killed?: boolean })?.killed === true || (err as { code?: string })?.code === 'ETIMEDOUT';

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Turn a helper `{ok:false}` reply into the error an agent should read. `act`: the call did something (invoke), not just read. */
function helperError(reply: HelperFailure, what: string, act = false): MacAxError {
  switch (reply.kind) {
    case 'timeout':
      // The helper says which app stopped answering and what that means for the action: more use than the generic line.
      return new MacAxError('timeout',
        `${what} timed out — ${reply.error ? `${reply.error}. ` : 'the accessibility service did not answer in time (an app may be hung or busy). '}` +
        // Only the helper knows whether the press had started: it says so with `acted`.
        `${reply.acted === true ? ACTION_TIMED_OUT : act ? NOTHING_DONE : NOT_EMPTY}`);
    case 'locked':
      return new MacAxError('locked',
        `${what} failed: the screen is locked — the lock screen (loginwindow) owns the display and keyboard. ` +
        'Unlock the Mac; clawdcursor cannot read or control apps behind it.');
    case 'permission':
      return new MacAxError('permission',
        `${what} failed: Accessibility permission is not granted to the app running clawdcursor ` +
        '(System Settings → Privacy & Security → Accessibility).');
    case 'unavailable':
      return new MacAxError('unavailable', `${what} failed: ${reply.error ?? 'the app does not expose accessibility'}`);
    case 'partial':
      // A miss next to elements that did not answer: not a timeout, and not "nothing there" either.
      return new MacAxError('partial', `${what}: ${reply.error ?? 'not found in the readable part of the window'}`);
    default:
      return new MacAxError('failed', `${what} failed: ${reply.error ?? 'unknown error'}`);
  }
}

function timeoutError(what: string, ms: number, act = false): MacAxError {
  return new MacAxError('timeout',
    `${what} timed out after ${Math.round(ms / 1000)}s — the accessibility service did not answer in time ` +
    `(an app may be hung or busy). ${act ? ACTION_TIMED_OUT : NOT_EMPTY}`);
}

/**
 * The strings a caller typed or is searching for travel on stdin, not argv. Only defined values are sent: an empty string
 * is a value (it clears a field), `undefined` is "not given".
 */
function viaStdin(fields: Record<string, string | undefined>): { args: string[]; input?: string } {
  const present = Object.entries(fields).filter((e): e is [string, string] => e[1] !== undefined);
  if (!present.length) return { args: [] };
  // JSON.stringify writes a lone surrogate as "\ud83d"; Foundation's JSONSerialization rejects the WHOLE object for it, where
  // argv would have carried U+FFFD. Make the text well-formed first.
  return { args: ['--args-stdin', '1'], input: JSON.stringify(Object.fromEntries(present.map(([k, v]) => [k, wellFormed(v)]))) };
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const wellFormed = (s: string): string => s.replace(LONE_SURROGATE, '\uFFFD');

/** A name or identifier counts only if it says something: "   " would substring-match the first control with a space in its label. */
const given = (s: string | undefined): string | undefined => (s !== undefined && s.trim() !== '' ? s : undefined);

/** Actions that press or change something: aimed at a role alone they would act on whichever match ranks first. */
const PRESSING_ACTIONS: ReadonlySet<InvokeAction> = new Set<InvokeAction>(['click', 'toggle', 'select', 'expand', 'collapse']);

const toWindow = (raw: any): WindowInfo => ({
  title: raw.title ?? '',
  processName: raw.processName ?? '',
  processId: raw.processId ?? 0,
  bounds: raw.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
  isMinimized: raw.isMinimized ?? false,
  handle: raw.handle ?? raw.processId,
});

const ZERO_RECT = { x: 0, y: 0, width: 0, height: 0 };

/** Cross-platform ControlType names (what the tools say) → macOS AX roles. */
const CONTROL_TYPE_TO_ROLE: Record<string, string> = {
  Button: 'AXButton', Edit: 'AXTextField', Document: 'AXWebArea', ComboBox: 'AXComboBox',
  CheckBox: 'AXCheckBox', RadioButton: 'AXRadioButton', Hyperlink: 'AXLink', MenuItem: 'AXMenuItem',
  Menu: 'AXMenu', Tab: 'AXTabGroup', TabItem: 'AXTab', ListItem: 'AXCell', TreeItem: 'AXOutlineRow',
  Slider: 'AXSlider', ScrollBar: 'AXScrollBar', ToolBar: 'AXToolbar', StaticText: 'AXStaticText',
  Text: 'AXStaticText', Window: 'AXWindow', Group: 'AXGroup',
};

/**
 * get-focused-element.jxa reported the focused control with Windows-style type names ("Edit",
 * "Hyperlink"); consumers (ui-map, the focused-element dump) already read those.
 */
const FOCUSED_TYPE_NAMES: Record<string, string> = {
  AXTextField: 'Edit', AXTextArea: 'Edit', AXButton: 'Button', AXCheckBox: 'CheckBox', AXRadioButton: 'RadioButton',
  AXComboBox: 'ComboBox', AXList: 'List', AXTable: 'Table', AXMenu: 'Menu', AXMenuItem: 'MenuItem',
  AXStaticText: 'Text', AXImage: 'Image', AXLink: 'Hyperlink', AXGroup: 'Group', AXWindow: 'Window',
  AXWebArea: 'Document', AXScrollArea: 'ScrollBar', AXTab: 'Tab', AXSlider: 'Slider',
};

/** 'Button' → 'AXButton'; an AX role passes through; anything else gets the AX prefix. */
export function axRoleFor(controlType: string): string {
  return CONTROL_TYPE_TO_ROLE[controlType] ?? (controlType.startsWith('AX') ? controlType : `AX${controlType}`);
}
/** AppKit stamps generated ids ("_NS:833") on unlabeled elements — not a name worth showing. */
const GENERATED_ID = /^_NS:\d+$/;

/**
 * One AX node (helper or JXA shape) → UiElement.
 *
 * `name` falls back to the AXIdentifier when the control has no title /
 * description: SwiftUI controls (the macOS 26 Calculator) expose nothing else,
 * and an agent that sees `Button ""` ×20 cannot pick one.
 */
export function toUiElement(raw: any, depth?: number, processId?: number): UiElement {
  const automationId: string = raw.automationId ?? raw.identifier ?? '';
  const label: string = raw.name ?? '';
  const secure = raw.secure === true || raw.subrole === 'AXSecureTextField';
  const value = secure || raw.value === undefined || raw.value === null ? undefined : String(raw.value);
  return {
    name: label || (automationId && !GENERATED_ID.test(automationId) ? automationId : ''),
    controlType: String(raw.controlType ?? raw.role ?? '').replace(/^AX/, ''),
    subrole: raw.subrole,
    secure,
    bounds: raw.bounds ?? { ...ZERO_RECT },
    value,
    enabled: raw.enabled,
    focused: raw.focused,
    selected: raw.selected,
    disabled: raw.enabled === false ? true : undefined,
    busy: raw.busy,
    offscreen: raw.offscreen,
    expandable: raw.expandable,
    expanded: raw.expanded,
    automationId: automationId || undefined,
    description: raw.description || undefined,
    processId: raw.processId ?? processId,
    depth,
  };
}

/** Depth-first flatten of a node tree, parents before children. */
export function flattenAxTree(node: any, processId?: number, depth = 0, acc: UiElement[] = []): UiElement[] {
  if (!node) return acc;
  const el = toUiElement(node, depth, processId);
  if (el.controlType || el.name) acc.push(el);
  if (Array.isArray(node.children)) {
    for (const child of node.children) flattenAxTree(child, processId, depth + 1, acc);
  }
  return acc;
}

// ─── Who owns the keyboard (B11) ───────────────────────────────────────────

export interface FrontmostWindow { title: string; subrole?: string; role?: string; modal?: boolean }
export interface FrontmostApp {
  name: string;
  bundleId?: string;
  processId: number;
  activationPolicy: 'regular' | 'accessory' | 'prohibited';
  windows: FrontmostWindow[];
}
/** The frontmost application according to NSWorkspace / LaunchServices — not System Events. */
export interface FrontmostInfo { locked: boolean; app: FrontmostApp | null }

export type KeyboardOwner =
  /** `warning`: something modal of a non-system app is up — keys are sent, and the caller may want to say whose dialog it is. */
  | { kind: 'app'; warning?: string }
  | { kind: 'locked' }
  /** clawdcursor's own overlay (the pause prompt's reply box) has the keyboard: it is the user's, never typed into. */
  | { kind: 'own_ui'; processId: number }
  | { kind: 'alert'; name: string; processId: number; bundleId?: string; title?: string };

/**
 * System Events only ever calls an ordinary app "frontmost". A TCC permission
 * prompt, an auth dialog or the lock screen is an accessory process: it takes
 * the keyboard while System Events still names the app behind it, so a
 * keystroke "to TextEdit" lands on the dialog — a Return can even press Allow.
 */
const ALERT_OWNER_BUNDLES = new Set([
  'com.apple.UserNotificationCenter',               // TCC prompts, "app wants to …"
  'com.apple.SecurityAgent',                        // password / authorisation prompts
  'com.apple.coreservices.uiagent',                 // Gatekeeper / quarantine dialogs
  'com.apple.accessibility.universalAccessAuthWarn', // the Accessibility permission prompt
  'com.apple.LocalAuthentication.UIAgent',          // Touch ID / password sheets
]);
/** Accessory processes that are meant to be typed into, or are ours. */
const KEYBOARD_OK_BUNDLES = new Set([
  'com.apple.Spotlight', 'com.apple.dock', 'com.apple.systemuiserver',
  'com.apple.controlcenter', 'com.apple.notificationcenterui',
]);
/** Our window-less processes. The overlay is not one: it takes the keyboard only for the pause prompt's reply box. */
const KEYBOARD_OK_NAMES = /^ClawdCursor(Host)?$/i;
/** The overlay binary is cached as clawd-overlay-<hash>, so its process name carries the hash. */
const OVERLAY_NAME = /^clawd-overlay(-[0-9a-f]+)?$/i;

export function classifyKeyboardOwner(info: FrontmostInfo): KeyboardOwner {
  if (info.locked) return { kind: 'locked' };
  const a = info.app;
  // A regular app (even one showing its own sheet) is what the caller is driving.
  if (!a || a.activationPolicy === 'regular') return { kind: 'app' };
  if (OVERLAY_NAME.test(a.name)) return { kind: 'own_ui', processId: a.processId };
  if (KEYBOARD_OK_BUNDLES.has(a.bundleId ?? '') || KEYBOARD_OK_NAMES.test(a.name)) return { kind: 'app' };
  const system = a.windows.find(w => w.subrole === 'AXSystemDialog');
  const modal = a.windows.find(w => (w.subrole === 'AXDialog' && w.modal === true) || w.role === 'AXSheet');
  // Refused: what is certainly a system prompt — a known alert owner's bundle, or the AXSystemDialog subrole. A stray
  // Return there can press "Allow".
  if (ALERT_OWNER_BUNDLES.has(a.bundleId ?? '') || system) {
    return {
      kind: 'alert', name: a.name, processId: a.processId, bundleId: a.bundleId,
      title: (system ?? modal ?? a.windows[0])?.title || undefined,
    };
  }
  // Not refused: a MODAL dialog or sheet of some other accessory app. Launcher panels and password-manager popovers
  // (Raycast, Alfred, 1Password Quick Access) are exactly that, and typing into them is the point; refusing every one of
  // them broke those apps. Whose dialog it is gets said, not enforced.
  if (modal) {
    const title = modal.title ? ` — "${modal.title}"` : '';
    return {
      kind: 'app',
      warning: `A modal dialog of "${a.name}"${title} (pid ${a.processId}) is frontmost, so keystrokes go to it. ` +
        'If that is not the app you mean to drive, answer or close it first.',
    };
  }
  return { kind: 'app' };
}

/** Agent-facing explanation for a keyboard that something else owns. */
export function describeKeyboardOwner(owner: KeyboardOwner): string {
  if (owner.kind === 'locked') {
    return 'The screen is locked — the lock screen (loginwindow) owns the keyboard, so keystrokes cannot reach any app. Unlock the Mac, then retry.';
  }
  if (owner.kind === 'own_ui') {
    return `The keyboard is in clawdcursor's pause prompt (pid ${owner.processId}): pid ${owner.processId} is clawdcursor's own on-screen control — ` +
      'it is the user\'s, never typed into. Wait for the user to answer it.';
  }
  if (owner.kind === 'alert') {
    return `A system dialog owns the keyboard: "${owner.name}"${owner.title ? ` — "${owner.title}"` : ''} (pid ${owner.processId}) is frontmost per NSWorkspace, ` +
      'although System Events still names the app behind it. Keystrokes would go to the dialog, not the app you are driving. ' +
      `Answer it first: accessibility find/invoke with processId ${owner.processId} (read its buttons), or ask the user; then retry.`;
  }
  return '';
}

const toFrontmostApp = (raw: any): FrontmostApp => ({
  name: raw.name ?? '',
  bundleId: raw.bundleId ?? undefined,
  processId: raw.processId ?? 0,
  activationPolicy: raw.activationPolicy ?? 'regular',
  windows: Array.isArray(raw.windows) ? raw.windows : [],
});

/** `lsappinfo info` text → the app it describes (the no-helper fallback; no window detail). */
function parseLsappinfoApp(text: string): (FrontmostApp & { inFront: boolean }) | null {
  const name = /^"(.*?)"\s+ASN:/m.exec(text)?.[1];
  const pid = Number(/\bpid\s*=\s*(\d+)/.exec(text)?.[1]);
  if (!name || !Number.isFinite(pid)) return null;
  const bundleId = /bundleID="([^"]+)"/.exec(text)?.[1];
  const type = /\btype="(\w+)"/.exec(text)?.[1];
  const activationPolicy = type === 'Foreground' ? 'regular' : type === 'BackgroundOnly' ? 'prohibited' : 'accessory';
  return { name, bundleId, processId: pid, activationPolicy, windows: [], inFront: /\(in front\)/.test(text) };
}

function parseLsappinfo(text: string): FrontmostInfo {
  const app = parseLsappinfoApp(text);
  if (!app) return { locked: false, app: null };
  return {
    locked: app.bundleId === 'com.apple.loginwindow',
    app: { name: app.name, bundleId: app.bundleId, processId: app.processId, activationPolicy: app.activationPolicy, windows: [] },
  };
}

// ─── Launch confirmation (B2) ───────────────────────────────────────────────

/** A running application as NSWorkspace sees it, with the windows the AX API can read. */
export interface AppState {
  name: string;
  bundleId?: string;
  processId: number;
  finishedLaunching: boolean;
  active: boolean;
  activationPolicy: FrontmostApp['activationPolicy'];
  launchDate?: number;
  windows: WindowInfo[];
  /**
   * Whether `windows` is a real reading. The compiled helper reads them through
   * the AX API; the lsappinfo fallback only knows the process, so an empty list
   * there means "ask the window list", not "no windows".
   */
  windowsKnown: boolean;
}

/** 'open -a' accepts names, "Name.app" and paths; NSWorkspace knows the bare display name. */
function appSearchName(name: string): string {
  const base = name.trim().split('/').filter(Boolean).pop() ?? '';
  return base.replace(/\.app$/i, '');
}

const toAppState = (raw: any): AppState => ({
  name: raw.name ?? '',
  bundleId: raw.bundleId ?? undefined,
  processId: raw.processId ?? 0,
  finishedLaunching: raw.finishedLaunching !== false,
  active: raw.active === true,
  activationPolicy: raw.activationPolicy ?? 'regular',
  launchDate: typeof raw.launchDate === 'number' ? raw.launchDate : undefined,
  windows: Array.isArray(raw.windows) ? raw.windows.map(toWindow) : [],
  windowsKnown: true,
});

/** Best match first: exact name, then prefix, then substring; among equals the newest launch. */
function bestApp(apps: AppState[], want: string): AppState | null {
  const w = want.toLowerCase();
  const rank = (a: AppState) => (a.name.toLowerCase() === w ? 0 : a.name.toLowerCase().startsWith(w) ? 1 : 2);
  return [...apps].sort((a, b) => rank(a) - rank(b) || (b.launchDate ?? 0) - (a.launchDate ?? 0))[0] ?? null;
}

/** LaunchServices' frontmost app, in a few ms and without any permission. Throws a timeout `MacAxError`. */
async function lsappinfoFrontmost(exec: MacAxDeps['exec']): Promise<FrontmostInfo> {
  try {
    const { stdout: front } = await exec('lsappinfo', ['front'], { timeoutMs: LSAPPINFO_TIMEOUT_MS });
    const asn = front.trim().split(/\s+/)[0];
    if (!asn.startsWith('ASN:')) return { locked: false, app: null };
    const { stdout } = await exec('lsappinfo', ['info', asn], { timeoutMs: LSAPPINFO_TIMEOUT_MS });
    return parseLsappinfo(stdout);
  } catch (err) {
    if (isTimeout(err)) throw timeoutError('frontmost app lookup', LSAPPINFO_TIMEOUT_MS);
    return { locked: false, app: null };
  }
}

/** An app the helper's time budget never reached (or cut short): not hung — its windows are just missing from the list. */
export interface SkippedApp { processId: number; processName: string }

export interface WindowListResult {
  windows: WindowInfo[];
  /** Empty when the list is complete. */
  skipped: SkippedApp[];
}

/**
 * The message to give when the screen is locked, or null. The AX helper and the keyboard guard already say it; the tools that
 * read the screen (OCR, smart_click, smart_read) call this before they try anything, because behind the lock screen they read
 * nothing and used to report that as "no_clickable_target" — as if the target were missing. A failed probe, an unlocked screen
 * or another OS is null: never a reason to refuse.
 */
export async function screenLockedMessage(ax?: Pick<MacAx, 'frontmost'>, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform !== 'darwin') return null;
  if (process.env.CLAWD_NO_MAC_AX === '1') return null;      // the kill switch turns the guards off with the helper, as for the keyboard
  try {
    if (!(await (ax ?? defaultMacAx()).frontmost()).locked) return null;
  } catch { return null; }
  return `${helperError({ ok: false, kind: 'locked' }, 'reading the screen').message} ` +
    'For a long hands-off run, keep the display awake while it works (for example `caffeinate -d` in a terminal); no setting needs to change.';
}

/** The window `focusWindow` brought to the front. */
export interface FocusedWindow {
  title: string;
  processId: number;
  processName: string;
}

export interface MacAx {
  /** Every titled window. Throws `MacAxError` on a timeout / locked screen — never returns `[]` for a failure. */
  listWindows(): Promise<WindowInfo[]>;
  /**
   * `listWindows` plus the apps whose windows are missing because the time budget ran out before they were read — a
   * slow Mac, not a hung app. A list that read nothing at all is a timeout error.
   */
  listWindowsDetailed(): Promise<WindowListResult>;
  /**
   * The window that has the keyboard: the frontmost app's focused (else main)
   * window — not "window 1" or the biggest one. Null only when nothing is
   * frontmost; a timeout / locked screen throws.
   */
  activeWindow(): Promise<WindowInfo | null>;
  /**
   * The accessibility tree of a process's key window (the frontmost app when
   * `processId` is omitted), flattened. `truncated` means the walk hit its time
   * or size budget — what is returned is real but incomplete. A timeout or a
   * locked screen throws; an app with no window is a genuine `[]`.
   */
  uiTree(processId?: number): Promise<{ elements: UiElement[]; truncated: boolean }>;
  /**
   * Elements of a process matching a name (title, description or AXIdentifier),
   * a role and/or an exact AXIdentifier, best match first. A timeout throws.
   */
  find(query: ElementQuery): Promise<UiElement[]>;
  /** Act on the best match. A miss is `{success:false, error}`; a timeout / locked screen throws. */
  invoke(query: ElementQuery & { action: InvokeAction; value?: string }): Promise<InvokeResult>;
  /**
   * Type `text` into whatever has the keyboard with Unicode key events, so any character arrives as itself (System Events'
   * `keystroke` types "a" for a character the keyboard layout has no key for, #242). False when the helper is not available;
   * a refusal (locked screen, no permission) or a timeout throws.
   */
  typeUnicode(text: string): Promise<boolean>;
  /**
   * Bring a window of the process `pid` to the front — `title` (a substring, case-insensitive) picks one among THAT process's
   * windows. Null when the helper is not available (the caller falls back). A refusal — no such window, or the focus went to
   * another app, which the error names — throws `MacAxError`. System Events cannot do this when two processes share a name.
   */
  focusWindow(pid: number, title?: string): Promise<FocusedWindow | null>;
  /** The frontmost app per NSWorkspace, plus whether the screen is locked. */
  frontmost(): Promise<FrontmostInfo>;
  /**
   * A running app by (display) name — its pid, launch state and readable windows —
   * straight from NSWorkspace, so a launch can be confirmed without diffing the
   * (slow, fallible) window list. Null = not running. A timeout throws: the
   * state is unknown, which is not the same as "not running".
   */
  appState(name: string): Promise<AppState | null>;
  /**
   * The control with keyboard focus in a process (the frontmost app's when omitted), or null
   * when nothing has focus. Control types use the names get-focused-element.jxa used ("Edit").
   */
  focusedElement(processId?: number): Promise<UiElement | null>;
  /**
   * The frontmost app's document text — a focused editor's value, or the web page holding the focus — read through
   * accessibility with no keystrokes. Null when it can't be read this way (the caller falls back).
   */
  pageText?(): Promise<{ text: string } | null>;
  /** Start building the helper now (background, once), so the first real call already has it. */
  prepare(): void;
}

export interface ElementQuery {
  name?: string;
  controlType?: string;
  /** Exact AXIdentifier (SwiftUI accessibilityIdentifier). */
  automationId?: string;
  processId?: number;
}

export interface InvokeResult {
  success: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  data?: Record<string, unknown>;
  error?: string;
}

function toInvokeResult(r: any): InvokeResult {
  return {
    success: r?.success === true,
    // A refused click reports the element's rect / centre so the caller can fall back to coordinates.
    bounds: r?.bounds ?? (r?.clickPoint ? { x: r.clickPoint.x, y: r.clickPoint.y, width: 1, height: 1 } : undefined),
    // get-value reports its payload at the top level; consumers read res.data?.value. `refused`: the helper declined to
    // act (ambiguous role, secure field) — callers must not route around that with a guess.
    data: r?.refused === true
      ? { ...(r?.data ?? (r?.value !== undefined ? { value: r.value } : {})), refused: true }
      : r?.data ?? (r?.value !== undefined ? { value: r.value } : undefined),
    error: typeof r?.error === 'string' ? r.error : undefined,
  };
}

export function createMacAx(deps: MacAxDeps): MacAx {
  /**
   * After the helper crashed or printed garbage the osascript path answers — for a minute, not for the life of the
   * process: one OOM kill or EAGAIN must not demote a long session to the 10–25 s path.
   */
  let helperRetryAt = 0;
  const helperUsable = (): boolean => process.env.CLAWD_NO_MAC_AX !== '1' && Date.now() >= helperRetryAt;
  const helperFailed = (): void => { helperRetryAt = Date.now() + HELPER_RETRY_MS; };
  /** "…run `xcode-select --install`" when that is why the fast path is missing. */
  const hint = (): string => { const h = deps.helperUnavailableHint?.(); return h ? ` ${h}` : ''; };
  const withHint = (err: MacAxError): MacAxError => { err.message += hint(); return err; };

  /** Join the helper's build, up to BUILD_WAIT_MS. Null: not built (yet) — use the osascript path. */
  async function waitForBuild(): Promise<string | null> {
    const building = deps.ensureHelper();
    if (!building) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(building).catch(() => null),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), BUILD_WAIT_MS); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Run one helper command. Resolves the parsed reply, or null when the helper
   * is unavailable / unusable (caller falls back to JXA). Throws `MacAxError`
   * for failures the helper itself reported and for timeouts (a JXA retry
   * would only be slower).
   */
  async function viaHelper(args: string[], timeoutMs: number, what: string, opts: { waitForBuild?: boolean; input?: string; act?: boolean } = {}): Promise<any | null> {
    if (!helperUsable()) return null;
    let bin = deps.helper();
    if (!bin) {
      if (opts.waitForBuild === false) {
        // A millisecond fallback exists (lsappinfo): start the build for next time, don't wait for it.
        Promise.resolve(deps.ensureHelper()).catch(() => { /* stays on the fallback */ });
        return null;
      }
      bin = await waitForBuild();
    }
    if (!bin) return null;
    let stdout: string;
    try {
      ({ stdout } = await deps.exec(bin, args, opts.input === undefined ? { timeoutMs } : { timeoutMs, input: opts.input }));
    } catch (err) {
      if (isTimeout(err)) throw timeoutError(what, timeoutMs, opts.act);
      helperFailed();
      return null;
    }
    let reply: any;
    try {
      reply = JSON.parse(stdout);
    } catch {
      helperFailed();
      return null;
    }
    if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') {
      helperFailed();
      return null;
    }
    if (!reply.ok) throw helperError(reply, what, opts.act);
    return reply;
  }

  /** Run one of the original JXA scripts and parse its JSON. */
  async function viaJxa(
    script: string, args: string[], timeoutMs: number, what: string,
    opts: { errorJsonIsData?: boolean } = {},
  ): Promise<any> {
    if (deps.screenLocked) {
      try {
        if (await deps.screenLocked()) throw helperError({ ok: false, kind: 'locked' }, what);
      } catch (err) {
        if (err instanceof MacAxError && err.kind === 'locked') throw err;
        // couldn't tell: read anyway
      }
    }
    let stdout: string;
    try {
      // The '--' keeps osascript from reading the script's own -Flags as its options.
      ({ stdout } = await deps.exec('osascript', ['-l', 'JavaScript', path.join(deps.scriptsDir, script), ...(args.length ? ['--', ...args] : [])], { timeoutMs }));
    } catch (err) {
      if (isTimeout(err)) throw withHint(timeoutError(what, timeoutMs));
      throw withHint(new MacAxError('failed', `${what} failed: ${msg(err)}`));
    }
    let out: any;
    try {
      out = JSON.parse(stdout);
    } catch {
      throw withHint(new MacAxError('failed', `${what} failed: unreadable output from ${script}`));
    }
    if (!opts.errorJsonIsData && out && typeof out === 'object' && !Array.isArray(out) && out.error) {
      throw withHint(new MacAxError('failed', `${what} failed: ${out.error}`));
    }
    return out;
  }

  async function activeWindow(): Promise<WindowInfo | null> {
    const what = 'active window lookup';
    const reply = await viaHelper(
      ['active', '--timeout-ms', String(HELPER_LIST_DEADLINE_MS)],
      HELPER_LIST_DEADLINE_MS + HELPER_GRACE_MS,
      what,
    );
    if (reply) return reply.active ? toWindow(reply.active) : null;
    const raw = await viaJxa('get-foreground-window.jxa', [], JXA_LIST_TIMEOUT_MS, what, { errorJsonIsData: true });
    if (raw?.success === false) {
      if (/no foreground window/i.test(String(raw.error ?? ''))) return null;
      throw new MacAxError('failed', `${what} failed: ${raw.error ?? 'unknown error'}`);
    }
    return raw ? toWindow(raw) : null;
  }

  async function listWindowsDetailed(): Promise<WindowListResult> {
    const reply = await viaHelper(
      ['windows', '--timeout-ms', String(HELPER_LIST_DEADLINE_MS)],
      HELPER_LIST_DEADLINE_MS + HELPER_GRACE_MS,
      'window list',
    );
    if (reply) {
      // clawdcursor's own overlay is never a candidate (pointer-guard.ts); the helper skips it by name, this by pid.
      const windows: WindowInfo[] = (reply.windows ?? []).map(toWindow).filter((w: WindowInfo) => !isOwnUiPid(w.processId));
      // An app that answered nothing for a whole AX timeout IS hung, and the list says so…
      for (const u of reply.unresponsive ?? []) {
        windows.push(toWindow({ title: '(not responding)', processName: u.processName, processId: u.processId }));
      }
      // …but an app the time budget never reached is not: it gets no window of its own, only a place in `skipped`.
      const skipped: SkippedApp[] = (reply.skipped ?? []).map((a: any) => ({ processId: a.processId ?? 0, processName: a.processName ?? 'unknown' }));
      if (windows.length === 0 && skipped.length > 0) {
        throw new MacAxError('timeout',
          `window list ran out of its ${Math.round(HELPER_LIST_DEADLINE_MS / 1000)}s time budget before reading any app (the Mac is busy). ${NOT_EMPTY}`);
      }
      return { windows, skipped };
    }
    const raw = await viaJxa('get-windows.jxa', [], JXA_LIST_TIMEOUT_MS, 'window list');
    if (!Array.isArray(raw)) throw new MacAxError('failed', 'window list failed: unexpected output from get-windows.jxa');
    return { windows: raw.map(toWindow).filter((w: WindowInfo) => !isOwnUiPid(w.processId)), skipped: [] };
  }

  return {
    activeWindow,
    listWindowsDetailed,

    prepare(): void {
      if (!helperUsable()) return;
      if (!deps.helper()) Promise.resolve(deps.ensureHelper()).catch(() => { /* stays on osascript */ });
    },

    async listWindows(): Promise<WindowInfo[]> {
      return (await listWindowsDetailed()).windows;
    },

    async uiTree(processId?: number): Promise<{ elements: UiElement[]; truncated: boolean }> {
      const what = `accessibility tree read${processId ? ` (pid ${processId})` : ''}`;
      const reply = await viaHelper(
        ['tree', ...(processId ? ['--pid', String(processId)] : []),
          '--max-depth', String(TREE_MAX_DEPTH), '--max-nodes', String(TREE_MAX_NODES),
          '--timeout-ms', String(HELPER_TREE_DEADLINE_MS)],
        HELPER_TREE_DEADLINE_MS + HELPER_GRACE_MS,
        what,
      );
      if (reply) {
        return { elements: flattenAxTree(reply.tree, reply.processId ?? processId), truncated: reply.truncated === true };
      }
      // The script needs an explicit pid; resolve the frontmost app's like the adapter always did.
      const pid = processId ?? (await activeWindow())?.processId;
      if (!pid) return { elements: [], truncated: false };
      const out = await viaJxa(
        'get-screen-context.jxa',
        ['-FocusedProcessId', String(pid), '-MaxDepth', String(JXA_TREE_DEPTH)],
        JXA_TREE_TIMEOUT_MS,
        what,
      );
      return { elements: flattenAxTree(out?.uiTree, pid), truncated: false };
    },

    async frontmost(): Promise<FrontmostInfo> {
      const what = 'frontmost app lookup';
      const reply = await viaHelper(['frontmost', '--timeout-ms', String(HELPER_LIST_DEADLINE_MS)], HELPER_LIST_DEADLINE_MS + HELPER_GRACE_MS, what, { waitForBuild: false });
      if (reply) return { locked: reply.locked === true, app: reply.frontmost ? toFrontmostApp(reply.frontmost) : null };
      // No helper: LaunchServices answers in a few ms without any permission.
      return lsappinfoFrontmost(deps.exec);
    },

    async focusWindow(pid: number, title?: string): Promise<FocusedWindow | null> {
      const s = viaStdin({ title });
      const reply = await viaHelper(['focus', '--pid', String(pid), '--timeout-ms', String(HELPER_FOCUS_DEADLINE_MS), ...s.args],
        HELPER_FOCUS_DEADLINE_MS + HELPER_GRACE_MS, 'focusing', { input: s.input, act: true });
      if (reply === null) return null;
      return { title: String(reply.title ?? ''), processId: Number(reply.processId ?? pid), processName: String(reply.processName ?? '') };
    },

    async appState(name: string): Promise<AppState | null> {
      const what = 'app state lookup';
      const want = appSearchName(name);
      if (!want) return null;       // an empty name would match every app and return the newest
      const reply = await viaHelper(
        ['apps', '--name', want, '--timeout-ms', String(HELPER_LIST_DEADLINE_MS)],
        HELPER_LIST_DEADLINE_MS + HELPER_GRACE_MS,
        what,
        { waitForBuild: false },
      );
      if (reply) return bestApp((reply.apps ?? []).map(toAppState).filter((a: AppState) => !isOwnUiPid(a.processId)), want);
      try {
        const { stdout: found } = await deps.exec('lsappinfo', ['find', `name=${want}`], { timeoutMs: LSAPPINFO_TIMEOUT_MS });
        const asn = found.trim().split('\n')[0]?.trim();
        if (!asn || !asn.startsWith('ASN:')) return null;
        const { stdout } = await deps.exec('lsappinfo', ['info', asn], { timeoutMs: LSAPPINFO_TIMEOUT_MS });
        const app = parseLsappinfoApp(stdout);
        if (!app || isOwnUiPid(app.processId)) return null;
        return {
          name: app.name, bundleId: app.bundleId, processId: app.processId, activationPolicy: app.activationPolicy,
          finishedLaunching: true, active: app.inFront, windows: [], windowsKnown: false,
        };
      } catch (err) {
        if (isTimeout(err)) throw timeoutError(what, LSAPPINFO_TIMEOUT_MS);
        return null;
      }
    },

    async pageText(): Promise<{ text: string } | null> {
      try {
        const reply = await viaHelper(
          ['pagetext', '--timeout-ms', String(HELPER_FIND_DEADLINE_MS)],
          HELPER_FIND_DEADLINE_MS + HELPER_GRACE_MS,
          'page text',
          { waitForBuild: false },
        );
        return reply && typeof reply.text === 'string' && reply.text.trim() ? { text: reply.text } : null;
      } catch {
        return null; // not readable this way: the caller falls back
      }
    },

    async focusedElement(processId?: number): Promise<UiElement | null> {
      const what = 'focused element lookup';
      const reply = await viaHelper(
        ['focused', ...(processId ? ['--pid', String(processId)] : []), '--timeout-ms', String(HELPER_LIST_DEADLINE_MS)],
        HELPER_LIST_DEADLINE_MS + HELPER_GRACE_MS,
        what,
      );
      if (reply) {
        const raw = reply.focused;
        if (!raw) return null;
        const el = toUiElement(raw, undefined, raw.processId ?? processId);
        el.controlType = FOCUSED_TYPE_NAMES[raw.controlType] ?? el.controlType;
        return el;
      }
      const out = await viaJxa('get-focused-element.jxa', [], JXA_LIST_TIMEOUT_MS, what);
      return out ? toUiElement({ ...out, enabled: out.isEnabled }, undefined, out.processId) : null;
    },

    async find(q: ElementQuery): Promise<UiElement[]> {
      const what = 'element search';
      const text = viaStdin({ name: given(q.name), id: given(q.automationId) });
      const reply = await viaHelper(
        ['find', ...(q.processId ? ['--pid', String(q.processId)] : []),
          ...(q.controlType ? ['--role', axRoleFor(q.controlType)] : []),
          '--max-results', String(FIND_MAX_RESULTS), '--timeout-ms', String(HELPER_FIND_DEADLINE_MS), ...text.args],
        HELPER_FIND_DEADLINE_MS + HELPER_GRACE_MS,
        what,
        { input: text.input },
      );
      if (reply) return (reply.elements ?? []).map((el: any) => toUiElement(el, undefined, q.processId));
      // find-element.jxa cannot search by identifier: an unfiltered walk would come back as "no elements found".
      if (q.automationId && !q.name && !q.controlType) {
        throw new MacAxError('unavailable',
          `${what} by AXIdentifier needs the accessibility helper, which is not available${hint() || ' yet (building in the background, or swiftc is unavailable)'}`);
      }
      const out = await viaJxa(
        'find-element.jxa',
        [...(q.processId !== undefined ? ['-ProcessId', String(q.processId)] : []),
          ...(q.name ? ['-Name', q.name] : []),
          ...(q.controlType ? ['-ControlType', q.controlType] : []),
          // find-element.jxa has no AutomationId concept yet and ignores it; passed so a script that learns it just works.
          ...(q.automationId ? ['-AutomationId', q.automationId] : [])],
        JXA_FIND_TIMEOUT_MS,
        what,
      );
      return Array.isArray(out) ? out.map((el: any) => toUiElement(el, undefined, q.processId)) : [];
    },

    async invoke(q: ElementQuery & { action: InvokeAction; value?: string }): Promise<InvokeResult> {
      const what = 'accessibility invoke';
      const name = given(q.name);
      const automationId = given(q.automationId);
      // With nothing to aim at, a search matches every element and "best" is arbitrary —
      // invoke-element.jxa used to press whichever button came first.
      if (!name && !q.controlType && !automationId) {
        return { success: false, error: 'invoke needs a name, controlType or automationId to aim at — refusing to act on an arbitrary element', data: { refused: true } };
      }
      // A role IS something to aim at, but not enough to press: there is rarely only one Button in a window, and both engines
      // would press whichever ranks first. (set-value / focus / get-value by role alone are left to the helper, which acts only
      // when exactly one element has the role.)
      if (PRESSING_ACTIONS.has(q.action) && !name && !automationId) {
        return {
          success: false,
          error: `${q.action} needs a name or automationId to aim at — controlType "${q.controlType}" alone would act on whichever ${q.controlType} comes first`,
          data: { refused: true },
        };
      }
      const text = viaStdin({ name, id: automationId, value: q.value });
      const reply = await viaHelper(
        ['invoke', ...(q.processId ? ['--pid', String(q.processId)] : []),
          '--action', q.action,
          ...(q.controlType ? ['--role', axRoleFor(q.controlType)] : []),
          '--timeout-ms', String(HELPER_FIND_DEADLINE_MS), ...text.args],
        HELPER_FIND_DEADLINE_MS + HELPER_GRACE_MS,
        what,
        { input: text.input, act: true },
      );
      if (reply) return toInvokeResult(reply);
      // No helper. invoke-element.jxa matches by name only: it has no AXIdentifier, and it cannot tell that a role is unique —
      // run without a name it writes into (or reads, or focuses) the FIRST element of that role.
      if (!name) {
        return {
          success: false,
          data: { refused: true },
          error: automationId
            ? `matching by AXIdentifier needs the accessibility helper, which is not available${hint() || ' yet (building in the background, or swiftc is unavailable)'} — aim by name instead`
            : `aiming by controlType alone needs the accessibility helper (it checks that exactly one element has the role), which is not available${hint() || ' yet (building in the background, or swiftc is unavailable)'} — aim by name instead`,
        };
      }
      const out = await viaJxa(
        'invoke-element.jxa',
        [...(q.processId !== undefined ? ['-ProcessId', String(q.processId)] : []),
          '-Name', name,
          ...(q.controlType ? ['-ControlType', q.controlType] : []),
          '-Action', q.action,
          ...(q.value !== undefined ? ['-Value', q.value] : [])],
        JXA_INVOKE_TIMEOUT_MS,
        what,
        { errorJsonIsData: true },
      );
      return toInvokeResult(out);
    },

    async typeUnicode(text: string): Promise<boolean> {
      const s = viaStdin({ text });
      // ~4 ms per character in the helper, plus the time to start it.
      const budget = HELPER_TYPE_BASE_MS + [...text].length * HELPER_TYPE_PER_CHAR_MS;
      const reply = await viaHelper(['type', '--timeout-ms', String(budget), ...s.args], budget + HELPER_GRACE_MS, 'typing', { input: s.input, act: true });
      return reply !== null;
    },
  };
}


// ─── Status (doctor) ────────────────────────────────────────────────────────

export type HelperState = 'ready' | 'buildable' | 'no-devtools' | 'disabled';

export const NO_DEVTOOLS_HINT =
  'The fast accessibility helper needs the Xcode Command Line Tools to build — install them with `xcode-select --install`; until then the slower osascript path is used.';

/** Where the fast accessibility helper stands, for `clawdcursor doctor`. */
export async function helperStatusFrom(d: {
  disabled: boolean;
  cached: boolean;
  devToolsInstalled: () => Promise<boolean>;
}): Promise<{ state: HelperState; detail: string }> {
  if (d.disabled) return { state: 'disabled', detail: 'switched off with CLAWD_NO_MAC_AX=1 — using the osascript paths' };
  if (d.cached) return { state: 'ready', detail: 'built — windows, trees and element searches take tens of milliseconds' };
  if (await d.devToolsInstalled()) return { state: 'buildable', detail: 'not built yet — it builds on first use (about 3 seconds)' };
  return { state: 'no-devtools', detail: `Xcode Command Line Tools are missing, so the slower osascript path is used — run \`xcode-select --install\` for the fast helper` };
}

// ─── Default wiring ─────────────────────────────────────────────────────────

/** A big window's tree is megabytes of JSON; node's 1 MB default would read that as a crash. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export async function defaultExec(file: string, args: string[], opts: { timeoutMs: number; input?: string }): Promise<{ stdout: string }> {
  const run = execFileAsync(file, args, { timeout: opts.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES });
  if (opts.input !== undefined) {
    const stdin = run.child.stdin;
    // The process may exit (or be killed at the timeout) before it has read everything: a closed pipe is not our error.
    stdin?.on('error', () => { /* EPIPE */ });
    stdin?.end(opts.input);
  }
  const { stdout } = await run;
  return { stdout: String(stdout) };
}

const SCRIPTS_DIR = path.join(getPackageRoot(), 'scripts', 'mac');
const AX_HELPER_SCRIPT = path.join(SCRIPTS_DIR, 'ax-helper.swift');

/**
 * Build the helper only where swiftc exists. Running `swiftc` on a Mac without the Command Line
 * Tools pops macOS's "install developer tools" dialog at an agent that never asked for it;
 * `xcode-select -p` answers the same question silently.
 */
export function makeHelperBuilder(d: {
  devToolsInstalled: () => Promise<boolean>;
  compile: () => Promise<string | null>;
}): () => Promise<string | null> {
  return async () => ((await d.devToolsInstalled()) ? await d.compile().catch(() => null) : null);
}

let devTools: Promise<boolean> | null = null;
let devToolsKnown: boolean | null = null;
const devToolsInstalled = (): Promise<boolean> =>
  (devTools ??= execFileAsync('xcode-select', ['-p'], { timeout: 5_000 }).then(() => true, () => false).then(ok => { devToolsKnown = ok; return ok; }));

/** For `clawdcursor doctor`. */
export function macAxStatus(): Promise<{ state: HelperState; detail: string }> {
  return helperStatusFrom({
    disabled: process.env.CLAWD_NO_MAC_AX === '1',
    cached: macAxBinary.cached(AX_HELPER_SCRIPT) !== null,
    devToolsInstalled,
  });
}

let shared: MacAx | null = null;

/** The process-wide client: compiled helper from ~/.clawdcursor/bin, JXA until it is built. */
export function defaultMacAx(): MacAx {
  return (shared ??= createMacAx({
    exec: defaultExec,
    helper: () => macAxBinary.cached(AX_HELPER_SCRIPT),
    // compile() is one-shot, shares one build between callers and remembers a failure, so asking on every use is cheap.
    ensureHelper: makeHelperBuilder({ devToolsInstalled, compile: () => macAxBinary.compile(AX_HELPER_SCRIPT) }),
    scriptsDir: SCRIPTS_DIR,
    screenLocked: async () => (await lsappinfoFrontmost(defaultExec)).locked,
    helperUnavailableHint: () => (devToolsKnown === false ? NO_DEVTOOLS_HINT : null),
  }));
}
