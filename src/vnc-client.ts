/**
 * VNC Client — connects to a VNC server and provides
 * screen capture + mouse/keyboard input methods.
 */

import { EventEmitter } from 'events';
import sharp from 'sharp';
import type { ClawdConfig, ScreenFrame, MouseAction, KeyboardAction } from './types';

// RFB key code mappings
const KEY_MAP: Record<string, number> = {
  'Return': 0xff0d,
  'Enter': 0xff0d,
  'Tab': 0xff09,
  'Escape': 0xff1b,
  'Backspace': 0xff08,
  'Delete': 0xffff,
  'Home': 0xff50,
  'End': 0xff57,
  'PageUp': 0xff55,
  'PageDown': 0xff56,
  'Left': 0xff51,
  'Up': 0xff52,
  'Right': 0xff53,
  'Down': 0xff54,
  'F1': 0xffbe, 'F2': 0xffbf, 'F3': 0xffc0, 'F4': 0xffc1,
  'F5': 0xffc2, 'F6': 0xffc3, 'F7': 0xffc4, 'F8': 0xffc5,
  'F9': 0xffc6, 'F10': 0xffc7, 'F11': 0xffc8, 'F12': 0xffc9,
  'Shift': 0xffe1,
  'Control': 0xffe3,
  'ctrl': 0xffe3,
  'Alt': 0xffe9,
  'alt': 0xffe9,
  'Meta': 0xffeb,
  'Super': 0xffeb,
  'Win': 0xffeb,
  'Windows': 0xffeb,
};

export class VNCClient extends EventEmitter {
  private client: any = null;
  private config: ClawdConfig;
  private screenWidth = 0;
  private screenHeight = 0;
  private connected = false;
  private fullFrameBuffer: Buffer | null = null;

