/**
 * @clawd-cursor/vision
 * 
 * Vision fallback module — used only when automation APIs
 * can't identify UI elements. Takes screenshots and sends
 * to a vision model for element location.
 * 
 * TODO:
 * - [ ] Screen capture (Windows GDI / Desktop Duplication API)
 * - [ ] Region capture (specific window or area)
 * - [ ] Vision model integration (Claude, GPT-4o, local)
 * - [ ] Coordinate extraction from vision response
 * - [ ] OCR fallback for text reading
 * - [ ] Caching (don't re-screenshot if nothing changed)
 */

export interface VisionEngine {
  /** Capture full screen */
  captureScreen(): Promise<Buffer>;
  
  /** Capture specific window */
  captureWindow(handle: number): Promise<Buffer>;
  
  /** Capture region */
  captureRegion(x: number, y: number, w: number, h: number): Promise<Buffer>;
  
  /** Ask vision model to locate an element */
  locateElement(screenshot: Buffer, description: string): Promise<{
    x: number;
    y: number;
    confidence: number;
  }>;
  
  /** Read text from screen region */
  readText(screenshot: Buffer, region?: { x: number; y: number; w: number; h: number }): Promise<string>;
}
