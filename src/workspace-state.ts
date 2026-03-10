/**
 * WorkspaceState — tracks the desktop workspace across task steps.
 * Maintains windows, browser tabs, clipboard, and task artifacts.
 * Updated after every action to enable cross-app orchestration and progress detection.
 */

export interface TrackedWindow {
  processName: string;
  title: string;
  processId: number;
  isMinimized: boolean;
  lastSeenAt: number;
  url?: string;       // for browser windows
  tabId?: string;     // for browser tabs
}

export interface ClipboardSnapshot {
  text: string;
  changedAt: number;
  source?: string;    // which app/action produced it
}

export class WorkspaceState {
  activeWindowId?: number;          // PID of active window
  windows: Map<number, TrackedWindow> = new Map();
  clipboard: ClipboardSnapshot = { text: '', changedAt: 0 };
  lastStateHash: string = '';       // for no-progress detection
  stateHistory: string[] = [];      // rolling window of last 10 state hashes

  /**
   * Update window list from accessibility bridge data
   */
  updateWindows(windowList: Array<{ processName: string; title: string; processId: number; isMinimized: boolean }>): void {
    const now = Date.now();
    for (const w of windowList) {
      this.windows.set(w.processId, {
        ...w,
        lastSeenAt: now,
        url: this.windows.get(w.processId)?.url,
        tabId: this.windows.get(w.processId)?.tabId,
      });
    }
    // Prune windows not seen in 60s
    for (const [pid, w] of this.windows) {
      if (now - w.lastSeenAt > 60000) this.windows.delete(pid);
    }
  }

  /**
   * Set the active window
   */
  setActiveWindow(pid: number): void {
    this.activeWindowId = pid;
  }

  /**
   * Update browser tab info for a window
   */
  updateBrowserTab(pid: number, url: string, tabId?: string): void {
    const w = this.windows.get(pid);
    if (w) {
      w.url = url;
      w.tabId = tabId;
    }
  }

  /**
   * Update clipboard state
   */
  updateClipboard(text: string, source?: string): void {
    if (text !== this.clipboard.text) {
      this.clipboard = { text, changedAt: Date.now(), source };
    }
  }

  /**
   * Find a window by process name (fuzzy match)
   */
  findWindow(processName: string): TrackedWindow | undefined {
    const lower = processName.toLowerCase();
    for (const w of this.windows.values()) {
      if (w.processName.toLowerCase().includes(lower) && !w.isMinimized) {
        return w;
      }
    }
    return undefined;
  }

  /**
   * Find a browser window with a specific URL
   */
  findBrowserTab(urlSubstring: string): TrackedWindow | undefined {
    const lower = urlSubstring.toLowerCase();
    for (const w of this.windows.values()) {
      if (w.url && w.url.toLowerCase().includes(lower)) {
        return w;
      }
    }
    return undefined;
  }

  /**
   * Compute a state hash for no-progress detection.
   * Compares: active window title + URL + clipboard length
   */
  computeStateHash(): string {
    const activeWin = this.activeWindowId ? this.windows.get(this.activeWindowId) : undefined;
    const hash = [
      activeWin?.processName || '?',
      activeWin?.title?.substring(0, 50) || '?',
      activeWin?.url?.substring(0, 80) || '',
      this.clipboard.text.length.toString(),
    ].join('|');
    return hash;
  }

  /**
   * Check if state has changed since last snapshot.
   * Call after each action to detect stalls.
   * Returns true if state changed, false if stuck.
   */
  checkProgress(): boolean {
    const current = this.computeStateHash();
    const changed = current !== this.lastStateHash;
    this.lastStateHash = current;
    this.stateHistory.push(current);
    if (this.stateHistory.length > 10) this.stateHistory.shift();
    return changed;
  }

  /**
   * Count how many consecutive steps had the same state.
   * Useful for detecting deep stalls (e.g., clicking same button 10 times).
   */
  getStallCount(): number {
    if (this.stateHistory.length < 2) return 0;
    const current = this.stateHistory[this.stateHistory.length - 1];
    let count = 0;
    for (let i = this.stateHistory.length - 2; i >= 0; i--) {
      if (this.stateHistory[i] === current) count++;
      else break;
    }
    return count;
  }

  /**
   * Get a summary string for logging/LLM context
   */
  getSummary(): string {
    const activeWin = this.activeWindowId ? this.windows.get(this.activeWindowId) : undefined;
    const windowCount = this.windows.size;
    const clip = this.clipboard.text ? `${this.clipboard.text.length} chars` : 'empty';
    return `Active: ${activeWin?.processName || 'none'} "${activeWin?.title?.substring(0, 40) || ''}" | Windows: ${windowCount} | Clipboard: ${clip}`;
  }

  /**
   * Reset for a new task
   */
  reset(): void {
    this.lastStateHash = '';
    this.stateHistory = [];
    // Keep windows and clipboard — they persist across tasks
  }
}
