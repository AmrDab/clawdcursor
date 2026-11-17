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
  /**
   * The chord per OS. `default` is the Windows + Linux chord; `darwin`, `linux`, `win32` override it for that OS.
   * An empty string means the shortcut does not exist on that OS: it is then not listed and not run there — there is
   * no falling back to another OS's keys. A macOS-only entry is `{ default: '', darwin: … }`.
   */
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

/** Windows / Linux shortcut modifier. */
const MOD = 'Control';
/** macOS shortcut modifier (Command). `Control` in a darwin chord is the real Ctrl key. */
const CMD = 'Cmd';

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
  shortcut('redo', 'editing', 'Redo previous action', 'redo', ['redo'], { default: `${MOD}+y`, darwin: `${CMD}+Shift+z`, linux: `${MOD}+Shift+z` }),
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
  // 'close-window' is defined once, below: Cmd+W on macOS. Cmd+Q would QUIT the app, not close the window.
  shortcut('minimize-window', 'window', 'Minimize current window', 'minimize window', ['minimize window'], { default: 'Super+Down', darwin: `${CMD}+m`, linux: 'Super+h' }),
  shortcut('maximize-window', 'window', 'Maximize current window', 'maximize window', ['maximize window'], { default: 'Super+Up', darwin: `Control+${CMD}+f` }),
  shortcut('show-desktop', 'window', 'Show desktop', 'show desktop', ['show desktop', 'go to desktop', 'minimize all'], { default: 'Super+d', darwin: 'F11' }),

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
  shortcut('system-search', 'quick', 'Open system search', 'system search', ['system search', 'open search', 'search apps'], { default: '', win32: 'Super+s', linux: 'Super', darwin: `${CMD}+Space` }),

  // ─── macOS System Shortcuts (from Apple support.apple.com/en-us/102650) ────
  shortcut('screenshot-full', 'quick', 'Take full screenshot', 'screenshot',
    ['screenshot', 'take screenshot', 'capture screen', 'print screen'],
    { default: '', win32: 'Super+Shift+s', darwin: `Shift+${CMD}+3` }),
  shortcut('screenshot-selection', 'quick', 'Screenshot selection', 'screenshot selection',
    ['screenshot selection', 'capture area', 'screenshot region'],
    { default: '', win32: 'Super+Shift+s', darwin: `Shift+${CMD}+4` }),
  shortcut('screenshot-window', 'quick', 'Screenshot or screen recording menu', 'screenshot menu',
    ['screenshot menu', 'screen recording'],
    { default: '', win32: 'Super+Shift+s', darwin: `Shift+${CMD}+5` }),
  shortcut('spotlight', 'quick', 'Open Spotlight / system search', 'spotlight',
    ['spotlight', 'search apps', 'find app', 'open spotlight'],
    { default: '', win32: 'Super+s', linux: 'Super', darwin: `${CMD}+Space` }),
  shortcut('force-quit', 'window', 'Force quit application', 'force quit',
    ['force quit', 'kill app', 'force close'],
    { default: '', darwin: `Option+${CMD}+Escape` }),
  shortcut('quit-app', 'window', 'Quit current application', 'quit app',
    ['quit app', 'close app', 'exit app'],
    { default: 'Alt+F4', darwin: `${CMD}+q` }),
  shortcut('close-window', 'window', 'Close front window', 'close window',
    ['close window', 'close this window'],
    { default: 'Alt+F4', darwin: `${CMD}+w` }),
  shortcut('close-all-windows', 'window', 'Close all windows of app', 'close all windows',
    ['close all windows', 'close all'],
    { default: '', darwin: `Option+${CMD}+w` }),
  shortcut('minimize-all', 'window', 'Minimize all windows of app', 'minimize all',
    ['minimize all', 'minimize all windows'],
    { default: 'Super+d', darwin: `Option+${CMD}+m` }),
  shortcut('switch-windows-same-app', 'window', 'Switch between windows of same app', 'switch windows',
    ['switch windows', 'next window', 'cycle windows'],
    { default: '', linux: 'Alt+`', darwin: `${CMD}+\`` }),
  shortcut('preferences', 'quick', 'Open app preferences/settings', 'preferences',
    ['preferences', 'settings', 'app settings', 'open settings'],
    { default: '', darwin: `${CMD}+,` }),
  shortcut('hide-app', 'window', 'Hide current app', 'hide app',
    ['hide app', 'hide window', 'hide this'],
    { default: '', darwin: `${CMD}+h` }),
  shortcut('hide-others', 'window', 'Hide all other apps', 'hide others',
    ['hide others', 'hide other apps', 'focus this app'],
    { default: '', darwin: `Option+${CMD}+h` }),
  shortcut('mission-control', 'window', 'Open Mission Control', 'mission control',
    ['mission control', 'show all windows', 'overview'],
    { default: '', win32: 'Super+Tab', linux: 'Super', darwin: 'Control+Up' }),
  shortcut('app-expose', 'window', 'Show all windows of current app', 'app expose',
    ['app expose', 'show app windows', 'all windows'],
    { default: '', darwin: 'Control+Down' }),

  // ─── Text editing (macOS-specific from Apple reference) ─────────
  shortcut('bold', 'editing', 'Bold text', 'bold',
    ['bold', 'make bold', 'bold text'],
    { default: `${MOD}+b`, darwin: `${CMD}+b` }),
  shortcut('italic', 'editing', 'Italic text', 'italic',
    ['italic', 'make italic', 'italicize'],
    { default: `${MOD}+i`, darwin: `${CMD}+i` }),
  shortcut('underline', 'editing', 'Underline text', 'underline',
    ['underline', 'make underline'],
    { default: `${MOD}+u`, darwin: `${CMD}+u` }),
  shortcut('paste-match-style', 'editing', 'Paste and match style', 'paste plain',
    ['paste plain', 'paste without formatting', 'paste match style'],
    { default: `${MOD}+Shift+v`, darwin: `Option+Shift+${CMD}+v` }),
  shortcut('copy-style', 'editing', 'Copy formatting', 'copy style',
    ['copy style', 'copy formatting'],
    { default: '', darwin: `Option+${CMD}+c` }),
  shortcut('paste-style', 'editing', 'Paste formatting', 'paste style',
    ['paste style', 'paste formatting'],
    { default: '', darwin: `Option+${CMD}+v` }),
  shortcut('show-fonts', 'editing', 'Show fonts window', 'show fonts',
    ['show fonts', 'fonts', 'font picker'],
    { default: '', darwin: `${CMD}+t` }),
  shortcut('spelling', 'editing', 'Show spelling and grammar', 'spelling',
    ['spelling', 'spell check', 'grammar'],
    { default: '', darwin: `Shift+${CMD}+:` }),
  shortcut('definition', 'editing', 'Show definition of word', 'definition',
    ['definition', 'define word', 'look up'],
    { default: '', darwin: `Control+${CMD}+d` }),
  shortcut('emoji-picker', 'editing', 'Open emoji/character picker', 'emoji',
    ['emoji', 'emoji picker', 'character viewer', 'special characters'],
    { default: '', win32: 'Super+.', darwin: `Control+${CMD}+Space` }),

  // ─── Email shortcuts (generic — Outlook on Windows, Mail.app on macOS, from Apple docs) ────
  shortcut('email-new-message', 'editing', 'Create new email message', 'new email',
    ['new email', 'new message', 'compose email', 'compose message', 'write email', 'create email', 'new mail'],
    { default: `${MOD}+n`, darwin: `${CMD}+n` }, ['outlook', 'olk', 'mail', 'thunderbird']),
  shortcut('email-send', 'editing', 'Send email message', 'send email',
    ['send email', 'send message', 'send mail', 'send this email', 'send it'],
    { default: `${MOD}+Return`, darwin: `Shift+${CMD}+d` }, ['outlook', 'olk', 'mail', 'thunderbird']),
  shortcut('email-reply', 'editing', 'Reply to email', 'reply',
    ['reply', 'reply to email', 'reply to message', 'reply to this'],
    { default: `${MOD}+r`, darwin: `${CMD}+r` }, ['outlook', 'olk', 'mail', 'thunderbird']),
  shortcut('email-reply-all', 'editing', 'Reply all to email', 'reply all',
    ['reply all', 'reply to all', 'respond to all'],
    { default: `${MOD}+Shift+r`, darwin: `Shift+${CMD}+r` }, ['outlook', 'olk', 'mail', 'thunderbird']),
  shortcut('email-forward', 'editing', 'Forward email', 'forward email',
    ['forward', 'forward email', 'forward message', 'forward this'],
    { default: `${MOD}+f`, darwin: `Shift+${CMD}+f`, linux: `${MOD}+l` }, ['outlook', 'olk', 'mail', 'thunderbird']),
  shortcut('email-attach', 'editing', 'Attach file to email', 'attach file',
    ['attach file', 'attach', 'add attachment'],
    { default: '', darwin: `Shift+${CMD}+a` }, ['outlook', 'olk', 'mail', 'thunderbird']),
  shortcut('email-delete', 'editing', 'Delete email', 'delete email',
    ['delete email', 'delete message', 'delete this email', 'trash email'],
    { default: 'Delete' }, ['outlook', 'olk', 'mail', 'thunderbird']),
  shortcut('email-mark-read', 'editing', 'Mark email as read/unread', 'mark as read',
    ['mark as read', 'mark read', 'mark unread', 'mark as unread'],
    { default: `${MOD}+q`, darwin: `Shift+${CMD}+u`, linux: 'm' }, ['outlook', 'olk', 'mail', 'thunderbird']),
  shortcut('email-check', 'editing', 'Check for new mail', 'check mail',
    ['check mail', 'get mail', 'refresh', 'check for new messages', 'fetch mail'],
    { default: 'F9', darwin: `Shift+${CMD}+n`, linux: '' }, ['outlook', 'olk', 'mail', 'thunderbird']),
  shortcut('email-junk', 'editing', 'Move email to junk', 'junk email',
    ['junk', 'mark as junk', 'spam', 'junk email'],
    { default: '', darwin: `Shift+${CMD}+j` }, ['outlook', 'olk', 'mail', 'thunderbird']),
  shortcut('email-archive', 'editing', 'Archive email', 'archive email',
    ['archive', 'archive email', 'archive message'],
    { default: '', darwin: `Control+${CMD}+a` }, ['outlook', 'olk', 'mail', 'thunderbird']),

  // ─── Safari shortcuts (from Apple docs: support.apple.com/guide/safari/cpsh003) ────
  shortcut('safari-new-tab', 'browser', 'New tab in Safari', 'new tab',
    ['new tab', 'open new tab'],
    { default: '', darwin: `${CMD}+t` }, ['safari']),
  shortcut('safari-address-bar', 'browser', 'Focus address bar', 'address bar',
    ['address bar', 'url bar', 'location bar'],
    { default: '', darwin: `${CMD}+l` }, ['safari']),
  shortcut('safari-next-tab', 'browser', 'Next tab', 'next tab',
    ['next tab', 'switch tab'],
    { default: '', darwin: `Control+Tab` }, ['safari']),
  shortcut('safari-prev-tab', 'browser', 'Previous tab', 'previous tab',
    ['previous tab', 'prev tab'],
    { default: '', darwin: `Control+Shift+Tab` }, ['safari']),
  shortcut('safari-close-tab', 'browser', 'Close tab', 'close tab',
    ['close tab'],
    { default: '', darwin: `${CMD}+w` }, ['safari']),
  shortcut('safari-reopen-tab', 'browser', 'Reopen last closed tab', 'reopen tab',
    ['reopen tab', 'undo close tab'],
    { default: '', darwin: `Shift+${CMD}+t` }, ['safari']),
  shortcut('safari-homepage', 'browser', 'Go to homepage', 'go home',
    ['homepage', 'go home', 'home page'],
    { default: '', darwin: `Shift+${CMD}+h` }, ['safari']),
  shortcut('safari-reader', 'browser', 'Toggle Reader view', 'reader mode',
    ['reader', 'reader mode', 'reader view'],
    { default: '', darwin: `Shift+${CMD}+r` }, ['safari']),
  shortcut('safari-downloads', 'browser', 'Show downloads', 'show downloads',
    ['downloads', 'show downloads'],
    { default: '', darwin: `Option+${CMD}+l` }, ['safari']),

  // ─── Notes shortcuts (from Apple docs: support.apple.com/guide/notes/apd46c25187e) ────
  shortcut('notes-new', 'editing', 'Create new note', 'new note',
    ['new note', 'create note'],
    { default: '', darwin: `${CMD}+n` }, ['notes']),
  shortcut('notes-new-folder', 'editing', 'Create new folder in Notes', 'new folder',
    ['new folder'],
    { default: '', darwin: `Shift+${CMD}+n` }, ['notes']),
  shortcut('notes-search', 'editing', 'Search all notes', 'search notes',
    ['search notes', 'find note'],
    { default: '', darwin: `Option+${CMD}+f` }, ['notes']),
  shortcut('notes-attach', 'editing', 'Attach file to note', 'attach file',
    ['attach', 'attach file'],
    { default: '', darwin: `Shift+${CMD}+a` }, ['notes']),
  shortcut('notes-table', 'editing', 'Insert table in note', 'insert table',
    ['insert table', 'add table'],
    { default: '', darwin: `Option+${CMD}+t` }, ['notes']),
  shortcut('notes-checklist', 'editing', 'Apply checklist format', 'checklist',
    ['checklist', 'todo list', 'add checklist'],
    { default: '', darwin: `Shift+${CMD}+l` }, ['notes']),
  shortcut('notes-title', 'editing', 'Apply title format', 'title format',
    ['title', 'heading', 'title format'],
    { default: '', darwin: `Shift+${CMD}+t` }, ['notes']),
  shortcut('notes-link', 'editing', 'Add web link', 'add link',
    ['add link', 'insert link', 'web link'],
    { default: '', darwin: `${CMD}+k` }, ['notes']),

  // ─── Messages shortcuts (from Apple docs: support.apple.com/guide/messages/ichtc78b3bff) ────
  shortcut('messages-new', 'editing', 'Start new message', 'new message',
    ['new message', 'new text', 'new imessage'],
    { default: '', darwin: `${CMD}+n` }, ['messages']),
  shortcut('messages-send', 'editing', 'Send message', 'send message',
    ['send message', 'send text', 'send it'],
    { default: '', darwin: 'Return' }, ['messages']),
  shortcut('messages-newline', 'editing', 'New line in message', 'new line',
    ['new line', 'line break'],
    { default: '', darwin: 'Option+Return' }, ['messages']),
  shortcut('messages-search', 'editing', 'Search conversations', 'search messages',
    ['search messages', 'find message', 'search conversations'],
    { default: '', darwin: `${CMD}+f` }, ['messages']),
  shortcut('messages-emoji', 'editing', 'Open emoji picker', 'emoji',
    ['emoji', 'emoji picker'],
    { default: '', darwin: `Control+${CMD}+Space` }, ['messages']),

  // ─── Terminal shortcuts (from Apple docs: support.apple.com/guide/terminal/trmlshtcts) ────
  shortcut('terminal-new-window', 'editing', 'New terminal window', 'new terminal',
    ['new terminal', 'new window'],
    { default: '', darwin: `${CMD}+n` }, ['terminal']),
  shortcut('terminal-new-tab', 'editing', 'New terminal tab', 'new tab',
    ['new tab'],
    { default: '', darwin: `${CMD}+t` }, ['terminal']),
  shortcut('terminal-split', 'editing', 'Split terminal pane', 'split pane',
    ['split pane', 'split terminal'],
    { default: '', darwin: `${CMD}+d` }, ['terminal']),
  shortcut('terminal-clear', 'editing', 'Clear terminal', 'clear terminal',
    ['clear', 'clear terminal', 'clear screen'],
    { default: '', darwin: `${CMD}+k` }, ['terminal']),
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

/** The chord for `platform`, or '' when the shortcut does not exist there. Never another OS's chord. */
export function resolveShortcutKey(shortcutDef: ShortcutDefinition, platform: NodeJS.Platform = os.platform()): string {
  const supported = toSupportedPlatform(platform);
  if (!supported) return shortcutDef.keys.default;
  return shortcutDef.keys[supported] ?? shortcutDef.keys.default;
}

/** The shortcuts that exist on `platform` — the only ones listed, matched or run there. */
export function shortcutsFor(platform: NodeJS.Platform = os.platform()): ShortcutDefinition[] {
  return SHORTCUTS.filter(s => resolveShortcutKey(s, platform).trim() !== '');
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

  for (const shortcutDef of shortcutsFor(platform)) {
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
