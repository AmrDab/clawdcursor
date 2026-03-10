import * as os from 'os';

export type ShortcutCategory =
  | 'navigation'
  | 'browser'
  | 'editing'
  | 'social'
  | 'window'
  | 'file'
  | 'view'
  | 'quick';

export interface ShortcutDefinition {
  id: string;
  category: ShortcutCategory;
  description: string;
  canonicalIntent: string;
  intents: string[];
  contextHints?: string[];
  keys: {
    default: string;
    darwin?: string;
    linux?: string;
    win32?: string;
  };
}

export interface ShortcutMatch {
  shortcut: ShortcutDefinition;
  combo: string;
  canonicalIntent: string;
  matchedIntent: string;
  matchType: 'exact' | 'fuzzy';
}

export interface ShortcutLookupOptions {
  contextHint?: string;
  enableFuzzy?: boolean;
  maxDistance?: number;
}

const MOD = 'Control';
const CMD = 'Super';

export const SHORTCUTS: ShortcutDefinition[] = [
  // Navigation
  shortcut('scroll-down', 'navigation', 'Scroll down one page', 'scroll down', ['scroll down', 'page down', 'move down a page'], { default: 'PageDown' }),
  shortcut('scroll-up', 'navigation', 'Scroll up one page', 'scroll up', ['scroll up', 'page up', 'move up a page'], { default: 'PageUp' }),
  shortcut('go-top', 'navigation', 'Go to top of page', 'go to top', ['go to top', 'jump to top', 'top of page'], { default: `${MOD}+Home`, darwin: `${CMD}+Up` }),
  shortcut('go-bottom', 'navigation', 'Go to bottom of page', 'go to bottom', ['go to bottom', 'jump to bottom', 'bottom of page'], { default: `${MOD}+End`, darwin: `${CMD}+Down` }),
  shortcut('home', 'navigation', 'Go to line/page start', 'home', ['home', 'go home'], { default: 'Home' }),
  shortcut('end', 'navigation', 'Go to line/page end', 'end', ['end', 'go end'], { default: 'End' }),

  // Browser
  shortcut('new-tab', 'browser', 'Open new browser tab', 'new tab', ['new tab', 'open new tab'], { default: `${MOD}+t`, darwin: `${CMD}+t` }),
  shortcut('close-tab', 'browser', 'Close current browser tab', 'close tab', ['close tab', 'close this tab'], { default: `${MOD}+w`, darwin: `${CMD}+w` }),
  shortcut('reopen-tab', 'browser', 'Reopen last closed tab', 'reopen tab', ['reopen tab', 'undo close tab', 'restore tab'], { default: `${MOD}+Shift+t`, darwin: `${CMD}+Shift+t` }),
  shortcut('refresh', 'browser', 'Refresh current page', 'refresh', ['refresh', 'reload page', 'reload'], { default: 'F5', darwin: `${CMD}+r` }),
  shortcut('hard-refresh', 'browser', 'Hard refresh current page', 'hard refresh', ['hard refresh', 'force refresh'], { default: `${MOD}+F5`, darwin: `${CMD}+Shift+r` }),
  shortcut('go-back', 'browser', 'Go back in history', 'go back', ['go back', 'back'], { default: 'Alt+Left', darwin: `${CMD}+[` }),
  shortcut('go-forward', 'browser', 'Go forward in history', 'go forward', ['go forward', 'forward'], { default: 'Alt+Right', darwin: `${CMD}+]` }),
  shortcut('address-bar', 'browser', 'Focus address bar', 'focus address bar', ['focus address bar', 'url bar', 'go to address bar'], { default: `${MOD}+l`, darwin: `${CMD}+l` }),
  shortcut('dev-tools', 'browser', 'Toggle developer tools', 'open dev tools', ['dev tools', 'open dev tools', 'toggle developer tools'], { default: `${MOD}+Shift+i`, darwin: `${CMD}+Option+i` }),

  // Editing
  shortcut('copy', 'editing', 'Copy selection', 'copy', ['copy', 'copy this'], { default: `${MOD}+c`, darwin: `${CMD}+c` }),
  shortcut('paste', 'editing', 'Paste clipboard', 'paste', ['paste', 'paste here'], { default: `${MOD}+v`, darwin: `${CMD}+v` }),
  shortcut('cut', 'editing', 'Cut selection', 'cut', ['cut'], { default: `${MOD}+x`, darwin: `${CMD}+x` }),
  shortcut('undo', 'editing', 'Undo previous action', 'undo', ['undo'], { default: `${MOD}+z`, darwin: `${CMD}+z` }),
  shortcut('redo', 'editing', 'Redo previous action', 'redo', ['redo'], { default: `${MOD}+y`, darwin: `${CMD}+Shift+z` }),
  shortcut('select-all', 'editing', 'Select all content', 'select all', ['select all'], { default: `${MOD}+a`, darwin: `${CMD}+a` }),
  shortcut('find', 'editing', 'Find in current context', 'find', ['search in page', 'find in page', 'find on page', 'find text'], { default: `${MOD}+f`, darwin: `${CMD}+f` }),
  shortcut('replace', 'editing', 'Find and replace', 'replace', ['replace', 'find and replace'], { default: `${MOD}+h`, darwin: `${CMD}+Option+f` }),

  // Social media (context-aware: these are risky one-key shortcuts)
  shortcut('reddit-upvote', 'social', 'Upvote current post/comment', 'upvote', ['upvote', 'reddit upvote'], { default: 'a' }, ['reddit']),
  shortcut('reddit-downvote', 'social', 'Downvote current post/comment', 'downvote', ['downvote', 'reddit downvote'], { default: 'z' }, ['reddit']),
  shortcut('reddit-next', 'social', 'Move to next post', 'next post', ['next post', 'next item', 'reddit next'], { default: 'j' }, ['reddit']),
  shortcut('reddit-prev', 'social', 'Move to previous post', 'previous post', ['previous post', 'previous item', 'reddit previous'], { default: 'k' }, ['reddit']),
  shortcut('reddit-comments', 'social', 'Open comments', 'open comments', ['open comments', 'view comments'], { default: 'c' }, ['reddit']),
  shortcut('reddit-save', 'social', 'Save current post', 'save post', ['save post'], { default: 's' }, ['reddit']),
  shortcut('x-like', 'social', 'Like tweet', 'like tweet', ['like tweet', 'like post'], { default: 'l' }, ['twitter', 'x.com', 'tweet']),
  shortcut('x-retweet', 'social', 'Retweet tweet', 'retweet', ['retweet', 'repost'], { default: 't' }, ['twitter', 'x.com', 'tweet']),

  // Window management
  shortcut('switch-app', 'window', 'Switch to next application', 'switch app', ['switch app', 'next app', 'alt tab'], { default: 'Alt+Tab', darwin: `${CMD}+Tab` }),
  shortcut('switch-app-reverse', 'window', 'Switch to previous application', 'switch previous app', ['previous app', 'reverse app switch'], { default: 'Alt+Shift+Tab', darwin: `${CMD}+Shift+Tab` }),
  shortcut('close-window', 'window', 'Close current window', 'close window', ['close window'], { default: 'Alt+F4', darwin: `${CMD}+q` }),
  shortcut('minimize-window', 'window', 'Minimize current window', 'minimize window', ['minimize window'], { default: 'Super+Down', darwin: `${CMD}+m` }),
  shortcut('maximize-window', 'window', 'Maximize current window', 'maximize window', ['maximize window'], { default: 'Super+Up', darwin: 'Control+Super+f' }),
  shortcut('show-desktop', 'window', 'Show desktop', 'show desktop', ['show desktop', 'go to desktop', 'minimize all'], { default: 'Super+d', darwin: 'Fn+F11' }),

  // File operations
  shortcut('save', 'file', 'Save current file', 'save', ['save', 'save file'], { default: `${MOD}+s`, darwin: `${CMD}+s` }),
  shortcut('save-as', 'file', 'Save current file as', 'save as', ['save as'], { default: `${MOD}+Shift+s`, darwin: `${CMD}+Shift+s` }),
  shortcut('open-file', 'file', 'Open file', 'open file', ['open file'], { default: `${MOD}+o`, darwin: `${CMD}+o` }),
  shortcut('new-file', 'file', 'Create new file', 'new file', ['new file'], { default: `${MOD}+n`, darwin: `${CMD}+n` }),
  shortcut('print', 'file', 'Print current document', 'print', ['print', 'print page'], { default: `${MOD}+p`, darwin: `${CMD}+p` }),

  // View
  shortcut('zoom-in', 'view', 'Zoom in', 'zoom in', ['zoom in', 'increase zoom'], { default: `${MOD}+=`, darwin: `${CMD}+=` }),
  shortcut('zoom-out', 'view', 'Zoom out', 'zoom out', ['zoom out', 'decrease zoom'], { default: `${MOD}+-`, darwin: `${CMD}+-` }),
  shortcut('zoom-reset', 'view', 'Reset zoom', 'reset zoom', ['reset zoom', 'normal zoom'], { default: `${MOD}+0`, darwin: `${CMD}+0` }),
  shortcut('fullscreen', 'view', 'Toggle fullscreen', 'fullscreen', ['fullscreen', 'toggle fullscreen'], { default: 'F11', darwin: `${CMD}+Control+f` }),

  // Quick actions
  shortcut('escape', 'quick', 'Cancel or close current dialog', 'press escape', ['escape', 'press escape', 'esc'], { default: 'Escape' }),
  shortcut('enter', 'quick', 'Confirm current action', 'press enter', ['enter', 'press enter', 'return'], { default: 'Return' }),
  shortcut('tab', 'quick', 'Move to next field', 'press tab', ['tab', 'press tab'], { default: 'Tab' }),
  shortcut('space', 'quick', 'Toggle focused control', 'press space', ['space', 'press space', 'spacebar'], { default: 'Space' }),
  shortcut('delete', 'quick', 'Delete selection', 'press delete', ['delete', 'press delete'], { default: 'Delete' }),
  shortcut('system-search', 'quick', 'Open system search', 'system search', ['system search', 'open search', 'search apps'], { default: 'Super+s', darwin: `${CMD}+Space` }),
  shortcut('lock-screen', 'quick', 'Lock current session', 'lock screen', ['lock screen'], { default: 'Super+l', darwin: 'Control+Super+q' }),

  // ─── Outlook shortcuts ──────────────────────────────────────────
  // New Outlook (olk) — same as Outlook on the web with some desktop overrides
  shortcut('outlook-new-message', 'editing', 'Create new email message', 'new email',
    ['new email', 'new message', 'compose email', 'compose message', 'write email', 'create email', 'new mail'],
    { default: `${MOD}+n`, darwin: `${CMD}+n` }, ['outlook', 'olk']),
  shortcut('outlook-send', 'editing', 'Send email message', 'send email',
    ['send email', 'send message', 'send mail', 'send this email', 'send it'],
    { default: `${MOD}+Return`, darwin: `${CMD}+Return` }, ['outlook', 'olk']),
  shortcut('outlook-reply', 'editing', 'Reply to email', 'reply',
    ['reply', 'reply to email', 'reply to message', 'reply to this'],
    { default: `${MOD}+r`, darwin: `${CMD}+r` }, ['outlook', 'olk']),
  shortcut('outlook-reply-all', 'editing', 'Reply all to email', 'reply all',
    ['reply all', 'reply to all', 'respond to all'],
    { default: `${MOD}+Shift+r`, darwin: `${CMD}+Shift+r` }, ['outlook', 'olk']),
  shortcut('outlook-forward', 'editing', 'Forward email', 'forward email',
    ['forward', 'forward email', 'forward message', 'forward this'],
    { default: `${MOD}+f`, darwin: `${CMD}+f` }, ['outlook', 'olk']),
  shortcut('outlook-mark-read', 'editing', 'Mark email as read', 'mark as read',
    ['mark as read', 'mark read'],
    { default: `${MOD}+q`, darwin: `${CMD}+q` }, ['outlook', 'olk']),
  shortcut('outlook-mark-unread', 'editing', 'Mark email as unread', 'mark as unread',
    ['mark as unread', 'mark unread'],
    { default: `${MOD}+u`, darwin: `${CMD}+u` }, ['outlook', 'olk']),
  shortcut('outlook-flag', 'editing', 'Flag email for follow up', 'flag email',
    ['flag', 'flag email', 'flag message', 'flag for follow up'],
    { default: 'Insert' }, ['outlook', 'olk']),
  shortcut('outlook-delete', 'editing', 'Delete email', 'delete email',
    ['delete email', 'delete message', 'delete this email'],
    { default: 'Delete' }, ['outlook', 'olk']),
  shortcut('outlook-search', 'editing', 'Search in Outlook', 'search outlook',
    ['search', 'search email', 'search emails', 'search outlook', 'find email'],
    { default: `${MOD}+e`, darwin: `${CMD}+e` }, ['outlook', 'olk']),
  shortcut('outlook-go-calendar', 'navigation', 'Go to Outlook Calendar', 'go to calendar',
    ['go to calendar', 'open calendar', 'switch to calendar', 'calendar'],
    { default: `${MOD}+2`, darwin: `${CMD}+2` }, ['outlook', 'olk']),
  shortcut('outlook-go-mail', 'navigation', 'Go to Outlook Mail', 'go to mail',
    ['go to mail', 'go to inbox', 'switch to mail', 'open mail', 'inbox'],
    { default: `${MOD}+1`, darwin: `${CMD}+1` }, ['outlook', 'olk']),
  shortcut('outlook-go-people', 'navigation', 'Go to Outlook People/Contacts', 'go to contacts',
    ['go to contacts', 'go to people', 'open contacts', 'address book'],
    { default: `${MOD}+4`, darwin: `${CMD}+4` }, ['outlook', 'olk']),
  shortcut('outlook-new-appointment', 'editing', 'Create new calendar appointment', 'new appointment',
    ['new appointment', 'new event', 'create appointment', 'create event', 'new calendar event'],
    { default: `${MOD}+n`, darwin: `${CMD}+n` }, ['outlook', 'calendar']),
  shortcut('outlook-open-message', 'editing', 'Open email in new window', 'open message',
    ['open message', 'open email', 'open in new window'],
    { default: 'Shift+Return' }, ['outlook', 'olk']),

  // Classic Outlook (OUTLOOK / WINWORD process) — different shortcuts
  shortcut('outlook-classic-new-message', 'editing', 'Create new email (classic)', 'new email classic',
    ['new email', 'new message', 'compose email', 'new mail'],
    { default: `${MOD}+Shift+m` }, ['winword', 'outlook classic']),
  shortcut('outlook-classic-send', 'editing', 'Send email (classic)', 'send email classic',
    ['send email', 'send message', 'send mail'],
    { default: 'Alt+s' }, ['winword', 'outlook classic']),
  shortcut('outlook-classic-go-inbox', 'navigation', 'Go to Inbox (classic)', 'go to inbox classic',
    ['go to inbox', 'switch to inbox'],
    { default: `${MOD}+Shift+i` }, ['winword', 'outlook classic']),
  shortcut('outlook-classic-go-outbox', 'navigation', 'Go to Outbox (classic)', 'go to outbox classic',
    ['go to outbox', 'switch to outbox'],
    { default: `${MOD}+Shift+o` }, ['winword', 'outlook classic']),
  shortcut('outlook-classic-check-mail', 'editing', 'Check for new messages (classic)', 'check mail classic',
    ['check mail', 'check messages', 'check for new messages', 'get mail'],
    { default: `${MOD}+m` }, ['winword', 'outlook classic']),
  shortcut('outlook-classic-address-book', 'editing', 'Open Address Book (classic)', 'open address book classic',
    ['address book', 'open address book'],
    { default: `${MOD}+Shift+b` }, ['winword', 'outlook classic']),
  shortcut('outlook-classic-new-task', 'editing', 'Create new task (classic)', 'new task classic',
    ['new task', 'create task'],
    { default: `${MOD}+Shift+k` }, ['winword', 'outlook classic']),
  shortcut('outlook-classic-new-appointment', 'editing', 'Create new appointment (classic)', 'new appointment classic',
    ['new appointment', 'create appointment', 'new event'],
    { default: `${MOD}+Shift+a` }, ['winword', 'outlook classic']),
  shortcut('outlook-classic-new-contact', 'editing', 'Create new contact (classic)', 'new contact classic',
    ['new contact', 'create contact'],
    { default: `${MOD}+Shift+c` }, ['winword', 'outlook classic']),
  shortcut('outlook-classic-new-meeting', 'editing', 'Create new meeting (classic)', 'new meeting classic',
    ['new meeting', 'create meeting', 'schedule meeting'],
    { default: `${MOD}+Shift+q` }, ['winword', 'outlook classic']),
];

