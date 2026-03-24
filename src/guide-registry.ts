/**
 * App Guide Registry CLI
 *
 * Fetches keyboard shortcuts from the open-source use-the-keyboard database
 * (86+ apps), converts them to ClawdCursor guide format, and installs locally.
 *
 * Usage:
 *   clawdcursor guides                 — list available apps
 *   clawdcursor guides install excel   — install Excel guide
 *   clawdcursor guides install --all   — install all guides
 *   clawdcursor guides list            — show installed guides
 *   clawdcursor guides remove excel    — remove a guide
 *
 * Data source: https://github.com/aschmelyun/use-the-keyboard (MIT license)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

// ── Constants ────────────────────────────────────────────────────────────────

const REGISTRY_BASE = 'https://raw.githubusercontent.com/aschmelyun/use-the-keyboard/master/content';
const REGISTRY_INDEX = `${REGISTRY_BASE}/index.json`;
const GUIDES_DIR = path.join(__dirname, '..', 'guides');

// ── Process name mapping ─────────────────────────────────────────────────────
// Maps registry slugs → Windows/macOS process names for auto-detection.
// Community can extend this by editing the installed guide's processNames field.

const PROCESS_MAP: Record<string, string[]> = {
  'excel':            ['EXCEL', 'excel'],
  'google-chrome':    ['chrome', 'Google Chrome'],
  'firefox':          ['firefox', 'Firefox'],
  'spotify':          ['Spotify', 'spotify'],
  'discord':          ['Discord', 'discord'],
  'slack':            ['Slack', 'slack'],
  'vs-code':          ['Code', 'code'],
  'outlook':          ['OUTLOOK', 'olk'],
  'notion':           ['Notion', 'notion'],
  'figma':            ['Figma', 'figma'],
  'adobe-photoshop':  ['Photoshop', 'photoshop'],
  'adobe-lightroom':  ['Lightroom', 'lightroom'],
  'adobe-xd':         ['XD'],
  'blender':          ['blender', 'Blender'],
  'gimp':             ['gimp', 'GIMP'],
  'obsidian':         ['Obsidian', 'obsidian'],
  'postman':          ['Postman', 'postman'],
  'sublime-text':     ['sublime_text', 'Sublime Text'],
  'notepad-plus-plus':['notepad++', 'Notepad++'],
  'vlc-player':       ['vlc', 'VLC'],
  'microsoft-teams':  ['Teams', 'ms-teams'],
  'zoom-windows':     ['Zoom', 'zoom'],
  'zoom-mac':         ['zoom.us'],
  'finder':           ['Finder'],
  'iterm':            ['iTerm2', 'iterm2'],
  'telegram':         ['Telegram', 'telegram'],
  'skype':            ['Skype', 'skype'],
  'trello':           ['trello'],
  'jira':             ['jira'],
  'github':           ['github'],
  'gitlab':           ['gitlab'],
  'gmail':            ['gmail'],
  'youtube':          ['youtube'],
  'reddit':           ['reddit'],
  'twitter':          ['twitter'],
  'netflix':          ['netflix'],
  'soundcloud':       ['soundcloud'],
  'todoist':          ['Todoist', 'todoist'],
  'evernote':         ['Evernote', 'evernote'],
  'airtable':         ['airtable'],
  'asana':            ['asana'],
  'monday':           ['monday'],
  'webflow':          ['webflow'],
  'wordpress':        ['wordpress'],
  'shopify':          ['shopify'],
  'unity-3d':         ['Unity', 'unity'],
  'android-studio':   ['studio64', 'Android Studio'],
  'xcode':            ['Xcode'],
  'phpstorm':         ['phpstorm', 'PhpStorm'],
  'arduino':          ['Arduino IDE', 'arduino'],
  'putty':            ['putty', 'PuTTY'],
  'filezilla':        ['filezilla', 'FileZilla'],
  'audacity':         ['Audacity', 'audacity'],
  'brave':            ['brave', 'Brave Browser'],
  'vivaldi':          ['vivaldi', 'Vivaldi'],
  'chrome-devtools':  ['chrome', 'Google Chrome'],  // devtools are inside Chrome
  'sketch':           ['Sketch'],
  'affinity-designer':['Affinity Designer'],
  'affinity-photo':   ['Affinity Photo'],
};

// ── Fetch helper ─────────────────────────────────────────────────────────────

function fetchJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'clawdcursor-guide-registry' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJSON(res.headers.location!).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Converter ────────────────────────────────────────────────────────────────

interface RegistryEntry {
  slug: string;
  title: string;
  sections: Array<{
    name: string;
    shortcuts: Array<{ description: string; keys: string[] }>;
  }>;
  reference_link?: string;
}

interface ClawdGuide {
  app: string;
  processNames: string[];
  source: string;
  shortcuts: Record<string, string>;
  sections: Record<string, Record<string, string>>;
  tips: string[];
}

function convertToGuide(entry: RegistryEntry): ClawdGuide {
  const shortcuts: Record<string, string> = {};
  const sections: Record<string, Record<string, string>> = {};

  for (const section of entry.sections || []) {
    const sectionShortcuts: Record<string, string> = {};
    for (const sc of section.shortcuts || []) {
      const keyCombo = sc.keys.join('+');
      const desc = sc.description.replace(/\s+/g, ' ').trim();
      // Add to flat shortcuts map (kebab-case key)
      const shortcutKey = desc.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 40);
      shortcuts[shortcutKey] = keyCombo;
      sectionShortcuts[desc] = keyCombo;
    }
    sections[section.name] = sectionShortcuts;
  }

  return {
    app: entry.title,
    processNames: PROCESS_MAP[entry.slug] || [entry.slug],
    source: entry.reference_link || `https://usethekeyboard.com/${entry.slug}`,
    shortcuts,
    sections,
    tips: [
      `Keyboard shortcuts reference for ${entry.title}.`,
      `Source: ${entry.reference_link || 'usethekeyboard.com'}`,
    ],
  };
}

// ── CLI Commands ─────────────────────────────────────────────────────────────

// Available apps in the registry (cached from GitHub API)
const AVAILABLE_APPS = [
  '1password', 'adobe-lightroom', 'adobe-photoshop', 'adobe-xd',
  'affinity-designer', 'affinity-photo', 'airtable', 'android-studio',
  'apex-legends', 'apple-music', 'arduino', 'asana', 'audacity',
  'bear-notes', 'bitbucket', 'blender', 'brave', 'chrome-devtools',
  'code-editor-ios', 'discord', 'dropbox', 'evernote', 'excel',
  'feedly', 'figma', 'filezilla', 'finder', 'firefox', 'fortnite',
  'framer-x', 'gimp', 'github', 'gitlab', 'gmail', 'google-chrome',
  'google-drive', 'guitar-pro', 'iterm', 'jira', 'kanbanmail',
  'microsoft-teams', 'missive', 'monday', 'netflix',
  'notepad-plus-plus', 'notion', 'obsidian', 'origami', 'outlook',
  'phpstorm', 'pocket', 'postman', 'principle', 'proto-io', 'putty',
  'quip', 'reddit', 'roam', 'sequelpro', 'shopify', 'sketch',
  'sketchup', 'skype', 'slack', 'soundcloud', 'spotify',
  'sublime-text', 'superhuman', 'tableplus', 'telegram', 'ticktick',
  'todoist', 'transmit', 'trello', 'twitter', 'unity-3d', 'vivaldi',
  'vlc-player', 'vs-code', 'webflow', 'wordpress', 'xcode',
  'youtube', 'zoom-mac', 'zoom-windows',
];

export async function guidesCommand(args: string[]): Promise<void> {
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === 'help') {
    printUsage();
    return;
  }

  if (subcommand === 'list') {
    listInstalled();
    return;
  }

  if (subcommand === 'available') {
    listAvailable();
    return;
  }

  if (subcommand === 'install') {
    const target = args[1]?.toLowerCase();
    if (!target) {
      console.log('\n   Usage: clawdcursor guides install <app-name>');
      console.log('   Usage: clawdcursor guides install --all\n');
      console.log('   Run `clawdcursor guides available` to see all apps.\n');
      return;
    }
    if (target === '--all') {
      await installAll();
    } else {
      await installGuide(target);
    }
    return;
  }

  if (subcommand === 'remove') {
    const target = args[1]?.toLowerCase();
    if (!target) {
      console.log('\n   Usage: clawdcursor guides remove <app-name>\n');
      return;
    }
    removeGuide(target);
    return;
  }

  if (subcommand === 'search') {
    const query = args.slice(1).join(' ').toLowerCase();
    searchGuides(query);
    return;
  }

  // If no subcommand matched, treat as app name to install
  await installGuide(subcommand);
}

function printUsage(): void {
  console.log(`
  /\\___/\\
 ( >^.^< )  ClawdCursor App Guides
  )     (
 (_)_(_)_)

   clawdcursor guides available          List all 86+ downloadable app guides
   clawdcursor guides search <query>     Search for an app guide
   clawdcursor guides install <app>      Install a guide (e.g. "excel", "spotify")
   clawdcursor guides install --all      Install all available guides
   clawdcursor guides list               Show installed guides
   clawdcursor guides remove <app>       Remove an installed guide

   Guides teach ClawdCursor's AI how to efficiently operate each app —
   keyboard shortcuts, workflows, and UI tips. Loaded automatically at runtime.

   Data source: usethekeyboard.com (MIT license, 86+ apps)
   Custom guides: add JSON files to the guides/ directory
`);
}

function listInstalled(): void {
  if (!fs.existsSync(GUIDES_DIR)) {
    console.log('\n   No guides installed yet. Run: clawdcursor guides install <app>\n');
    return;
  }

  const files = fs.readdirSync(GUIDES_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('\n   No guides installed yet. Run: clawdcursor guides install <app>\n');
    return;
  }

  console.log(`\n   📖 Installed guides (${files.length}):\n`);
  for (const file of files.sort()) {
    try {
      const guide = JSON.parse(fs.readFileSync(path.join(GUIDES_DIR, file), 'utf8'));
      const shortcutCount = Object.keys(guide.shortcuts || {}).length;
      const processNames = (guide.processNames || []).join(', ');
      console.log(`   ${file.padEnd(25)} ${(guide.app || '').padEnd(25)} ${shortcutCount} shortcuts   [${processNames}]`);
    } catch {
      console.log(`   ${file.padEnd(25)} (unreadable)`);
    }
  }
  console.log('');
}

function listAvailable(): void {
  console.log(`\n   📦 Available app guides (${AVAILABLE_APPS.length}):\n`);

  // Check which are installed
  const installed = new Set<string>();
  if (fs.existsSync(GUIDES_DIR)) {
    for (const f of fs.readdirSync(GUIDES_DIR).filter(f => f.endsWith('.json'))) {
      installed.add(f.replace('.json', '').toLowerCase());
    }
  }

  const cols = 3;
  for (let i = 0; i < AVAILABLE_APPS.length; i += cols) {
    const row = AVAILABLE_APPS.slice(i, i + cols).map(app => {
      const marker = installed.has(app) ? ' ✅' : '';
      return `   ${app}${marker}`.padEnd(28);
    }).join('');
    console.log(row);
  }

  console.log(`\n   Install: clawdcursor guides install <app-name>`);
  console.log(`   Install all: clawdcursor guides install --all\n`);
}

function searchGuides(query: string): void {
  if (!query) {
    console.log('\n   Usage: clawdcursor guides search <query>\n');
    return;
  }
  const matches = AVAILABLE_APPS.filter(app => app.includes(query));
  if (matches.length === 0) {
    console.log(`\n   No apps matching "${query}". Try: clawdcursor guides available\n`);
    return;
  }
  console.log(`\n   🔍 Apps matching "${query}" (${matches.length}):\n`);
  for (const app of matches) {
    const processNames = PROCESS_MAP[app]?.join(', ') || '(auto-detect)';
    console.log(`   ${app.padEnd(25)} → ${processNames}`);
  }
  console.log(`\n   Install: clawdcursor guides install <app-name>\n`);
}

async function installGuide(slug: string): Promise<void> {
  // Normalize common names
  const normalized = slug
    .replace(/\s+/g, '-')
    .replace(/^ms-/, 'microsoft-')
    .replace(/^vscode$/, 'vs-code')
    .replace(/^chrome$/, 'google-chrome')
    .replace(/^teams$/, 'microsoft-teams')
    .replace(/^ps$/, 'adobe-photoshop')
    .replace(/^lr$/, 'adobe-lightroom')
    .replace(/^notepad\+\+$/, 'notepad-plus-plus');

  if (!AVAILABLE_APPS.includes(normalized)) {
    // Fuzzy match
    const fuzzy = AVAILABLE_APPS.filter(a => a.includes(normalized) || normalized.includes(a));
    if (fuzzy.length > 0) {
      console.log(`\n   "${slug}" not found. Did you mean:`);
      for (const f of fuzzy) console.log(`     - ${f}`);
      console.log('');
      return;
    }
    console.log(`\n   ❌ "${slug}" not found in registry.`);
    console.log(`   Run: clawdcursor guides available\n`);
    return;
  }

  const url = `${REGISTRY_BASE}/${normalized}.json`;
  console.log(`   ⬇️  Downloading ${normalized}...`);

  try {
    const entry = await fetchJSON(url) as RegistryEntry;
    const guide = convertToGuide(entry);

    // Ensure guides directory exists
    if (!fs.existsSync(GUIDES_DIR)) {
      fs.mkdirSync(GUIDES_DIR, { recursive: true });
    }

    // Determine filename — use first process name or slug
    const filename = (guide.processNames[0] || normalized) + '.json';
    const filepath = path.join(GUIDES_DIR, filename);

    // Merge with existing guide if it has custom workflows/tips
    if (fs.existsSync(filepath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        // Preserve custom workflows, layout, and tips from hand-crafted guides
        if (existing.workflows) guide.tips.push('(Custom workflows preserved from existing guide)');
        const merged = {
          ...guide,
          workflows: existing.workflows || undefined,
          layout: existing.layout || undefined,
          tips: [...new Set([...(existing.tips || []), ...guide.tips])],
        };
        fs.writeFileSync(filepath, JSON.stringify(merged, null, 2));
        const totalShortcuts = Object.keys(guide.shortcuts).length;
        console.log(`   ✅ Updated ${filename} — ${totalShortcuts} shortcuts (custom data preserved)`);
        return;
      } catch { /* overwrite if existing is malformed */ }
    }

    fs.writeFileSync(filepath, JSON.stringify(guide, null, 2));
    const totalShortcuts = Object.keys(guide.shortcuts).length;
    console.log(`   ✅ Installed ${filename} — ${entry.title}, ${totalShortcuts} shortcuts`);

  } catch (err: any) {
    console.error(`   ❌ Failed to install "${normalized}": ${err.message}`);
  }
}

async function installAll(): Promise<void> {
  console.log(`\n   📦 Installing all ${AVAILABLE_APPS.length} guides...\n`);

  let success = 0;
  let failed = 0;

  for (const app of AVAILABLE_APPS) {
    try {
      await installGuide(app);
      success++;
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    } catch {
      failed++;
    }
  }

  console.log(`\n   ✅ Installed ${success} guides${failed > 0 ? `, ${failed} failed` : ''}\n`);
}

function removeGuide(slug: string): void {
  const normalized = slug.replace(/\s+/g, '-');

  // Try exact match first, then search by slug
  const candidates = [
    path.join(GUIDES_DIR, normalized + '.json'),
    path.join(GUIDES_DIR, (PROCESS_MAP[normalized]?.[0] || normalized) + '.json'),
  ];

  for (const filepath of candidates) {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      console.log(`   🗑️  Removed ${path.basename(filepath)}`);
      return;
    }
  }

  console.log(`   ❌ Guide "${slug}" not found. Run: clawdcursor guides list`);
}
