/**
 * Accessibility Bridge — calls PowerShell scripts to query
 * the Windows UI Automation tree. No vision needed for most actions.
 * 
 * Flow: Node.js → spawn powershell → .NET UI Automation → JSON back
 */

import { execFile } from 'child_process';
import * as path from 'path';

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const PS_TIMEOUT = 10000; // 10s timeout for PowerShell calls

export interface UIElement {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  bounds: { x: number; y: number; width: number; height: number };
  children?: UIElement[];
}

export interface WindowInfo {
  handle: number;
  title: string;
  processName: string;
  processId: number;
  bounds: { x: number; y: number; width: number; height: number };
  isMinimized: boolean;
}

export class AccessibilityBridge {
  /**
   * List all visible top-level windows
   */
  async getWindows(): Promise<WindowInfo[]> {
    return this.runScript('get-windows.ps1');
  }

  /**
   * Get UI tree for a window (or all top-level if no processId)
   */
  async getUITree(processId?: number, maxDepth = 3): Promise<UIElement[]> {
    const args: string[] = [];
    if (processId) args.push('-ProcessId', String(processId));
    args.push('-MaxDepth', String(maxDepth));
    return this.runScript('get-ui-tree.ps1', args);
  }

  /**
   * Find elements matching criteria
   */
  async findElement(opts: {
    name?: string;
    automationId?: string;
    controlType?: string;
    processId?: number;
  }): Promise<UIElement[]> {
    const args: string[] = [];
    if (opts.name) args.push('-Name', opts.name);
    if (opts.automationId) args.push('-AutomationId', opts.automationId);
    if (opts.controlType) args.push('-ControlType', opts.controlType);
    if (opts.processId) args.push('-ProcessId', String(opts.processId));
    return this.runScript('find-element.ps1', args);
  }

  /**
   * Invoke an action on an element (click, set value, etc.)
   */
  async invokeElement(opts: {
    name?: string;
    automationId?: string;
    controlType?: string;
    action: 'click' | 'set-value' | 'get-value' | 'focus' | 'expand' | 'collapse';
    value?: string;
  }): Promise<{ success: boolean; value?: string; error?: string }> {
    const args: string[] = ['-Action', opts.action];
    if (opts.name) args.push('-Name', opts.name);
    if (opts.automationId) args.push('-AutomationId', opts.automationId);
    if (opts.controlType) args.push('-ControlType', opts.controlType);
    if (opts.value) args.push('-Value', opts.value);
    return this.runScript('invoke-element.ps1', args);
  }

  /**
   * Get a text summary of the UI tree for the AI.
   * Returns a compact, readable representation of what's on screen.
   */
  async getScreenContext(processId?: number): Promise<string> {
    try {
      const windows = await this.getWindows();
      let context = `Open windows:\n`;
      for (const w of windows) {
        context += `  - [${w.processName}] "${w.title}" (pid:${w.processId}${w.isMinimized ? ', minimized' : ''})\n`;
      }

      if (processId) {
        const tree = await this.getUITree(processId, 2);
        context += `\nUI elements for pid ${processId}:\n`;
        context += this.formatTree(tree, '  ');
      }

      return context;
    } catch (err) {
      return `(Accessibility unavailable: ${err})`;
    }
  }

  private formatTree(elements: UIElement[], indent: string): string {
    let result = '';
    for (const el of elements) {
      const name = el.name ? `"${el.name}"` : '';
      const id = el.automationId ? `id:${el.automationId}` : '';
      const bounds = `@${el.bounds.x},${el.bounds.y}`;
      result += `${indent}[${el.controlType}] ${name} ${id} ${bounds}\n`;
      if (el.children) {
        result += this.formatTree(el.children, indent + '  ');
      }
    }
    return result;
  }

  private runScript(scriptName: string, args: string[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(SCRIPTS_DIR, scriptName);
      
      execFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        ...args,
      ], {
        timeout: PS_TIMEOUT,
        maxBuffer: 1024 * 1024 * 5, // 5MB buffer
      }, (error, stdout, stderr) => {
        if (error) {
          console.error(`Accessibility script error (${scriptName}):`, error.message);
          reject(error);
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          if (result.error) {
            reject(new Error(result.error));
          } else {
            resolve(result);
          }
        } catch (parseErr) {
          console.error(`Failed to parse ${scriptName} output:`, stdout.substring(0, 200));
          reject(parseErr);
        }
      });
    });
  }
}
