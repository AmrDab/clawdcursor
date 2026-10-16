/**
 * Browser detection by process name. macOS reports the app's display name
 * ("Google Chrome", "Microsoft Edge"), which the exact-match list missed — so
 * on a Mac nothing treated Chrome as a browser (#234 / #235).
 */
import { describe, it, expect } from 'vitest';
import { isBrowserProcess } from '../llm/browser-config';

describe('isBrowserProcess', () => {
  it.each(['chrome', 'msedge', 'chrome.exe', 'Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Firefox', 'Safari', 'Arc'])(
    '%j is a browser', (name) => expect(isBrowserProcess(name)).toBe(true),
  );
  it.each(['', 'Finder', 'Code', 'Microsoft Excel', 'notepad', 'Terminal', 'Slack'])(
    '%j is not', (name) => expect(isBrowserProcess(name)).toBe(false),
  );
});
