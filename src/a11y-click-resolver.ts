/**
 * A11y Click Resolver — resolves element names to screen coordinates
 * using the accessibility tree's bounding rectangles.
 *
 * Zero LLM cost. Zero vision model calls. Just math.
 */

import { AccessibilityBridge } from './accessibility';

export class A11yClickResolver {
  constructor(private a11y: AccessibilityBridge) {}

  /**
   * Resolve an element to its center coordinates using the a11y tree.
   * Returns null if the element isn't found or has no valid bounds.
   */
  async resolve(
    name: string,
    controlType?: string,
    processId?: number,
  ): Promise<{ x: number; y: number } | null> {
    const elements = await this.a11y.findElement({
      name,
      ...(controlType && { controlType }),
      ...(processId && { processId }),
    });
    if (!elements?.length) return null;

    const b = elements[0].bounds;
    if (!this.isValidBounds(b)) return null;

    return {
      x: b.x + Math.floor(b.width / 2),
      y: b.y + Math.floor(b.height / 2),
    };
  }

  /**
   * Resolve by automationId instead of name.
   */
  async resolveById(
    automationId: string,
    processId?: number,
  ): Promise<{ x: number; y: number } | null> {
    const elements = await this.a11y.findElement({
      automationId,
      ...(processId && { processId }),
    });
    if (!elements?.length) return null;

    const b = elements[0].bounds;
    if (!this.isValidBounds(b)) return null;

    return {
      x: b.x + Math.floor(b.width / 2),
      y: b.y + Math.floor(b.height / 2),
    };
  }

  private isValidBounds(b: { x: number; y: number; width: number; height: number } | undefined): boolean {
    if (!b || b.width <= 0 || b.height <= 0) return false;
    // Reject off-screen or absurd coordinates (e.g. y: -29503)
    if (b.x < -100 || b.y < -100 || b.x > 10000 || b.y > 10000) return false;
    return true;
  }
}
