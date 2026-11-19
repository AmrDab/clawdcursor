/**
 * The one-line pointer appended when an open or focus lands in an app or site that has a guide: once per app per server
 * session, and nothing on any other call. (Tool text is renamed per surface: toCompactNames turns the granular name into
 * `system {"action":"shortcuts_list",...}`.)
 */

import { findGuide, termsOf } from './store';
import { guideCounts } from './render';
import { quoteScreenText } from '../untrusted-screen-content';

const told = new Set<string>();
export function resetGuideHints(): void { told.clear(); }

export interface GuideProbe { /** process names, app names */ names?: string[]; title?: string; url?: string }

/** The hint line for what the call landed in, or '' (no guide, or already told). */
export function guideHint(probe: GuideProbe): string {
  try {
    const terms = [...(probe.names ?? []), ...(probe.url ? termsOf(probe.url) : [])];
    const hit = findGuide(terms, probe.title);
    if (!hit || told.has(hit.id)) return '';
    told.add(hit.id);
    const { shortcuts, workflows } = guideCounts(hit.guide);
    const label = hit.guide.name ?? hit.id;
    return `guide: ${hit.source === 'bundled' ? label : quoteScreenText(label)} (${shortcuts} shortcuts, ${workflows} workflows): shortcuts_list ${JSON.stringify({ context: hit.id })}`;
  } catch { return ''; }
}

/** `text` with the hint on its own last line. */
export function withGuideHint(text: string, probe: GuideProbe): string {
  const h = guideHint(probe);
  return h ? `${text}\n${h}` : text;
}
