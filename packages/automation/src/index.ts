/**
 * @clawd-cursor/automation
 * 
 * Windows UI Automation engine — the primary way Clawd Cursor
 * interacts with the desktop. Uses Windows Accessibility APIs
 * to enumerate and control UI elements without screenshots.
 * 
 * TODO:
 * - [ ] Windows UI Automation COM bindings via ffi-napi
 * - [ ] Window enumeration (EnumWindows)
 * - [ ] Accessibility tree walking (IUIAutomation)
 * - [ ] Element interaction (click, type, focus)
 * - [ ] Keyboard simulation (SendInput)
 * - [ ] Mouse simulation (SetCursorPos + SendInput)
 * - [ ] App launcher integration
 */

export { UIElement, WindowInfo, Rect } from '@clawd-cursor/shared';

export interface AutomationEngine {
  /** List all visible windows */
  getWindows(): Promise<import('@clawd-cursor/shared').WindowInfo[]>;
  
  /** Get accessibility tree for a window */
  getUITree(windowHandle: number, depth?: number): Promise<import('@clawd-cursor/shared').UIElement>;
  
  /** Find elements matching criteria */
  findElements(query: {
    role?: string;
    name?: string;
    automationId?: string;
    windowHandle?: number;
  }): Promise<import('@clawd-cursor/shared').UIElement[]>;
  
  /** Click an element */
  click(element: import('@clawd-cursor/shared').UIElement): Promise<void>;
  
  /** Type text into focused element */
  type(text: string): Promise<void>;
  
  /** Press key combination */
  keyPress(keys: string): Promise<void>;
  
  /** Scroll at position */
  scroll(x: number, y: number, delta: number): Promise<void>;
  
  /** Move cursor to position */
  moveCursor(x: number, y: number): Promise<void>;
  
  /** Focus a window */
  focusWindow(handle: number): Promise<void>;
  
  /** Launch an application */
  launchApp(appName: string): Promise<void>;
}
