/**
 * What an agent reads: one guide as compact text (one line per shortcut), chords resolved for this OS.
 */

import type { Guide, GuideChord, GuideStep } from './lint';
import type { LoadedGuide } from './store';
import { COMPOUND_ROUTE_INDEX } from '../../tools/compact-routes';

// A guide name spelled like a tool (Chrome's close_window, open_file) would be rewritten into that tool's call by the compact
// surface's renaming of tool text: such a name is shown as words, in the hint and in the guide alike.
const toolNames = new Set(Object.values(COMPOUND_ROUTE_INDEX).flat().map(r => r.delegate));
export const shownName = (n: string): string => (toolNames.has(n) ? n.replace(/_/g, ' ') : n);

/** The chord to press on `platform`: `mod` is Ctrl (Windows, Linux) or Cmd (macOS); a per-OS object picks its OS, else its default; "" or missing is no key. */
export function resolveChord(chord: GuideChord, platform: string): string | null {
  const c = typeof chord === 'string' ? chord : (chord[platform as 'darwin'] ?? chord.default);
  if (!c) return null;
  return c.split(' ').map(p => p.split('+').map(t => (t === 'mod' ? (platform === 'darwin' ? 'cmd' : 'ctrl') : t)).join('+')).join(' ');
}

const OS_LABEL: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

const stepText = (s: GuideStep, platform: string): string =>
  s.type === 'pressKey' ? (resolveChord(String(s.key ?? ''), platform) ?? '') : s.type === 'typeAtFocus' ? `type <${s.field ?? 'text'}>` : s.type === 'wait' ? `wait ${s.ms ?? ''}ms` : `check ${s.name ?? ''}`.trim();

function workflowLine(id: string, wf: string | { name?: string; steps?: GuideStep[] }, platform: string): string {
  const line = typeof wf === 'string' ? `${shownName(id)}: ${wf}` : `${shownName(id)}: ${wf.name ?? ''} -> ${(wf.steps ?? []).map(s => stepText(s, platform)).join(', ')}`;
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** Every word of the query in the text; if no line has them all, any word. */
function filterBy<T>(items: T[], text: (t: T) => string, query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const all = items.filter(i => words.every(w => text(i).toLowerCase().includes(w)));
  return all.length ? all : items.filter(i => words.some(w => text(i).toLowerCase().includes(w)));
}

export function guideCounts(g: Guide): { shortcuts: number; workflows: number } {
  return { shortcuts: Object.keys(g.shortcuts).length, workflows: Object.keys(g.workflows ?? {}).length };
}

export function renderGuide({ id, guide: g }: LoadedGuide, platform: string, query?: string): string {
  const all = Object.entries(g.shortcuts)
    .map(([name, chord]) => ({ name, chord: resolveChord(chord, platform) }))
    .filter((s): s is { name: string; chord: string } => !!s.chord);
  const shown = query ? filterBy(all, s => `${s.name.replace(/_/g, ' ')} ${s.chord}`, query) : all;
  const hard = new Set(g.consequential ?? []);
  const where = (g.kind === 'web' ? g.domainHints : g.processNames)?.[0];
  const from = `verified ${g.lastVerified ?? ''}`.trim();
  const lines = [`${g.name ?? id} guide (${[g.kind, where].filter(Boolean).join(' ')}; ${from}; ${OS_LABEL[platform] ?? platform}): ${query ? `${shown.length} of ${all.length}` : all.length} shortcuts${query ? ` for "${query}"` : ''}`];
  for (const s of shown) lines.push(`${shownName(s.name)}${hard.has(s.name) ? ' *' : ''}: ${s.chord}`);
  if (shown.some(s => hard.has(s.name))) lines.push('* = hard to undo (sends, posts, deletes, pays or closes): ask the user first unless they asked for it');
  const wfs = filterBy(Object.entries(g.workflows ?? {}), ([k, w]) => `${k} ${typeof w === 'string' ? w : w.name ?? ''}`, query ?? '');
  if (wfs.length) lines.push('Workflows:', ...wfs.map(([k, w]) => workflowLine(k, w, platform)));
  const tips = query ? filterBy(g.tips ?? [], t => t, query).slice(0, 3) : g.tips ?? [];
  if (tips.length) lines.push('Tips:', ...tips.map(t => `- ${t}`));
  return lines.join('\n');
}
