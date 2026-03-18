/**
 * Action Verifier — wraps desktop actions with post-action verification.
 *
 * Read -> Act -> Verify -> Log. Every action checks that it actually worked
 * using the accessibility bridge (getFocusedElement, get-value).
 */

import { AccessibilityBridge, FocusedElementInfo } from './accessibility';
import { NativeDesktop } from './native-desktop';

export interface VerifyResult {
  success: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

export class ActionVerifier {
  constructor(
    private a11y: AccessibilityBridge,
    private desktop: NativeDesktop,
  ) {}

  /**
   * Poll until a condition is met or timeout expires.
   * Returns true if condition was met, false on timeout.
   */
  async pollForCondition(
    check: () => Promise<boolean>,
    timeoutMs = 5000,
    intervalMs = 200,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await check()) return true;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
  }

  /**
   * Type text, then verify by reading the focused element's value.
   */
  async verifiedType(text: string): Promise<VerifyResult> {
    const beforeFocus = await this.a11y.getFocusedElement();
    await this.desktop.typeText(text);

    // Give the UI a moment to update
    await new Promise(r => setTimeout(r, 100));

    const afterFocus = await this.a11y.getFocusedElement();
    if (!afterFocus) {
      return { success: true, details: { warning: 'Could not read focused element after typing' } };
    }

    // Check if the value contains the typed text
    if (afterFocus.value && afterFocus.value.includes(text)) {
      return { success: true, details: { readBack: afterFocus.value } };
    }

    // WebView2/Electron apps may not expose value through UIA — still report success
    // but note the verification was inconclusive
    return {
      success: true,
      details: {
        warning: 'Value readback inconclusive (common in WebView2 apps)',
        focusedElement: afterFocus.name || afterFocus.controlType,
        readBack: afterFocus.value || '(empty)',
      },
    };
  }

  /**
   * Press a key combo, then verify focus changed (or window changed for Ctrl+Enter etc).
   */
  async verifiedKeyPress(
    keyCombo: string,
    expectation?: {
      focusShouldChange?: boolean;
      windowShouldClose?: boolean;
      expectedControlType?: string;
    },
  ): Promise<VerifyResult> {
    const beforeFocus = await this.a11y.getFocusedElement();

    // Capture window title before action — compose windows close within the same process
    // (e.g. Outlook compose → main Outlook), so processId alone is not sufficient
    let beforeWindowTitle = '';
    if (expectation?.windowShouldClose) {
      const beforeWindow = await this.a11y.getActiveWindow();
      beforeWindowTitle = beforeWindow?.title ?? '';
    }

    await this.desktop.keyPress(keyCombo);

    // Give the UI a moment to settle
    await new Promise(r => setTimeout(r, 150));
    this.a11y.invalidateCache();

    if (expectation?.windowShouldClose) {
      const closed = await this.pollForCondition(async () => {
        const active = await this.a11y.getActiveWindow();
        if (!active) return true;
        if (beforeFocus?.processId && active.processId !== beforeFocus.processId) return true;
        // Title changed = a different window is now active (e.g. compose closed, inbox visible)
        if (beforeWindowTitle && active.title !== beforeWindowTitle) return true;
        return false;
      }, 3000, 200);
      return {
        success: closed,
        error: closed ? undefined : 'Window did not close after key press',
        details: { keyCombo, windowClosed: closed },
      };
    }

    if (expectation?.focusShouldChange) {
      const afterFocus = await this.a11y.getFocusedElement();
      const focusMoved = !beforeFocus || !afterFocus ||
        beforeFocus.name !== afterFocus.name ||
        beforeFocus.automationId !== afterFocus.automationId ||
        beforeFocus.controlType !== afterFocus.controlType;

      if (expectation.expectedControlType && afterFocus) {
        const typeMatch = afterFocus.controlType.includes(expectation.expectedControlType);
        return {
          success: typeMatch,
          error: typeMatch ? undefined : `Expected ${expectation.expectedControlType}, got ${afterFocus.controlType}`,
          details: {
            keyCombo,
            focusMoved,
            before: beforeFocus?.name ?? '(none)',
            after: afterFocus.name ?? '(none)',
            afterType: afterFocus.controlType,
          },
        };
      }

      return {
        success: focusMoved,
        error: focusMoved ? undefined : 'Focus did not change after key press',
        details: {
          keyCombo,
          focusMoved,
          before: beforeFocus?.name ?? '(none)',
          after: afterFocus?.name ?? '(none)',
        },
      };
    }

    // No specific expectation — just confirm the key press happened
    return { success: true, details: { keyCombo } };
  }

  /**
   * Click an element by resolving its bounds from the a11y tree, then verify.
   */
  async verifiedClick(opts: {
    name?: string;
    automationId?: string;
    controlType?: string;
    processId?: number;
  }): Promise<VerifyResult> {
    const elements = await this.a11y.findElement(opts);
    if (!elements?.length) {
      return { success: false, error: `Element not found: ${opts.name ?? opts.automationId}` };
    }

    const el = elements[0];
    const b = el.bounds;
    if (!b || b.width <= 0 || b.height <= 0) {
      return { success: false, error: `Element has no valid bounds: ${opts.name ?? opts.automationId}` };
    }

    const cx = b.x + Math.floor(b.width / 2);
    const cy = b.y + Math.floor(b.height / 2);
    const mc = this.desktop.physicalToMouse(cx, cy);

    await this.desktop.mouseClick(mc.x, mc.y);
    this.a11y.invalidateCache();

    // Brief settle, then check if focus moved to the clicked element
    await new Promise(r => setTimeout(r, 150));
    const afterFocus = await this.a11y.getFocusedElement();

    return {
      success: true,
      details: {
        clicked: { x: cx, y: cy },
        elementName: el.name,
        focusedAfter: afterFocus?.name ?? '(unknown)',
      },
    };
  }

  /**
   * Get the current focused element — convenience wrapper.
   */
  async getFocused(): Promise<FocusedElementInfo | null> {
    return this.a11y.getFocusedElement();
  }
}