function shortcut(
  id: string,
  category: ShortcutCategory,
  description: string,
  canonicalIntent: string,
  intents: string[],
  keys: ShortcutDefinition['keys'],
  contextHints?: string[],
): ShortcutDefinition {
  return { id, category, description, canonicalIntent, intents, keys, contextHints };
}

function normalizeIntent(input: string): string {
  return input.toLowerCase().replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();
}

function compactIntent(input: string): string {
  return normalizeIntent(input).replace(/[^a-z0-9]/g, '');
}

type SupportedShortcutPlatform = 'darwin' | 'linux' | 'win32';

function toSupportedPlatform(platform: NodeJS.Platform): SupportedShortcutPlatform | null {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return platform;
  return null;
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + cost,
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

function contextAllowsShortcut(shortcutDef: ShortcutDefinition, normalizedInput: string, options: ShortcutLookupOptions): boolean {
  if (!shortcutDef.contextHints?.length) return true;

  const contextSource = `${normalizedInput} ${options.contextHint ?? ''}`.toLowerCase();
  return shortcutDef.contextHints.some(hint => contextSource.includes(hint.toLowerCase()));
}

export function resolveShortcutKey(shortcutDef: ShortcutDefinition, platform: NodeJS.Platform = os.platform()): string {
  const supported = toSupportedPlatform(platform);
  if (!supported) return shortcutDef.keys.default;
  return shortcutDef.keys[supported] ?? shortcutDef.keys.default;
}

export function findShortcut(
  input: string,
  platform: NodeJS.Platform = os.platform(),
  options: ShortcutLookupOptions = {},
): ShortcutMatch | null {
  const normalized = normalizeIntent(input);
  const compact = compactIntent(input);
  const enableFuzzy = options.enableFuzzy ?? true;
  const maxDistance = options.maxDistance ?? 1;

  let bestFuzzy: { shortcutDef: ShortcutDefinition; intent: string; distance: number } | null = null;

  for (const shortcutDef of SHORTCUTS) {
    if (!contextAllowsShortcut(shortcutDef, normalized, options)) continue;

    for (const intent of shortcutDef.intents) {
      const normalizedIntent = normalizeIntent(intent);
      if (normalized === normalizedIntent || normalized === `press ${normalizedIntent}`) {
        return {
          shortcut: shortcutDef,
          combo: resolveShortcutKey(shortcutDef, platform),
          canonicalIntent: shortcutDef.canonicalIntent,
          matchedIntent: intent,
          matchType: 'exact',
        };
      }

      if (!enableFuzzy) continue;

      const intentCompact = compactIntent(intent);
      const distance = levenshteinDistance(compact, intentCompact);
      if (distance <= maxDistance && (!bestFuzzy || distance < bestFuzzy.distance)) {
        bestFuzzy = { shortcutDef, intent, distance };
      }
    }
  }

  if (!bestFuzzy) return null;

  return {
    shortcut: bestFuzzy.shortcutDef,
    combo: resolveShortcutKey(bestFuzzy.shortcutDef, platform),
    canonicalIntent: bestFuzzy.shortcutDef.canonicalIntent,
    matchedIntent: bestFuzzy.intent,
    matchType: 'fuzzy',
  };
}