  constructor(config: ClawdConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const rfb2 = require('rfb2');
      this.client = rfb2.createConnection({
        host: this.config.vnc.host,
        port: this.config.vnc.port,
        password: this.config.vnc.password,
      });

      this.client.on('connect', () => {
        console.log(`🐾 VNC connected to ${this.config.vnc.host}:${this.config.vnc.port}`);
        this.connected = true;
        this.screenWidth = this.client.width;
        this.screenHeight = this.client.height;
        console.log(`   Screen: ${this.screenWidth}x${this.screenHeight}`);
        
        // Initialize full frame buffer
        this.fullFrameBuffer = Buffer.alloc(this.screenWidth * this.screenHeight * 4, 0);
        resolve();
      });

      this.client.on('error', (err: Error) => {
        console.error('VNC error:', err?.message);
        this.connected = false;
        reject(err);
      });

      this.client.on('end', () => {
        console.log('VNC disconnected');
        this.connected = false;
        this.emit('disconnected');
      });

      // Continuously update the frame buffer
      this.client.on('rect', (rect: any) => {
        if (this.fullFrameBuffer && rect.data) {
          for (let y = 0; y < rect.height; y++) {
            const srcOffset = y * rect.width * 4;
            const dstOffset = ((rect.y + y) * this.screenWidth + rect.x) * 4;
            if (srcOffset + rect.width * 4 <= rect.data.length &&
                dstOffset + rect.width * 4 <= this.fullFrameBuffer!.length) {
              rect.data.copy(this.fullFrameBuffer!, dstOffset, srcOffset, srcOffset + rect.width * 4);
            }
          }
        }
      });
    });
  }

  /**
   * Capture a screenshot. Requests a full frame update and waits for it.
   */
  async captureScreen(): Promise<ScreenFrame> {
    if (!this.connected || !this.client) {
      throw new Error('Not connected to VNC server');
    }

    // Request full screen update (non-incremental)
    this.client.requestUpdate(false, 0, 0, this.screenWidth, this.screenHeight);

    // Wait for rects to arrive
    await this.delay(800);

    // Process the frame buffer into an image
    const processed = await this.processFrame();

    return {
      width: this.screenWidth,
      height: this.screenHeight,
      buffer: processed,
      timestamp: Date.now(),
      format: this.config.capture.format,
    };
  }

  private async processFrame(): Promise<Buffer> {
    if (!this.fullFrameBuffer) {
      return Buffer.alloc(0);
    }

    const { format, quality } = this.config.capture;

    // VNC sends BGRA — swap to RGBA for correct colors
    const rgbaBuffer = Buffer.from(this.fullFrameBuffer);
    for (let i = 0; i < rgbaBuffer.length; i += 4) {
      const b = rgbaBuffer[i];
      rgbaBuffer[i] = rgbaBuffer[i + 2];     // R <- B
      rgbaBuffer[i + 2] = b;                  // B <- R
    }

    const pipeline = sharp(rgbaBuffer, {
      raw: {
        width: this.screenWidth,
        height: this.screenHeight,
        channels: 4,
      },
    });

    if (format === 'jpeg') {
      return pipeline.jpeg({ quality }).toBuffer();
    }
    return pipeline.png().toBuffer();
  }

  // --- Input Methods ---

  async mouseClick(x: number, y: number, button = 1): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    console.log(`   🖱️  Click at (${x}, ${y})`);
    this.client.pointerEvent(x, y, 0);
    await this.delay(50);
    this.client.pointerEvent(x, y, button);
    await this.delay(80);
    this.client.pointerEvent(x, y, 0);
  }

  async mouseDoubleClick(x: number, y: number): Promise<void> {
    console.log(`   🖱️  Double-click at (${x}, ${y})`);
    await this.mouseClick(x, y);
    await this.delay(100);
    await this.mouseClick(x, y);
  }

  async mouseRightClick(x: number, y: number): Promise<void> {
    console.log(`   🖱️  Right-click at (${x}, ${y})`);
    await this.mouseClick(x, y, 4);
  }

  async mouseMove(x: number, y: number): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    this.client.pointerEvent(x, y, 0);
  }

  async mouseScroll(x: number, y: number, delta: number): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    console.log(`   🖱️  Scroll at (${x}, ${y}) delta=${delta}`);
    const button = delta > 0 ? 8 : 16;
    const steps = Math.abs(Math.round(delta));
    for (let i = 0; i < steps; i++) {
      this.client.pointerEvent(x, y, button);
      await this.delay(30);
      this.client.pointerEvent(x, y, 0);
      await this.delay(30);
    }
  }

  async typeText(text: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    console.log(`   ⌨️  Typing: "${text}"`);
    for (const char of text) {
      const code = char.charCodeAt(0);
      this.client.keyEvent(code, true);
      await this.delay(30);
      this.client.keyEvent(code, false);
      await this.delay(30);
    }
  }

  async keyPress(keyCombo: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    console.log(`   ⌨️  Key press: ${keyCombo}`);

    const parts = keyCombo.split('+').map(k => k.trim());
    const keyCodes = parts.map(k => KEY_MAP[k] || k.charCodeAt(0));

    // Press all keys down
    for (const code of keyCodes) {
      this.client.keyEvent(code, true);
      await this.delay(30);
    }

    // Release all keys (reverse order)
    for (const code of [...keyCodes].reverse()) {
      this.client.keyEvent(code, false);
      await this.delay(30);
    }
  }

  async executeMouseAction(action: MouseAction): Promise<void> {
    switch (action.kind) {
      case 'click':
        await this.mouseClick(action.x, action.y);
        break;
      case 'double_click':
        await this.mouseDoubleClick(action.x, action.y);
        break;
      case 'right_click':
        await this.mouseRightClick(action.x, action.y);
        break;
      case 'move':
        await this.mouseMove(action.x, action.y);
        break;
      case 'scroll':
        await this.mouseScroll(action.x, action.y, action.scrollDelta || 3);
        break;
      case 'drag':
        await this.mouseMove(action.x, action.y);
        if (!this.client) throw new Error('Not connected');
        this.client.pointerEvent(action.x, action.y, 1);
        await this.delay(100);
        this.client.pointerEvent(action.endX || action.x, action.endY || action.y, 1);
        await this.delay(50);
        this.client.pointerEvent(action.endX || action.x, action.endY || action.y, 0);
        break;
    }
  }

  async executeKeyboardAction(action: KeyboardAction): Promise<void> {
    switch (action.kind) {
      case 'type':
        if (action.text) await this.typeText(action.text);
        break;
      case 'key_press':
        if (action.key) await this.keyPress(action.key);
        break;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getScreenSize(): { width: number; height: number } {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  disconnect(): void {
    if (this.client) {
      this.client.end();
      this.connected = false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
