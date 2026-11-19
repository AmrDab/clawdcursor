/**
 * The line appended when an open or focus lands in an app or site that has a guide: the guide's essential keys for this OS,
 * then the pointer to the rest. Once per app per server session, and nothing on any other call. (Tool text is renamed per
 * surface: toCompactNames turns the granular name into `system {"action":"shortcuts_list",...}`.)
 */

import { findGuide, termsOf } from './store';
import { guideCounts, resolveChord } from './render';
import { MAX_ESSENTIALS } from './lint';
import { wrapUntrustedScreenContent } from '../untrusted-screen-content';
import { COMPOUND_ROUTE_INDEX } from '../../tools/compact-routes';

const told = new Set<string>();
export function resetGuideHints(): void { told.clear(); }

const OS_LABEL: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
// A shortcut named like a tool (close_window, open_file) would be rewritten to that tool's call on the compact surface: shown as words.
const toolNames = new Set(Object.values(COMPOUND_ROUTE_INDEX).flat().map(r => r.delegate));

export interface GuideProbe { /** process names, app names */ names?: string[]; title?: string; url?: string }

/** The hint line for what the call landed in, or '' (no guide, or already told). */
export function guideHint(probe: GuideProbe, platform: string = process.platform): string {
  try {
    const terms = [...(probe.names ?? []), ...(probe.url ? termsOf(probe.url) : [])];
    const hit = findGuide(terms, probe.title, platform);
    if (!hit || told.has(hit.id)) return '';
    told.add(hit.id);
    const { guide: g } = hit;
    const { shortcuts, workflows } = guideCounts(g);
    const label = g.name ?? hit.id;
    const hard = new Set(g.consequential ?? []);
    // The essentials, else the first shortcuts in file order; a name with no key on this OS is skipped.
    const keys = (g.essentials ?? Object.keys(g.shortcuts))
      .map(n => ({ n, chord: g.shortcuts[n] === undefined ? null : resolveChord(g.shortcuts[n], platform) }))
      .filter((k): k is { n: string; chord: string } => !!k.chord)
      .slice(0, MAX_ESSENTIALS);
    const pointer = `shortcuts_list ${JSON.stringify({ context: hit.id })}`;
    // Only the guides bundled in the package are the project's own words; a refreshed or saved one is data, never instructions.
    const own = hit.source === 'bundled';
    if (!keys.length) return `guide: ${own ? label : wrapUntrustedScreenContent(label)} (${shortcuts} shortcuts, ${workflows} workflows): ${pointer}`;
    const list = keys.map(k => `${toolNames.has(k.n) ? k.n.replace(/_/g, ' ') : k.n}${hard.has(k.n) ? '*' : ''} ${k.chord}`).join(' · ');
    const body = `${label} keys (${OS_LABEL[platform] ?? platform}): ${list}${keys.some(k => hard.has(k.n)) ? ' (* = hard to undo)' : ''}`;
    const rest = `All ${shortcuts} shortcuts, ${workflows} workflows and tips: ${pointer}`;
    return own ? `guide: ${body}. ${rest}` : `guide:\n${wrapUntrustedScreenContent(body)}\n${rest}`;
  } catch { return ''; }
}

/** `text` with the hint on its own last line. */
export function withGuideHint(text: string, probe: GuideProbe, platform?: string): string {
  const h = guideHint(probe, platform);
  return h ? `${text}\n${h}` : text;
}
